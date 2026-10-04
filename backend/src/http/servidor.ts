import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { CONFIG } from '../config.ts';
import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, nombreMotor, type Fila } from '../db/index.ts';
import { sembrar, FERIA_ID } from '../db/semilla.ts';
import {
  crearPedido, aceptarOferta, rechazarOferta, liberarSubPedido, marcarListo, tick,
  cotizar, confirmarPago, OfertaNoDisponible, PedidoMuyChico,
} from '../dominio/despacho.ts';
import {
  aceptarViaje, completarParada, registrarUbicacion, ViajeNoDisponible,
} from '../dominio/reparto.ts';
import {
  ofertasAbiertas, trabajoDelFeriante, viajesDisponibles, viajeActivo,
  pedidoCompleto, colaAutogestion, metricas,
} from '../dominio/consultas.ts';
import {
  calcularLiquidacion, liquidacionesDelDia, marcarPagado, confirmarRecepcion, hoy,
} from '../dominio/liquidaciones.ts';
import { TransicionInvalida } from '../dominio/estados.ts';
import { bus } from '../realtime/bus.ts';
import { leRegistra } from '../realtime/filtro.ts';
import {
  pedirCodigo, crearSesion, verificarToken, cerrarSesion, cerrarTodas, sesionesDe,
  codigoParaAlguien, ErrorAuth, type Identidad,
} from '../dominio/auth.ts';
import { firmaValida, traducirPedido } from '../shopify/webhook.ts';
import { proveedorSms } from '../sms.ts';
import { iniciarNotificaciones } from '../realtime/push.ts';
import {
  iniciarPago, confirmarDesdePasarela, confirmarEnDesarrollo, pagosDe,
  revisarCobrosAbiertos, revisarCobro, pasarela, pasarelaConfigurada, ErrorPago,
} from '../dominio/pagos.ts';
import { pagoAvisado } from '../pagos/mercadopago.ts';
import {
  catalogoCompleto, actualizarProducto, crearProducto, historialDe, ErrorCatalogo,
} from '../dominio/catalogo.ts';
import {
  cancelarPedido, reembolsosPendientes, ErrorCancelacion,
} from '../dominio/cancelacion.ts';
import { estadoFeria, horarioActual, FeriaCerrada } from '../dominio/horario.ts';
import {
  guardarFoto, leerFoto, desdeBase64, MAX_FOTO, ErrorArchivo,
} from '../dominio/archivos.ts';
import { leerReferencia, creditos } from '../dominio/referencia.ts';
import { deQuien, pasar, limpiar as limpiarFrenos, LIMITE_POR_MINUTO } from './freno.ts';

// ============================================================
// Router mínimo
// ============================================================

type Ctx = {
  params: Record<string, string>;
  /** Lo que viene en el `?`: el panel filtra por día y por estado. */
  consulta: URLSearchParams;
  cuerpo: any;
  req: IncomingMessage;
  crudo: Buffer;
  /** Se resuelve una sola vez por petición aunque se pida dos veces. */
  identidad?: Identidad;
};
type Handler = (c: Ctx) => Promise<unknown>;

type Ruta = { metodo: string; partes: string[]; handler: Handler; maxCuerpo?: number };
const rutas: Array<Ruta> = [];
const ruta = (metodo: string, patron: string, handler: Handler, maxCuerpo?: number) =>
  rutas.push({ metodo, partes: patron.split('/').filter(Boolean), handler, maxCuerpo });

const GET = (p: string, h: Handler) => ruta('GET', p, h);
/** `maxCuerpo` solo para lo que de verdad lo necesita: subir una foto. */
const POST = (p: string, h: Handler, maxCuerpo?: number) => ruta('POST', p, h, maxCuerpo);

function resolver(metodo: string, camino: string) {
  const partes = camino.split('/').filter(Boolean);
  for (const r of rutas) {
    if (r.metodo !== metodo || r.partes.length !== partes.length) continue;
    const params: Record<string, string> = {};
    let calza = true;
    for (let i = 0; i < r.partes.length; i++) {
      const patron = r.partes[i];
      if (patron.startsWith(':')) params[patron.slice(1)] = decodeURIComponent(partes[i]);
      else if (patron !== partes[i]) { calza = false; break; }
    }
    if (calza) return { handler: r.handler, params, maxCuerpo: r.maxCuerpo };
  }
  return null;
}

/**
 * Una respuesta que no es JSON: una foto, el panel.
 *
 * Todo lo demás del servidor habla JSON, así que en vez de darle a
 * cada handler acceso al `ServerResponse` —y con eso la posibilidad
 * de dejar una respuesta a medio escribir— devuelven esto y el
 * servidor se encarga.
 */
class RespuestaCruda {
  // Node ejecuta el TypeScript borrando los tipos, nada más: las
  // propiedades declaradas en el constructor no existen para él.
  datos: Buffer | string;
  tipo: string;
  cache?: string;
  constructor(datos: Buffer | string, tipo: string, cache?: string) {
    this.datos = datos;
    this.tipo = tipo;
    this.cache = cache;
  }
}

class ErrorHttp extends Error {
  codigo: number;
  constructor(codigo: number, msg: string) {
    super(msg);
    this.codigo = codigo;
  }
}

/**
 * Cada petición trae su propia sesión: `Authorization: Bearer <token>`.
 *
 * El token identifica a una persona concreta, no a un rol. Antes
 * había un token compartido y un header con el id del actor, lo que
 * dejaba que cualquiera con el token aceptara pedidos, los marcara
 * listos y confirmara pagos haciéndose pasar por cualquier feriante.
 */
async function identidad(c: Ctx): Promise<Identidad> {
  if (c.identidad) return c.identidad;
  const cabecera = String(c.req.headers.authorization ?? '');
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : undefined;
  c.identidad = await verificarToken(token);
  return c.identidad;
}

/** Exige un rol concreto y devuelve el id de quien hizo la petición. */
async function actor(c: Ctx, esperado: string): Promise<string> {
  const yo = await identidad(c);
  if (yo.rol !== esperado) {
    throw new ErrorHttp(403, `Esta acción es solo para ${esperado}es.`);
  }
  return yo.actorId;
}

/** `?dia=YYYY-MM-DD`, o hoy. Una fecha inventada no llega a la base. */
function diaPedido(c: Ctx): string {
  const dia = c.consulta.get('dia');
  if (!dia) return hoy();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new ErrorHttp(422, 'Fecha inválida.');
  return dia;
}

// ============================================================
// Sesión
// ============================================================

/** Paso 1: el teléfono recibe un código de 6 dígitos. */
POST('/auth/codigo', (c) => pedirCodigo(c.cuerpo?.telefono));

/** Paso 2: el código se canjea por una sesión larga. */
POST('/auth/sesion', async (c) => {
  const s = await crearSesion(c.cuerpo?.telefono, c.cuerpo?.codigo, c.cuerpo?.dispositivo);
  return {
    token: s.token, rol: s.rol, actorId: s.actorId, nombre: s.nombre, expiraAt: s.expiraAt,
  };
});

GET('/auth/yo', async (c) => {
  const yo = await identidad(c);
  const tabla = yo.rol === 'feriante' ? 'feriantes'
    : yo.rol === 'repartidor' ? 'repartidores' : 'operadores';
  return {
    ...yo,
    perfil: await consultarUno(`SELECT * FROM ${tabla} WHERE id = ?`, yo.actorId),
    sesiones: await sesionesDe(yo.actorId),
  };
});

POST('/auth/salir', async (c) => {
  const yo = await identidad(c);
  await cerrarSesion(yo.sesionId);
  return { ok: true };
});

/** Perdió el teléfono: se cierran todas sus sesiones de una. */
POST('/auth/salir-de-todos', async (c) => {
  const yo = await identidad(c);
  return { cerradas: await cerrarTodas(yo.actorId) };
});

// ============================================================
// Catálogo y pedidos
// ============================================================

GET('/salud', async () => ({
  ok: true,
  motor: nombreMotor(),
  sms: proveedorSms(),
  // Decía 'flow' escrito a mano, de antes de que hubiera dos
  // pasarelas. Mentía sobre cuál está cobrando de verdad.
  pagos: pasarela()?.nombre ?? 'sin configurar',
  ts: new Date().toISOString(),
}));

/** Si la feria está tomando pedidos ahora mismo. */
GET('/feria/estado', async () => ({
  ...estadoFeria(),
  horario: horarioActual(),
  // Sacarle el botón de cancelar al cliente sin darle a dónde
  // llamar lo deja atrapado. El teléfono es la salida.
  contacto: CONFIG.telefonoContacto,
}));

GET('/catalogo', async () => {
  const rubros = await consultar<Fila>('SELECT * FROM rubros ORDER BY nombre');
  return Promise.all(rubros.map(async (r) => ({
    ...r,
    productos: await consultar(
      'SELECT * FROM productos WHERE rubro_id = ? AND activo ORDER BY nombre', r.id),
  })));
});

/**
 * Alta directa de pedido.
 *
 * En producción los pedidos entran por el webhook de Shopify, ya
 * pagados; esta ruta es para el panel del operador. Abierta en
 * desarrollo para poder probar desde la app sin pasar por la
 * pasarela.
 */
POST('/pedidos', async (c) => {
  if (process.env.NODE_ENV === 'production') await actor(c, 'operador');
  return crearPedido({ feriaId: FERIA_ID, ...c.cuerpo });
});

/** Lo que necesita el carro para mostrar el total antes de cobrar. */
GET('/cotizar/:total', async (c) => cotizar(Number(c.params.total) || 0));

GET('/pedidos/:id', async (c) => {
  const p = await pedidoCompleto(c.params.id) ?? await pedidoPorNumero(c.params.id);
  if (!p) throw new ErrorHttp(404, 'Pedido no encontrado.');
  return p;
});

async function pedidoPorNumero(valor: string) {
  const n = Number(valor);
  if (!Number.isInteger(n)) return null;
  const fila = await consultarUno<Fila>('SELECT id FROM pedidos WHERE numero = ?', n);
  return fila ? pedidoCompleto(fila.id) : null;
}

// ============================================================
// Pagos
// ============================================================

/** Arranca el cobro y devuelve la URL de la pasarela. */
POST('/pagos/iniciar', async (c) =>
  iniciarPago(String(c.cuerpo?.pedidoId ?? ''), String(c.cuerpo?.email ?? 'sin@correo.cl')));

GET('/pagos/pedido/:id', async (c) => ({ pagos: await pagosDe(c.params.id) }));

/**
 * «¿Ya llegó mi pago?»
 *
 * La app la llama mientras espera, en vez de confiar en que el
 * webhook haya llegado. Pregunta a la pasarela y confirma si
 * corresponde, así el cliente no se queda mirando una pantalla que
 * dice «esperando el pago» con la plata ya descontada.
 */
POST('/pagos/:pagoId/revisar', async (c) => revisarCobro(c.params.pagoId));

/**
 * Flow avisa acá cuando termina un pago.
 *
 * Se responde 200 pase lo que pase: si Flow recibe un error sigue
 * reintentando durante horas. El contenido del aviso no se cree —
 * `confirmarDesdePasarela` le vuelve a preguntar a Flow.
 */
POST('/webhooks/flow/confirmacion', async (c) => {
  try {
    await confirmarDesdePasarela(String(c.cuerpo?.token ?? ''));
  } catch (e) {
    console.error('[flow] confirmación fallida', e);
  }
  return { ok: true };
});

/**
 * Mercado Pago avisa acá.
 *
 * Manda el id en la URL o en el cuerpo según la antigüedad de la
 * integración, y avisa de cosas que no son pagos. `pagoAvisado`
 * normaliza todo eso y devuelve null para lo que no nos toca.
 *
 * Igual que con Flow: se responde 200 siempre —MP reintenta durante
 * días y termina deshabilitando el webhook— y el contenido del
 * aviso no se cree, se vuelve a preguntar.
 */
POST('/webhooks/mercadopago', async (c) => {
  const pago = pagoAvisado(c.consulta, c.cuerpo);
  if (!pago) return { ok: true, ignorado: true };
  try {
    await confirmarDesdePasarela(pago);
  } catch (e) {
    console.error('[mercadopago] confirmación fallida', e);
  }
  return { ok: true };
});

/** Mercado Pago también consulta el webhook con GET al configurarlo. */
GET('/webhooks/mercadopago', async () => ({ ok: true }));

/**
 * Adonde vuelve el cliente después de pagar.
 *
 * Flow trae de vuelta al navegador, no a la app, así que esta página
 * lo devuelve a la app por deep link.
 */
GET('/pagos/retorno', async () => ({ ok: true, volverA: 'feria://pago' }));

/** Confirmación sin pasarela, solo para desarrollo. */
POST('/dev/pagar/:pagoId', async (c) => {
  if (process.env.NODE_ENV === 'production') throw new ErrorHttp(404, 'Ruta no encontrada.');
  return { pagado: await confirmarEnDesarrollo(c.params.pagoId) };
});

// ============================================================
// Webhook de Shopify
// ============================================================

/**
 * Shopify avisa acá cuando un pedido queda pagado. Se responde 200
 * lo antes posible: si el endpoint tarda, Shopify reintenta y
 * llegan pedidos duplicados (por eso además `crearPedido` es
 * idempotente por `shopify_order_id`).
 */
POST('/webhooks/shopify/pedido-pagado', async (c) => {
  const secreto = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secreto) throw new ErrorHttp(500, 'Falta SHOPIFY_WEBHOOK_SECRET.');
  if (!firmaValida(c.crudo, c.req.headers['x-shopify-hmac-sha256'] as string, secreto)) {
    throw new ErrorHttp(401, 'Firma HMAC inválida.');
  }
  // Shopify solo avisa de pedidos ya pagados, así que se confirma
  // en el acto: el cobro ocurrió en su checkout.
  const r = await crearPedido({
    ...await traducirPedido(c.cuerpo, FERIA_ID),
    // El cobro ocurrió en el checkout de Shopify: si acá se rechaza
    // por horario, el cliente pagó y se queda sin pedido.
    yaCobrado: true,
  });
  await confirmarPago(r.pedidoId);
  return r;
});

// ============================================================
// Feriante
// ============================================================

POST('/feriante/conexion', async (c) => {
  const id = await actor(c, 'feriante');
  await ejecutar(
    'UPDATE feriantes SET conectado = ?, push_token = COALESCE(?, push_token) WHERE id = ?',
    !!c.cuerpo?.conectado, c.cuerpo?.pushToken ?? null, id);
  return { ok: true, conectado: !!c.cuerpo?.conectado };
});

GET('/feriante/tablero', async (c) => {
  const id = await actor(c, 'feriante');
  const [feriante, ofertas, trabajo, liquidacion] = await Promise.all([
    consultarUno('SELECT * FROM feriantes WHERE id = ?', id),
    ofertasAbiertas(id),
    trabajoDelFeriante(id),
    calcularLiquidacion(id),
  ]);
  return { feriante, ofertas, trabajo, liquidacion };
});

POST('/subpedidos/:id/aceptar', async (c) => aceptarOferta(c.params.id, await actor(c, 'feriante')));

POST('/subpedidos/:id/rechazar', async (c) => {
  await rechazarOferta(c.params.id, await actor(c, 'feriante'));
  return { ok: true };
});

POST('/subpedidos/:id/liberar', async (c) => {
  await liberarSubPedido(c.params.id, await actor(c, 'feriante'));
  return { ok: true };
});

POST('/subpedidos/:id/listo', async (c) => {
  const id = await actor(c, 'feriante');
  const sub = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', c.params.id);
  if (!sub || sub.feriante_id !== id) throw new ErrorHttp(403, 'Este pedido no es tuyo.');
  await marcarListo(c.params.id);
  return { ok: true };
});

POST('/feriante/liquidacion/confirmar', async (c) =>
  confirmarRecepcion(await actor(c, 'feriante'), c.cuerpo?.fecha));

// ============================================================
// Repartidor
// ============================================================

POST('/repartidor/conexion', async (c) => {
  const id = await actor(c, 'repartidor');
  await ejecutar(
    'UPDATE repartidores SET conectado = ?, push_token = COALESCE(?, push_token) WHERE id = ?',
    !!c.cuerpo?.conectado, c.cuerpo?.pushToken ?? null, id);
  return { ok: true };
});

GET('/repartidor/tablero', async (c) => {
  const id = await actor(c, 'repartidor');
  const activo = await viajeActivo(id);
  // El interruptor de la app necesita saber en qué estado está, y
  // antes esto no se devolvía: la pantalla lo adivinaba.
  const yo = await consultarUno<Fila>(
    'SELECT id, nombre, vehiculo, conectado FROM repartidores WHERE id = ?', id);
  return {
    repartidor: yo,
    viajeActivo: activo,
    disponibles: activo ? [] : await viajesDisponibles(),
  };
});

POST('/viajes/:id/aceptar', async (c) => aceptarViaje(c.params.id, await actor(c, 'repartidor')));

POST('/paradas/:id/completar', async (c) => {
  await completarParada(c.params.id, await actor(c, 'repartidor'));
  return { ok: true };
});

POST('/repartidor/ubicacion', async (c) => {
  const id = await actor(c, 'repartidor');
  const { lat, lng } = c.cuerpo ?? {};
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    throw new ErrorHttp(400, 'lat y lng tienen que ser números.');
  }
  await registrarUbicacion(id, Number(lat), Number(lng));
  return { ok: true };
});

// ============================================================
// Operador (tú)
// ============================================================

/** El operador registra el token de su teléfono para recibir avisos. */
POST('/operador/conexion', async (c) => {
  const id = await actor(c, 'operador');
  await ejecutar('UPDATE operadores SET push_token = COALESCE(?, push_token) WHERE id = ?',
    c.cuerpo?.pushToken ?? null, id);
  return { ok: true };
});

GET('/operador/tablero', async (c) => {
  await actor(c, 'operador');
  // Sin `?dia=` es hoy, que es lo que mira la app. El panel pide
  // días anteriores para comparar.
  const dia = diaPedido(c);
  const [autogestion, m, liquidaciones, activos] = await Promise.all([
    colaAutogestion(),
    metricas(dia),
    liquidacionesDelDia(dia),
    consultar(
      `SELECT id, numero, estado, cliente_nombre, direccion, total_venta, creado_at
         FROM pedidos WHERE estado NOT IN ('ENTREGADO', 'CANCELADO')
        ORDER BY creado_at DESC`),
  ]);
  return { dia, autogestion, metricas: m, liquidaciones, activos };
});

/**
 * Quiénes son y si están disponibles.
 *
 * La app no lo muestra porque en la feria uno los tiene enfrente;
 * desde el panel es la única forma de saber por qué un rubro no
 * está aceptando nada.
 */
/**
 * Un código de ingreso para alguien del equipo.
 *
 * El operador lo lee en el panel y se lo pasa en persona o por
 * WhatsApp. Evita pagar un SMS por cada ingreso de diez personas
 * que se ven todas las semanas.
 */
POST('/operador/codigo-para/:actorId', async (c) => {
  const operadorId = await actor(c, 'operador');
  return codigoParaAlguien(c.params.actorId, operadorId);
});

GET('/operador/gente', async (c) => {
  await actor(c, 'operador');
  const feriantes = await consultar(
    `SELECT f.id, f.nombre, f.puesto, f.telefono, f.conectado,
            COALESCE(string_agg(r.nombre, ', ' ORDER BY r.nombre), '—') AS rubros,
            (SELECT COUNT(*)::int FROM sub_pedidos s
              WHERE s.feriante_id = f.id AND s.estado NOT IN ('ENTREGADO','CANCELADO'))
              AS en_curso
       FROM feriantes f
       LEFT JOIN feriante_rubros fr ON fr.feriante_id = f.id
       LEFT JOIN rubros r ON r.id = fr.rubro_id
      GROUP BY f.id ORDER BY f.conectado DESC, f.nombre`);
  const repartidores = await consultar(
    `SELECT id, nombre, vehiculo, telefono, conectado,
            (SELECT COUNT(*)::int FROM viajes v
              WHERE v.repartidor_id = repartidores.id AND v.estado = 'EN_RUTA') AS en_curso
       FROM repartidores ORDER BY conectado DESC, nombre`);
  return { feriantes, repartidores };
});

/**
 * Pedidos para el panel.
 *
 * `?estado=` filtra y `?limite=` corta. La app solo muestra los
 * activos; acá hace falta poder buscar el de ayer que reclamaron.
 */
GET('/operador/pedidos', async (c) => {
  await actor(c, 'operador');
  const estado = c.consulta.get('estado');
  const limite = Math.min(Number(c.consulta.get('limite') ?? 50) || 50, 200);
  const pedidos = await consultar(
    `SELECT p.id, p.numero, p.estado, p.cliente_nombre, p.cliente_telefono,
            p.direccion, p.total_productos, p.costo_despacho, p.total_venta, p.creado_at,
            (SELECT COUNT(*)::int FROM sub_pedidos s WHERE s.pedido_id = p.id) AS puestos,
            (SELECT COUNT(*)::int FROM sub_pedidos s
              WHERE s.pedido_id = p.id AND s.autogestionado) AS autogestionados
       FROM pedidos p
      ${estado ? 'WHERE p.estado = ?' : ''}
      ORDER BY p.creado_at DESC LIMIT ${limite}`,
    ...(estado ? [estado] : []));
  return { pedidos };
});

/** El operador compró personalmente lo que nadie aceptó. */
POST('/operador/autogestion/:id/listo', async (c) => {
  await actor(c, 'operador');
  await marcarListo(c.params.id);
  return { ok: true };
});

POST('/operador/liquidaciones/:ferianteId/pagar', async (c) => {
  await actor(c, 'operador');
  return marcarPagado(c.params.ferianteId, c.cuerpo?.fecha);
});

// ---------- Catálogo ----------

/** Todo el catálogo, incluidos los productos apagados. */
GET('/operador/catalogo', async (c) => {
  await actor(c, 'operador');
  return {
    rubros: await catalogoCompleto(),
    todosLosRubros: await consultar('SELECT * FROM rubros ORDER BY nombre'),
  };
});

POST('/operador/productos/:id', async (c) => {
  await actor(c, 'operador');
  return actualizarProducto(c.params.id, c.cuerpo ?? {});
});

POST('/operador/productos', async (c) => {
  await actor(c, 'operador');
  return crearProducto(c.cuerpo ?? {});
});

/**
 * Sube una foto de producto.
 *
 * Llega en base64 porque la app ya la tiene así de la cámara y
 * ahorra meter un parser de multipart. El tope del cuerpo sube solo
 * para esta ruta: 4 MB de foto son ~5,4 MB en base64.
 */
POST('/operador/fotos', async (c) => {
  await actor(c, 'operador');
  return guardarFoto(desdeBase64(c.cuerpo?.datos));
}, Math.ceil(MAX_FOTO * 4 / 3) + 64 * 1024);

/**
 * El panel de administración.
 *
 * Tres archivos sueltos servidos desde el mismo proceso: sin build,
 * sin otro puerto, sin otro despliegue. El panel entra por la misma
 * API y con el mismo ingreso por SMS que la app — no hay una puerta
 * de atrás con su propia contraseña, que es como se pierden estas
 * cosas.
 */
const PANEL = join(dirname(fileURLToPath(import.meta.url)), '../panel');
const TIPOS: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
};

function servirPanel(archivo: string): RespuestaCruda {
  // Solo los archivos que el panel tiene, por nombre exacto.
  if (!/^[a-z-]+\.(html|css|js|png)$/.test(archivo)) throw new ErrorHttp(404, 'No encontrado.');
  const destino = join(PANEL, archivo);
  if (!existsSync(destino)) throw new ErrorHttp(404, 'No encontrado.');
  const ext = archivo.split('.').pop()!;
  // Sin caché: el panel se corrige y se recarga, no se versiona.
  return new RespuestaCruda(readFileSync(destino), TIPOS[ext], 'no-cache');
}

GET('/admin', async () => servirPanel('index.html'));
GET('/admin/:archivo', async (c) => servirPanel(c.params.archivo));

/**
 * Foto de referencia de un producto.
 *
 * Pública y cacheable para siempre: cambia solo cuando cambia el
 * código, y entonces cambia el despliegue entero. Si el producto no
 * tiene foto de referencia devuelve 404 y el cliente cae a su
 * símbolo, que es lo que ya hacía antes.
 */
GET('/referencia/:productoId', async (c) => {
  const foto = leerReferencia(c.params.productoId);
  if (!foto) throw new ErrorHttp(404, 'Sin foto de referencia.');
  return new RespuestaCruda(foto.datos, foto.mime, 'public, max-age=86400');
});

/** De quién es cada foto de referencia. Las licencias CC lo exigen. */
GET('/referencia', async () => ({ creditos }));

/**
 * Sirve una foto. Pública a propósito: la ve cualquier cliente
 * mirando el catálogo, igual que el precio.
 */
GET('/fotos/:nombre', async (c) => {
  const foto = leerFoto(c.params.nombre);
  if (!foto) throw new ErrorHttp(404, 'Foto no encontrada.');
  // El nombre es el hash del contenido, así que nunca cambia: se
  // puede guardar para siempre.
  return new RespuestaCruda(foto.datos, foto.mime, 'public, max-age=31536000, immutable');
});

GET('/operador/productos/:id/historial', async (c) => {
  await actor(c, 'operador');
  return { historial: await historialDe(c.params.id) };
});

/** El operador puede cancelar en cualquier momento antes de entregar. */
POST('/operador/pedidos/:id/cancelar', async (c) => {
  await actor(c, 'operador');
  return cancelarPedido({
    pedidoId: c.params.id,
    motivo: String(c.cuerpo?.motivo ?? 'cancelado por el operador'),
    montoReembolso: c.cuerpo?.montoReembolso,
  });
});

/** Reembolsos que la pasarela no aceptó y hay que resolver a mano. */
GET('/operador/reembolsos-pendientes', async (c) => {
  await actor(c, 'operador');
  return { pendientes: await reembolsosPendientes() };
});

GET('/operador/eventos/:entidadId', async (c) => {
  await actor(c, 'operador');
  return consultar('SELECT * FROM eventos WHERE entidad_id = ? ORDER BY id', c.params.entidadId);
});

// ============================================================
// Desarrollo
// ============================================================

/**
 * Vence todas las ofertas abiertas y corre la cascada de una.
 *
 * Existe para poder demostrar y probar el sistema sin esperar los
 * 210 segundos reales que tarda la cascada completa. Se apaga sola
 * en producción: sin esto sería una forma trivial de sabotear el
 * despacho de la feria entera.
 */
POST('/dev/vencer-ofertas', async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new ErrorHttp(404, 'Ruta no encontrada.');
  }
  const r = await ejecutar(
    `UPDATE ofertas SET expira_at = now() - interval '1 second' WHERE respuesta IS NULL`);
  await tick();
  return { vencidas: r.afectadas };
});

// ============================================================
// Servidor
// ============================================================

/** Tope de cuerpo: un pedido son unos pocos kilobytes. */
const MAX_CUERPO = 256 * 1024;

function leerCuerpo(req: IncomingMessage, max = MAX_CUERPO): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const trozos: Buffer[] = [];
    let total = 0;
    req.on('data', (t: Buffer) => {
      total += t.length;
      if (total > max) {
        reject(new ErrorHttp(413, 'Cuerpo demasiado grande.'));
        req.destroy();
        return;
      }
      trozos.push(t);
    });
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

async function manejar(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers',
    'content-type, authorization, x-shopify-hmac-sha256');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url ?? '/', 'http://localhost');
  const camino = url.pathname;

  // El freno va antes de resolver la ruta: una avalancha contra una
  // ruta inexistente cuesta lo mismo que contra una real.
  const espera = pasar(deQuien(req));
  if (espera > 0) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(espera) });
    return res.end(JSON.stringify({
      error: `Demasiadas peticiones. Prueba de nuevo en ${espera} segundos.`,
    }));
  }
  const encontrada = resolver(req.method ?? 'GET', camino);
  if (!encontrada) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Ruta no encontrada.' }));
  }

  try {
    const crudo = req.method === 'POST'
      ? await leerCuerpo(req, encontrada.maxCuerpo) : Buffer.alloc(0);
    const tipo = String(req.headers['content-type'] ?? '');
    // Flow confirma con application/x-www-form-urlencoded, no JSON.
    const cuerpo = !crudo.length ? {}
      : tipo.includes('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(crudo.toString('utf8')))
        : JSON.parse(crudo.toString('utf8'));
    const salida = await encontrada.handler({
      params: encontrada.params, consulta: url.searchParams, cuerpo, req, crudo,
    });
    if (salida instanceof RespuestaCruda) {
      res.writeHead(200, {
        'content-type': salida.tipo,
        ...(salida.cache ? { 'cache-control': salida.cache } : {}),
      });
      return res.end(salida.datos);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(salida ?? { ok: true }));
  } catch (e: any) {
    const codigo =
      e instanceof ErrorHttp ? e.codigo
      : e instanceof OfertaNoDisponible || e instanceof ViajeNoDisponible ? 409
      : e instanceof TransicionInvalida ? 422
      : e instanceof ErrorPago ? e.codigo
      : e instanceof ErrorCatalogo ? e.codigo
      : e instanceof ErrorArchivo ? e.codigo
      : e instanceof ErrorCancelacion ? e.codigo
      : e instanceof FeriaCerrada ? e.codigo
      : e instanceof PedidoMuyChico ? 422
      : e instanceof ErrorAuth ? e.codigo
      : e instanceof SyntaxError ? 400
      : 500;
    if (codigo === 500) console.error('[error]', camino, e);
    if (res.headersSent) return;
    res.writeHead(codigo, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message ?? 'Error interno.' }));
  }
}

export async function iniciar(puerto = CONFIG.puerto) {
  await abrirDB();
  await sembrar();
  iniciarNotificaciones();

  const servidor = createServer((req, res) => { void manejar(req, res); });
  const wss = new WebSocketServer({ server: servidor, path: '/ws' });

  // Cada conexión declara qué es (?rol=feriante&id=f-jose) y solo
  // recibe lo suyo. Sin este filtro, el celular de cada feriante
  // recibiría las ofertas de los otros ocho puestos.
  const clientes = new Map<WebSocket, { rol: string; id: string }>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    clientes.set(ws, {
      rol: url.searchParams.get('rol') ?? 'cliente',
      id: url.searchParams.get('id') ?? '',
    });
    ws.on('close', () => clientes.delete(ws));
    ws.on('error', () => clientes.delete(ws));
  });

  bus.on('mensaje', (m) => {
    const payload = JSON.stringify(m);
    for (const [ws, subs] of clientes) {
      if (ws.readyState === ws.OPEN && leRegistra(subs, m)) ws.send(payload);
    }
  });

  // Latido del motor. Se encadena en vez de usar setInterval para
  // que dos ticks no se solapen si uno tarda más de un segundo.
  let vivo = true;
  const latir = async () => {
    while (vivo) {
      try {
        await tick();
      } catch (e) {
        console.error('[tick]', e);
      }
      await new Promise((r) => setTimeout(r, CONFIG.intervaloTickMs));
    }
  };
  void latir();

  /**
   * Revisa los cobros abiertos contra la pasarela.
   *
   * Aparte del latido del motor porque es una llamada a un servicio
   * externo y va mucho más espaciada. El webhook sigue siendo el
   * camino rápido; esto es la red que lo atrapa cuando se pierde —
   * y en desarrollo, donde el webhook no llega nunca a `localhost`,
   * es el único camino.
   */
  const revisarPagos = async () => {
    while (vivo) {
      await new Promise((r) => setTimeout(r, 8000));
      if (!vivo) break;
      try {
        const r = await revisarCobrosAbiertos();
        if (r.confirmados > 0) {
          console.log(`[pagos] ${r.confirmados} cobro(s) confirmados al revisar`);
        }
      } catch (e) {
        console.error('[pagos] revisión', e);
      }
    }
  };
  void revisarPagos();

  // Las ventanas del freno vencen solas, pero alguien tiene que
  // sacarlas del mapa o crece con cada IP que pasó alguna vez.
  const barrido = setInterval(() => limpiarFrenos(), 60_000);
  barrido.unref();

  await new Promise<void>((r) => servidor.listen(puerto, r));
  console.log(`Feria backend en http://localhost:${puerto}  ·  base: ${nombreMotor()}`);
  console.log(`WebSocket en ws://localhost:${puerto}/ws?rol=feriante&id=f-jose`);
  console.log(`Panel en http://localhost:${puerto}/admin  ·  freno: ${LIMITE_POR_MINUTO}/min por IP`);

  /** Cierre ordenado: el orquestador manda SIGTERM al desplegar. */
  const apagar = async (senal: string) => {
    console.log(`\n${senal} recibido, cerrando…`);
    vivo = false;
    wss.close();
    servidor.close();
    await cerrarDB().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));

  return servidor;
}
