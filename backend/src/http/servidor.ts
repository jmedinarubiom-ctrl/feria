import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { CONFIG } from '../config.ts';
import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, nombreMotor, type Fila } from '../db/index.ts';
import { sembrar, FERIA_ID } from '../db/semilla.ts';
import {
  crearPedido, aceptarOferta, rechazarOferta, liberarSubPedido, marcarListo, tick,
  cotizar, OfertaNoDisponible, PedidoMuyChico,
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
import { ErrorNegocio, TransicionInvalida } from '../dominio/estados.ts';
import { bus } from '../realtime/bus.ts';
import { leRegistra } from '../realtime/filtro.ts';
import {
  pedirCodigo, crearSesion, verificarToken, cerrarSesion, cerrarTodas, sesionesDe,
  codigoParaAlguien, pedirCodigoPorCorreo, crearSesionPorCorreo, crearSesionExterna,
  confirmarCodigo, fijarClaveOperador, normalizarTelefono, ErrorAuth, type Identidad,
} from '../dominio/auth.ts';
import { externosDisponibles, verificarTokenExterno } from '../dominio/externo.ts';
import { proveedorCorreo } from '../correo.ts';
import {
  textosLegales, terminosPendientes, aceptarTerminos, datosDelCliente,
  eliminarCuentaCliente, limpiarDatosViejos,
} from '../dominio/privacidad.ts';
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
  cancelarPedido, reembolsosPendientes, reintentarReembolso, anotarReembolsoManual,
  ErrorCancelacion,
} from '../dominio/cancelacion.ts';
import {
  crearFeriante, actualizarFeriante, crearRepartidor, actualizarRepartidor,
  postular, solicitudDe, guardarPerfilCliente, fijarTelefonoDeCliente,
} from '../dominio/gente.ts';
import { FeriaCerrada } from '../dominio/horario.ts';
import {
  listarFerias, vistaDeFeria, feriasConGente, actualizarFeria, dondeAbrirElMapa,
} from '../dominio/ferias.ts';
import {
  guardarFoto, leerFoto, desdeBase64, MAX_FOTO, ErrorArchivo, guardarEnLaBase, leerDeLaBase,
} from '../dominio/archivos.ts';
import { leerReferencia, creditos } from '../dominio/referencia.ts';
import { latir } from '../motor.ts';
import { erroresRecientes, registrarError, revisarYAvisar, silencioDelMotor } from '../dominio/alertas.ts';
import { iniciarComprobantes } from '../dominio/comprobante.ts';
import { comoEscuchar, iniciarDifusion } from '../realtime/difusion.ts';
import { deQuien, pasar, limpiar as limpiarFrenos, LIMITE_POR_MINUTO } from './freno.ts';

// ============================================================
// Router mínimo
// ============================================================

type Ctx = {
  params: Record<string, string>;
  /** Lo que viene en el `?`: el panel filtra por día y por estado. */
  consulta: URLSearchParams;
  cuerpo: any;
  req: Peticion;
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
      if (patron.startsWith(':')) {
        // Un `%` suelto hace lanzar a decodeURIComponent. Eso es una
        // petición mal escrita, no un error del servidor.
        try {
          params[patron.slice(1)] = decodeURIComponent(partes[i]);
        } catch {
          throw new ErrorHttp(400, 'La dirección está mal escrita.');
        }
      } else if (patron !== partes[i]) { calza = false; break; }
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

/** Manda al navegador a otra dirección. */
class Redireccion {
  destino: string;
  constructor(destino: string) { this.destino = destino; }
}

export class ErrorHttp extends Error {
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

const PLURAL: Record<string, string> = {
  feriante: 'feriantes', repartidor: 'repartidores', operador: 'la operación', cliente: 'clientes',
};

/** Exige un rol concreto y devuelve el id de quien hizo la petición. */
async function actor(c: Ctx, esperado: string): Promise<string> {
  const yo = await identidad(c);
  if (yo.rol !== esperado) {
    throw new ErrorHttp(403, `Esta acción es solo para ${PLURAL[esperado] ?? esperado}.`);
  }
  return yo.actorId;
}

/** `?dia=YYYY-MM-DD`, o hoy. Una fecha inventada no llega a la base. */
function diaPedido(c: Ctx): string {
  return fechaValida(c.consulta.get('dia')) ?? hoy();
}

/** Lo mismo para una fecha que viene en el cuerpo. `undefined` es «hoy». */
function fechaValida(valor: unknown): string | undefined {
  if (valor == null || valor === '') return undefined;
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)
      || Number.isNaN(Date.parse(valor))) {
    throw new ErrorHttp(422, 'Fecha inválida.');
  }
  return valor;
}

// ============================================================
// Sesión
// ============================================================

/**
 * El servidor de desarrollo está abierto a internet (`./feria.sh`).
 *
 * En desarrollo el código de ingreso se devuelve en la respuesta y
 * hay rutas `/dev/` que confirman pagos sin cobrar. Con el backend
 * solo en tu red eso es cómodo; detrás de un túnel público significa
 * que cualquiera que encuentre la dirección entra como operador
 * —basta pedir el código de tu teléfono— y se marca pedidos como
 * pagados. Con esta marca, esos atajos quedan solo para quien llega
 * desde el mismo computador.
 */
const EXPUESTA = process.env.FERIA_EXPUESTA === '1';

/** La petición viene de este computador, no a través del túnel. */
function esLocal(req: Peticion): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false;
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Las rutas `/dev/` no existen en producción ni para quien llega por el túnel. */
function soloDesarrollo(c: Ctx): void {
  if (process.env.NODE_ENV === 'production' || (EXPUESTA && !esLocal(c.req))) {
    throw new ErrorHttp(404, 'Ruta no encontrada.');
  }
}

/** Paso 1: el teléfono recibe un código de 6 dígitos. */
POST('/auth/codigo', (c) => {
  frenarCodigos(deQuien(c.req));
  const opciones = { ocultarCodigo: EXPUESTA && !esLocal(c.req) };
  // Con `correo` el código va al correo: es el ingreso del
  // comprador que no usa su teléfono. Solo da cuenta de cliente.
  return c.cuerpo?.correo
    ? pedirCodigoPorCorreo(c.cuerpo.correo, opciones)
    : pedirCodigo(c.cuerpo?.telefono, opciones);
});

/**
 * Con qué se puede entrar. La app muestra solo lo que funciona: un
 * botón de Google que contesta «no disponible» es peor que no
 * tenerlo.
 */
GET('/auth/metodos', async () => {
  const produccion = process.env.NODE_ENV === 'production';
  return {
    sms: !produccion || proveedorSms() !== 'consola',
    correo: !produccion || proveedorCorreo() !== 'consola',
    ...externosDisponibles(),
  };
});

/** Entrar con Google o con Apple. Solo da cuenta de cliente. */
POST('/auth/externo', async (c) => {
  frenarCodigos(deQuien(c.req));
  const quien = await verificarTokenExterno(
    c.cuerpo?.proveedor, c.cuerpo?.idToken, c.cuerpo?.nombre);
  const s = await crearSesionExterna(quien, c.cuerpo?.dispositivo);
  return {
    token: s.token, rol: s.rol, actorId: s.actorId, nombre: s.nombre, expiraAt: s.expiraAt,
  };
});

/**
 * Tope de códigos por IP.
 *
 * Ahora cualquier celular chileno recibe un código, y cada uno es
 * un SMS que se paga. El tope por teléfono no alcanza: alguien
 * puede pedir códigos para mil números distintos y la cuenta llega
 * igual. Es holgado a propósito —las compañías ponen a mucha gente
 * detrás de la misma IP— pero corta una máquina pidiendo sin parar.
 */
const CODIGOS_POR_HORA = Number(process.env.CODIGOS_POR_HORA_POR_IP ?? 30);
const pedidosDeCodigo = new Map<string, number[]>();

function frenarCodigos(ip: string): void {
  const hace1h = Date.now() - 3_600_000;
  const recientes = (pedidosDeCodigo.get(ip) ?? []).filter((t) => t > hace1h);
  if (recientes.length >= CODIGOS_POR_HORA) {
    throw new ErrorHttp(429, 'Se pidieron demasiados códigos desde esta conexión. Prueba más tarde.');
  }
  recientes.push(Date.now());
  pedidosDeCodigo.set(ip, recientes);
  if (pedidosDeCodigo.size > 5000) {
    for (const [k, v] of pedidosDeCodigo) if (v.every((t) => t <= hace1h)) pedidosDeCodigo.delete(k);
  }
}

/** Paso 2: el código se canjea por una sesión larga. */
POST('/auth/sesion', async (c) => {
  const s = c.cuerpo?.correo
    ? await crearSesionPorCorreo(c.cuerpo.correo, c.cuerpo?.codigo, c.cuerpo?.dispositivo)
    : await crearSesion(c.cuerpo?.telefono, c.cuerpo?.codigo, c.cuerpo?.dispositivo,
        c.cuerpo?.clave, c.cuerpo?.codigoCorreo);
  return {
    token: s.token, rol: s.rol, actorId: s.actorId, nombre: s.nombre, expiraAt: s.expiraAt,
  };
});

/**
 * Cómo escuchar los avisos en vivo cuando no hay WebSocket propio
 * (el servidor corre como función). El cliente que sigue un pedido
 * no tiene sesión: su llave es el id del pedido, igual que antes.
 */
GET('/vivo', async (c) => {
  const pedido = c.consulta.get('pedido');
  if (pedido) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(pedido)) throw new ErrorHttp(422, 'Pedido inválido.');
    return comoEscuchar({ rol: 'cliente', id: pedido });
  }
  const yo = await identidad(c);
  return comoEscuchar({ rol: yo.rol, id: yo.actorId });
});

GET('/auth/yo', async (c) => {
  const yo = await identidad(c);
  const tabla = yo.rol === 'feriante' ? 'feriantes'
    : yo.rol === 'repartidor' ? 'repartidores'
    : yo.rol === 'cliente' ? 'clientes' : 'operadores';
  const fila = await consultarUno<Fila>(`SELECT * FROM ${tabla} WHERE id = ?`, yo.actorId);
  // La clave del operador, ni en forma de hash, sale del servidor.
  const { clave_hash, ...perfil } = fila ?? {};
  return {
    ...yo,
    perfil,
    ...(yo.rol === 'operador' ? { conClave: !!clave_hash } : {}),
    // El feriante ve en su encabezado de qué feria es su puesto.
    ...(yo.rol === 'feriante' && perfil.feria_id ? {
      feria: (await consultarUno<Fila>('SELECT nombre FROM ferias WHERE id = ?', perfil.feria_id))?.nombre ?? null,
    } : {}),
    sesiones: await sesionesDe(yo.actorId),
    // El operador es quien pone los términos: no se los acepta a sí mismo.
    terminosPendientes: yo.rol !== 'operador' && await terminosPendientes(yo.actorId),
    // Si pidió ser feriante o repartidor, en qué quedó.
    ...(yo.rol === 'cliente'
      ? { solicitud: perfil.telefono ? await solicitudDe(perfil.telefono) : null } : {}),
  };
});

// ============================================================
// Términos, privacidad y los datos de cada uno
// ============================================================

/** Los textos, para mostrarlos en la app antes de aceptar. */
GET('/legal', async () => textosLegales());

/**
 * La política de privacidad como página. Las tiendas de apps piden
 * una dirección pública donde leerla.
 */
GET('/legal/privacidad', async () => paginaLegal('Política de privacidad', textosLegales().privacidad));
GET('/legal/terminos', async () => paginaLegal('Términos y condiciones', textosLegales().terminos));

function paginaLegal(titulo: string, texto: string): RespuestaCruda {
  const seguro = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  // El mismo criterio que la app: párrafos, listas, capítulos y
  // cláusulas numeradas con su nombre destacado.
  const cuerpo = texto.trim().split(/\n\s*\n/).map((crudo, i) => {
    const bloque = crudo.trim();
    if (/^- /.test(bloque)) {
      return '<ul>' + bloque.split(/\n(?=- )/).map((l) => `<li>${seguro(l.replace(/^- /, ''))}</li>`).join('') + '</ul>';
    }
    const b = bloque.replace(/\s*\n\s*/g, ' ');
    if (i === 0) return `<h1>${seguro(b)}</h1>`;
    if (/^[IVX]+\.\s/.test(b) && b.length < 70) return `<h2>${seguro(b)}</h2>`;
    const punto = /^(\d+)\.\s+([^.]{2,60}\.)\s*(.*)$/.exec(b);
    if (punto) return `<p><strong>${punto[1]}. ${seguro(punto[2])}</strong> ${seguro(punto[3])}</p>`;
    return `<p>${seguro(b)}</p>`;
  }).join('\n');
  return new RespuestaCruda(`<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feria App — ${titulo}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #F4F6F4; color: #16211D;
         max-width: 680px; margin: 0 auto; padding: 24px; line-height: 1.65; }
  h1 { font-size: 24px; line-height: 1.25; margin: 0 0 16px; color: #8B2838; }
  h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #0C5C44; margin: 32px 0 8px; }
  p, li { font-size: 16px; } li { margin-bottom: 6px; }
</style></head>
<body>${cuerpo}</body></html>`, 'text/html; charset=utf-8', 'no-cache');
}

POST('/auth/aceptar-terminos', async (c) => {
  const yo = await identidad(c);
  return aceptarTerminos(yo.actorId, yo.rol, c.cuerpo?.version);
});

/** Una copia de todo lo que se guarda de quien la pide. */
GET('/cliente/mis-datos', async (c) => datosDelCliente(await actor(c, 'cliente')));

/** Borra la cuenta y los datos personales. No tiene vuelta. */
POST('/cliente/eliminar-cuenta', async (c) => {
  const id = await actor(c, 'cliente');
  // Un toque sin querer no puede borrar una cuenta.
  if (c.cuerpo?.confirmo !== 'ELIMINAR') {
    throw new ErrorHttp(422, 'Falta confirmar.');
  }
  return eliminarCuentaCliente(id);
});

// ============================================================
// Cliente
// ============================================================

POST('/cliente/perfil', async (c) =>
  guardarPerfilCliente(await actor(c, 'cliente'), c.cuerpo));

/**
 * Confirmar un número para la cuenta: se manda un código por SMS a
 * ese número y con el código queda como el teléfono de la cuenta.
 *
 * Es la única forma de poner o cambiar el teléfono confirmado.
 * Antes el número del perfil era un campo de texto: alguien entraba
 * con su teléfono y después escribía el de otro encima.
 */
POST('/cliente/telefono/codigo', async (c) => {
  await actor(c, 'cliente');
  frenarCodigos(deQuien(c.req));
  return pedirCodigo(c.cuerpo?.telefono, { ocultarCodigo: EXPUESTA && !esLocal(c.req) });
});

POST('/cliente/telefono/confirmar', async (c) => {
  const id = await actor(c, 'cliente');
  const telefono = normalizarTelefono(c.cuerpo?.telefono);
  await confirmarCodigo(telefono, c.cuerpo?.codigo);
  return fijarTelefonoDeCliente(id, telefono);
});

/**
 * Dónde abrir el mapa para elegir el punto de entrega: cerca de la
 * dirección que escribió. Con sesión, porque cada consulta sale a
 * un buscador de direcciones que tiene cupo.
 */
GET('/cliente/ubicar', async (c) => {
  await actor(c, 'cliente');
  return dondeAbrirElMapa(c.consulta.get('direccion'), c.consulta.get('feria') || FERIA_ID);
});

/** Sus pedidos, del más nuevo al más viejo. */
GET('/cliente/pedidos', async (c) => {
  const id = await actor(c, 'cliente');
  const filas = await consultar<Fila>(
    'SELECT id FROM pedidos WHERE cliente_id = ? ORDER BY creado_at DESC LIMIT 30', id);
  return { pedidos: filas.map((f) => f.id) };
});

/** El teléfono del comprador, para avisarle cómo va su pedido. */
POST('/cliente/conexion', async (c) => {
  const id = await actor(c, 'cliente');
  const token = c.cuerpo?.pushToken;
  if (typeof token !== 'string' || token.length > 200) throw new ErrorHttp(422, 'Token inválido.');
  await ejecutar('UPDATE clientes SET push_token = ? WHERE id = ?', token, id);
  return { ok: true };
});

/** Pide ser feriante o repartidor. Lo aprueba el operador. */
POST('/cliente/postular', async (c) => {
  const id = await actor(c, 'cliente');
  const yo = await consultarUno<Fila>('SELECT telefono FROM clientes WHERE id = ?', id);
  // A un feriante o repartidor hay que poder llamarlo, y el número
  // tiene que estar confirmado: eso solo lo da el ingreso por SMS.
  if (!yo?.telefono) {
    throw new ErrorHttp(409,
      'Para vender o repartir hay que entrar con tu teléfono. Cierra sesión y entra con tu número.');
  }
  return postular(yo.telefono, c.cuerpo, FERIA_ID);
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
  pagos: pasarela()?.nombre ?? 'sin configurar',
  ts: new Date().toISOString(),
}));

/**
 * Si una feria está tomando pedidos ahora mismo. Con `?feria=` la
 * que eligió el cliente; sin él, la de siempre.
 */
GET('/feria/estado', async (c) => ({
  ...await vistaDeFeria(c.consulta.get('feria') || FERIA_ID),
  // Sacarle el botón de cancelar al cliente sin darle a dónde
  // llamar lo deja atrapado. El teléfono es la salida.
  contacto: CONFIG.telefonoContacto,
}));

/** Todas las ferias: las que ya reparten y las que vienen. */
GET('/ferias', async () => ({ ferias: await listarFerias() }));

GET('/catalogo', async () => {
  const rubros = await consultar<Fila>('SELECT * FROM rubros ORDER BY nombre');
  return Promise.all(rubros.map(async (r) => ({
    ...r,
    // Columnas con nombre, no `SELECT *`: esta ruta es pública y la
    // tabla tiene `precio_costo`. Con el asterisco cualquiera que
    // abriera el catálogo veía cuánto se le paga a cada feriante y,
    // restando, el margen de cada producto.
    productos: await consultar(
      `SELECT id, rubro_id, nombre, formato, precio_venta, imagen_url
         FROM productos WHERE rubro_id = ? AND activo ORDER BY nombre`, r.id),
  })));
});

/**
 * Alta de pedido desde la app del cliente.
 *
 * El cliente entra con su teléfono, igual que todos: el pedido
 * queda a su nombre y con un número que de verdad es suyo, que es
 * al que va a llamar el repartidor.
 *
 * El pedido nace en PENDIENTE_PAGO y no se le ofrece a nadie hasta
 * que la pasarela confirma el cobro.
 *
 * Los campos se copian de a uno, nunca `...c.cuerpo`: lo que no
 * está en esta lista no llega al dominio, por más que el cliente lo
 * mande.
 */
POST('/pedidos', async (c) => {
  const clienteId = await actor(c, 'cliente');
  const cliente = await consultarUno<Fila>('SELECT * FROM clientes WHERE id = ?', clienteId);
  const b = c.cuerpo;
  const email = typeof b.clienteEmail === 'string' ? b.clienteEmail : null;

  const r = await crearPedido({
    // La feria que eligió en la app. Que exista y esté repartiendo
    // lo comprueba el dominio.
    feriaId: typeof b.feriaId === 'string' && b.feriaId ? b.feriaId : FERIA_ID,
    clienteId,
    clienteNombre: b.clienteNombre,
    // Con número confirmado, el pedido lleva ESE: es el único que
    // se sabe de quién es. Solo quien entró sin teléfono (correo,
    // Google) escribe uno de contacto.
    clienteTelefono: cliente!.telefono
      ?? (typeof b.clienteTelefono === 'string' && b.clienteTelefono.trim()
        ? b.clienteTelefono : cliente!.telefono_contacto),
    clienteEmail: email,
    direccion: b.direccion,
    lat: Number(b.lat),
    lng: Number(b.lng),
    puntoMarcado: b.puntoMarcado === true,
    precisionM: Number(b.precisionM),
    notas: typeof b.notas === 'string' ? b.notas : null,
    items: b.items,
  });
  await ejecutar('UPDATE clientes SET ultima_actividad_at = now() WHERE id = ?', clienteId);
  // Lo que usó queda guardado para la próxima compra.
  await guardarPerfilCliente(clienteId, {
    nombre: b.clienteNombre, email: email ?? cliente!.email, direccion: b.direccion,
    telefonoContacto: b.clienteTelefono,
  });
  return r;
});

/** Lo que necesita el carro para mostrar el total antes de cobrar. */
GET('/cotizar/:total', async (c) => cotizar(Number(c.params.total) || 0));

/**
 * El pedido, para el seguimiento del cliente y para el panel.
 *
 * Lo ve el operador y el cliente que lo hizo, nadie más. Por número
 * (#1042) solo busca el operador.
 */
GET('/pedidos/:id', async (c) => {
  const yo = await identidad(c);
  const operador = yo.rol === 'operador';
  const p = await pedidoCompleto(c.params.id)
    ?? (operador ? await pedidoPorNumero(c.params.id) : null);
  // Mismo 404 para «no existe» y «no es tuyo»: no se confirma que
  // un id ajeno es de un pedido real.
  if (!p || (!operador && !(yo.rol === 'cliente' && p.cliente_id === yo.actorId))) {
    throw new ErrorHttp(404, 'Pedido no encontrado.');
  }
  return operador ? p : sinCostos(p);
});

/** Lo que ve el cliente: su pedido, sin la plata interna del negocio. */
function sinCostos(p: Fila): Fila {
  return {
    ...p,
    subPedidos: p.subPedidos.map(({ monto_feriante, compensado, ...s }: Fila) => ({
      ...s,
      items: s.items.map(({ precio_costo, ...i }: Fila) => i),
    })),
    viaje: p.viaje ? (({ tarifa, ...v }: Fila) => v)(p.viaje) : null,
  };
}

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
/**
 * El pago de un pedido es cosa de quien lo hizo y del operador.
 *
 * Estas rutas estaban abiertas: cualquiera que supiera el id de un
 * pedido podía iniciar su cobro —y con eso dejarle anotado su propio
 * correo para un eventual reembolso— o ver sus pagos. El id no se
 * adivina, pero «no se adivina» no es un permiso.
 */
async function exigirPedidoPropio(c: Ctx, pedidoId: string): Promise<void> {
  const yo = await identidad(c);
  if (yo.rol === 'operador') return;
  const p = await consultarUno<Fila>('SELECT cliente_id FROM pedidos WHERE id = ?', pedidoId);
  // El mismo 404 para «no existe» y «no es tuyo».
  if (!p || yo.rol !== 'cliente' || p.cliente_id !== yo.actorId) {
    throw new ErrorHttp(404, 'Pedido no encontrado.');
  }
}

POST('/pagos/iniciar', async (c) => {
  const pedidoId = String(c.cuerpo?.pedidoId ?? '');
  await exigirPedidoPropio(c, pedidoId);
  return iniciarPago(pedidoId, String(c.cuerpo?.email ?? 'sin@correo.cl'));
});

GET('/pagos/pedido/:id', async (c) => {
  await exigirPedidoPropio(c, c.params.id);
  return { pagos: await pagosDe(c.params.id) };
});

/**
 * «¿Ya llegó mi pago?»
 *
 * La app la llama mientras espera, en vez de confiar en que el
 * webhook haya llegado. Pregunta a la pasarela y confirma si
 * corresponde, así el cliente no se queda mirando una pantalla que
 * dice «esperando el pago» con la plata ya descontada.
 */
POST('/pagos/:pagoId/revisar', async (c) => {
  const pago = await consultarUno<Fila>('SELECT pedido_id FROM pagos WHERE id = ?', c.params.pagoId);
  await exigirPedidoPropio(c, pago?.pedido_id ?? '');
  return revisarCobro(c.params.pagoId);
});

/**
 * Mercado Pago avisa acá.
 *
 * Manda el id en la URL o en el cuerpo según la antigüedad de la
 * integración, y avisa de cosas que no son pagos. `pagoAvisado`
 * normaliza todo eso y devuelve null para lo que no nos toca.
 *
 * Se responde 200 siempre —MP reintenta durante días y termina
 * deshabilitando el webhook— y el contenido del aviso no se cree:
 * llega por HTTP abierto y cualquiera puede inventarlo, así que se
 * le vuelve a preguntar a Mercado Pago.
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
 * La pasarela trae de vuelta al navegador, no a la app, así que
 * esta página lo devuelve a la app por deep link.
 */
GET('/pagos/retorno', async () => (SIN_HTML
  ? new Redireccion('feria://pago')
  : new RespuestaCruda(PAGINA_RETORNO, 'text/html; charset=utf-8', 'no-store')));

/**
 * Las funciones de Supabase entregan el HTML como texto plano: ahí
 * la vuelta del pago es una redirección directa a la app.
 */
const SIN_HTML = process.env.FERIA_SIN_HTML === '1';

// Antes esto devolvía JSON: después de pagar, el cliente quedaba
// mirando `{"ok":true,"volverA":"feria://pago"}` en el navegador sin
// saber si había pagado ni cómo volver.
const PAGINA_RETORNO = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feria — pago recibido</title>
<style>
  body { font-family: system-ui, sans-serif; background: #FAFBFC; color: #1F2933;
         display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  main { text-align: center; padding: 32px; max-width: 360px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #52606D; line-height: 1.5; }
  a { display: inline-block; margin-top: 16px; padding: 14px 24px; border-radius: 12px;
      background: #8B2838; color: #fff; text-decoration: none; font-weight: 700; }
</style></head>
<body><main>
  <h1>Listo</h1>
  <p>Ya puedes volver a la app: ahí vas a ver cómo va tu pedido.</p>
  <a href="feria://pago">Volver a la app</a>
</main>
<script>setTimeout(function () { location.href = 'feria://pago'; }, 400);</script>
</body></html>`;

/** Confirmación sin pasarela, solo para desarrollo. */
POST('/dev/pagar/:pagoId', async (c) => {
  soloDesarrollo(c);
  return { pagado: await confirmarEnDesarrollo(c.params.pagoId) };
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
  confirmarRecepcion(await actor(c, 'feriante'), fechaValida(c.cuerpo?.fecha)));

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
/** El operador pone o cambia su clave (su segundo factor). */
POST('/operador/clave', async (c) => {
  const yo = await identidad(c);
  if (yo.rol !== 'operador') throw new ErrorHttp(403, 'Esta acción es solo para la operación.');
  return fijarClaveOperador(yo.actorId, c.cuerpo?.nueva, c.cuerpo?.actual, yo.sesionId);
});

POST('/operador/codigo-para/:actorId', async (c) => {
  const operadorId = await actor(c, 'operador');
  return codigoParaAlguien(c.params.actorId, operadorId);
});

GET('/operador/gente', async (c) => {
  await actor(c, 'operador');
  const feriantes = await consultar(
    `SELECT f.id, f.nombre, f.puesto, f.telefono, f.conectado, f.activo, f.pendiente, f.feria_id,
            (SELECT fe.nombre FROM ferias fe WHERE fe.id = f.feria_id) AS feria,
            COALESCE(string_agg(r.nombre, ', ' ORDER BY r.nombre), '—') AS rubros,
            COALESCE(array_agg(r.id ORDER BY r.nombre) FILTER (WHERE r.id IS NOT NULL), '{}')
              AS rubro_ids,
            (SELECT COUNT(*)::int FROM sub_pedidos s
              WHERE s.feriante_id = f.id AND s.estado NOT IN ('ENTREGADO','CANCELADO'))
              AS en_curso
       FROM feriantes f
       LEFT JOIN feriante_rubros fr ON fr.feriante_id = f.id
       LEFT JOIN rubros r ON r.id = fr.rubro_id
      GROUP BY f.id ORDER BY f.pendiente DESC, f.activo DESC, f.conectado DESC, f.nombre`);
  const repartidores = await consultar(
    `SELECT id, nombre, vehiculo, telefono, conectado, activo, pendiente,
            (SELECT COUNT(*)::int FROM viajes v
              WHERE v.repartidor_id = repartidores.id AND v.estado = 'EN_RUTA') AS en_curso
       FROM repartidores ORDER BY pendiente DESC, activo DESC, conectado DESC, nombre`);
  const rubros = await consultar('SELECT id, nombre FROM rubros ORDER BY nombre');
  return { feriantes, repartidores, rubros, ferias: await feriasConGente() };
});

/** Las ferias, con su horario y si ya se reparte desde cada una. */
GET('/operador/ferias', async (c) => {
  await actor(c, 'operador');
  return { ferias: await feriasConGente() };
});
POST('/operador/ferias/:id', async (c) => {
  await actor(c, 'operador');
  return actualizarFeria(c.params.id, c.cuerpo);
});

/** Alta y cambios de la gente: los feriantes y repartidores de verdad. */
POST('/operador/feriantes', async (c) => {
  await actor(c, 'operador');
  return crearFeriante(c.cuerpo,
    typeof c.cuerpo.feriaId === 'string' && c.cuerpo.feriaId ? c.cuerpo.feriaId : FERIA_ID);
});
POST('/operador/feriantes/:id', async (c) => {
  await actor(c, 'operador');
  return actualizarFeriante(c.params.id, c.cuerpo);
});
POST('/operador/repartidores', async (c) => {
  await actor(c, 'operador');
  return crearRepartidor(c.cuerpo);
});
POST('/operador/repartidores/:id', async (c) => {
  await actor(c, 'operador');
  return actualizarRepartidor(c.params.id, c.cuerpo);
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
  return marcarPagado(c.params.ferianteId, fechaValida(c.cuerpo?.fecha));
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
  const f = guardarFoto(desdeBase64(c.cuerpo?.datos));
  await guardarEnLaBase(`foto/${f.nombre}`, f.mime, f.datos);
  return { camino: f.camino, bytes: f.bytes, mime: f.mime };
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
  const id = c.params.productoId;
  const foto = leerReferencia(id)
    ?? (/^[a-z0-9-]{1,60}$/.test(id) ? await leerDeLaBase(`ref/${id}`) : null);
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
  const nombre = c.params.nombre;
  const foto = leerFoto(nombre)
    ?? (/^[0-9a-f]{32}\.(jpg|png|webp)$/.test(nombre) ? await leerDeLaBase(`foto/${nombre}`) : null);
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

POST('/operador/reembolsos/:pagoId/reintentar', async (c) => {
  await actor(c, 'operador');
  return reintentarReembolso(c.params.pagoId);
});

POST('/operador/reembolsos/:pagoId/hecho', async (c) => {
  return anotarReembolsoManual(c.params.pagoId, await actor(c, 'operador'));
});

/** Los últimos errores internos, para no depender de los registros del hosting. */
GET('/operador/errores', async (c) => {
  await actor(c, 'operador');
  return { errores: await erroresRecientes() };
});

GET('/operador/eventos/:entidadId', async (c) => {
  await actor(c, 'operador');
  return consultar('SELECT * FROM eventos WHERE entidad_id = ? ORDER BY id', c.params.entidadId);
});

// ============================================================
// Latido desde afuera
// ============================================================

/**
 * Hace latir el motor por un rato.
 *
 * Una función sin servidor no tiene un proceso que viva siempre: el
 * reloj lo pone la base (pg_cron), que llama acá cada minuto, y la
 * función late por 58 segundos. Solo con el secreto: si no, sería
 * una forma de gastar la cuota de la función desde afuera.
 */
POST('/interno/latir', async (c) => {
  const secreto = process.env.FERIA_MOTOR_SECRETO ?? '';
  const dado = String(c.req.headers['x-feria-motor'] ?? '');
  if (secreto.length < 16 || dado.length !== secreto.length
      || !timingSafeEqual(Buffer.from(dado), Buffer.from(secreto))) {
    throw new ErrorHttp(404, 'Ruta no encontrada.');
  }
  if (c.cuerpo?.eco) {
    // Para revisar con qué dirección ve la función a quien llama.
    const h = c.req.headers;
    return { eco: { xff: h['x-forwarded-for'], cf: h['cf-connecting-ip'], real: h['x-real-ip'], quien: deQuien(c.req) } };
  }
  if (typeof c.cuerpo?.aviso === 'string') {
    // Para probar el canal en vivo de punta a punta: un aviso de
    // «algo cambió» en ese pedido, sin tocar ningún dato.
    bus.emit('mensaje', { tipo: 'pedido:cambio', pedidoId: c.cuerpo.aviso, estado: '' });
    return { ok: true, avisado: c.cuerpo.aviso };
  }
  const hasta = Date.now() + Math.min(Number(c.cuerpo?.segundos ?? 58), 120) * 1000;
  // Sin un proceso que viva siempre, la limpieza de datos viejos
  // también cuelga de este reloj: cuatro veces al día.
  const ahora = new Date();
  const limpieza = ahora.getUTCMinutes() === 0 && ahora.getUTCHours() % 6 === 0
    ? limpiarDatosViejos()
      .then((r) => {
        const algo = Object.entries(r).filter(([, n]) => n > 0);
        if (algo.length) console.log('[retención] borrado:', Object.fromEntries(algo));
      })
      .catch((e) => console.error('[retención]', e))
    : Promise.resolve();
  // El silencio se mide antes de volver a latir: después ya no se nota.
  const silencio = await silencioDelMotor();
  const avisos = revisarYAvisar(silencio).catch((e) => { console.error('[alertas]', e); });
  const trabajo = Promise.all([latir(() => Date.now() < hasta), limpieza, avisos]).then(() => undefined);
  // Si el entorno deja seguir trabajando después de responder, se
  // responde al tiro; si no, la respuesta espera al último latido.
  const fondo = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof fondo === 'function') fondo.call((globalThis as any).EdgeRuntime, trabajo);
  else if (c.cuerpo?.esperar) await trabajo;
  return { ok: true, latiendo: true };
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
POST('/dev/vencer-ofertas', async (c) => {
  soloDesarrollo(c);
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

/**
 * Lo que el servidor necesita saber de una petición. Lo cumple el
 * `IncomingMessage` de Node y también lo que arma la función de
 * Supabase (`edge.ts`), que no tiene sockets.
 */
export type Peticion = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

export type Respuesta = {
  estado: number;
  cabeceras: Record<string, string>;
  cuerpo: Buffer | string | null;
};

const CABECERAS_FIJAS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Que el navegador no adivine tipos: lo que se sube como foto se
  // sirve como foto. Y que nadie meta el panel dentro de otra página.
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const enJson = (estado: number, datos: unknown, extra: Record<string, string> = {}): Respuesta => ({
  estado,
  cabeceras: { ...CABECERAS_FIJAS, 'content-type': 'application/json', ...extra },
  cuerpo: JSON.stringify(datos),
});

/**
 * Atiende una petición y devuelve la respuesta entera.
 *
 * No sabe de sockets ni de `ServerResponse`: así el mismo código
 * corre en el servidor de Node y en una función sin servidor.
 * `leer` entrega el cuerpo, con el tope que la ruta permita.
 */
export async function atender(
  req: Peticion, leer: (max: number) => Promise<Buffer>,
): Promise<Respuesta> {
  if (req.method === 'OPTIONS') return { estado: 204, cabeceras: CABECERAS_FIJAS, cuerpo: null };

  // El freno va antes de resolver la ruta: una avalancha contra una
  // ruta inexistente cuesta lo mismo que contra una real.
  const espera = pasar(deQuien(req));
  if (espera > 0) {
    return enJson(429, {
      error: `Demasiadas peticiones. Prueba de nuevo en ${espera} segundos.`,
    }, { 'retry-after': String(espera) });
  }

  let camino = req.url ?? '/';
  // Todo lo que puede lanzar va DENTRO del try, incluido leer la
  // dirección. Antes la ruta se resolvía afuera: una sola petición
  // a `/pedidos/%E0%A4%A` lanzaba fuera de todo manejador, y un
  // rechazo sin atrapar termina el proceso. Cualquiera podía botar
  // la feria entera con una URL.
  try {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      throw new ErrorHttp(400, 'La dirección está mal escrita.');
    }
    camino = url.pathname;

    const encontrada = resolver(req.method ?? 'GET', camino);
    if (!encontrada) throw new ErrorHttp(404, 'Ruta no encontrada.');

    const crudo = req.method === 'POST'
      ? await leer(encontrada.maxCuerpo ?? MAX_CUERPO) : Buffer.alloc(0);
    const cuerpo = !crudo.length ? {} : JSON.parse(crudo.toString('utf8'));
    // `null`, un número o una lista son JSON válido pero no son un
    // cuerpo: los handlers leen `c.cuerpo.algo` sin preguntar.
    if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
      throw new ErrorHttp(400, 'El cuerpo tiene que ser un objeto JSON.');
    }
    const salida = await encontrada.handler({
      params: encontrada.params, consulta: url.searchParams, cuerpo, req, crudo,
    });
    if (salida instanceof Redireccion) {
      return { estado: 302, cabeceras: { ...CABECERAS_FIJAS, location: salida.destino }, cuerpo: null };
    }
    if (salida instanceof RespuestaCruda) {
      return {
        estado: 200,
        cabeceras: {
          ...CABECERAS_FIJAS,
          'content-type': salida.tipo,
          ...(salida.cache ? { 'cache-control': salida.cache } : {}),
        },
        cuerpo: salida.datos,
      };
    }
    return enJson(200, salida ?? { ok: true });
  } catch (e: any) {
    const codigo =
      e instanceof ErrorHttp ? e.codigo
      : e instanceof OfertaNoDisponible || e instanceof ViajeNoDisponible ? 409
      : e instanceof TransicionInvalida ? 422
      : e instanceof ErrorNegocio ? e.codigo
      : e instanceof ErrorPago ? e.codigo
      : e instanceof ErrorCatalogo ? e.codigo
      : e instanceof ErrorArchivo ? e.codigo
      : e instanceof ErrorCancelacion ? e.codigo
      : e instanceof FeriaCerrada ? e.codigo
      : e instanceof PedidoMuyChico ? 422
      : e instanceof ErrorAuth ? e.codigo
      : e instanceof SyntaxError ? 400
      : 500;
    if (codigo === 500) {
      console.error('[error]', camino, e);
      const anotado = registrarError(camino, e);
      (globalThis as any).EdgeRuntime?.waitUntil?.(anotado);
    }
    // El detalle de un error interno queda en el registro, no viaja
    // al cliente: puede traer nombres de tablas o de columnas.
    return enJson(codigo, {
      error: codigo === 500 ? 'Error interno. Intenta de nuevo.' : (e.message ?? 'Error.'),
      // Para que la app muestre el campo de la clave del operador.
      ...(e.pideClave ? { pideClave: true } : {}),
      // Y el del código que se mandó al correo, como segunda prueba.
      ...(e.pideCorreo ? {
        pideCorreo: true, correo: e.correo,
        ...(e.codigoDev && !(EXPUESTA && !esLocal(req)) ? { codigoDev: e.codigoDev } : {}),
      } : {}),
    });
  }
}

async function manejar(req: IncomingMessage, res: ServerResponse) {
  const r = await atender(req, (max) => leerCuerpo(req, max));
  if (res.headersSent) return;
  res.writeHead(r.estado, r.cabeceras);
  res.end(r.cuerpo ?? undefined);
}

/**
 * Deja el servidor listo para `atender` sin abrir un puerto: es lo
 * que usa la función de Supabase. No migra ni siembra —eso lo hace
 * el arranque normal, `npm start`— para que despertar la función no
 * cueste una docena de consultas.
 */
export async function preparar(url?: string): Promise<void> {
  await abrirDB({ url, sinMigrar: true });
  iniciarNotificaciones();
  iniciarDifusion();
  iniciarComprobantes();
}

export async function iniciar(puerto = CONFIG.puerto, opciones: { memoria?: boolean } = {}) {
  await abrirDB(opciones);
  await sembrar();
  iniciarNotificaciones();
  iniciarComprobantes();

  const servidor = createServer((req, res) => {
    // Última red: pase lo que pase adentro, una petición no puede
    // terminar el proceso.
    manejar(req, res).catch((e) => {
      console.error('[error] sin atrapar', req.url, e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Error interno. Intenta de nuevo.' }));
    });
  });
  const wss = new WebSocketServer({ server: servidor, path: '/ws' });

  // Cada conexión declara qué es (?rol=feriante&id=f-jose) y solo
  // recibe lo suyo. Sin este filtro, el celular de cada feriante
  // recibiría las ofertas de los otros ocho puestos.
  const clientes = new Map<WebSocket, { rol: string; id: string }>();

  //
  // Quién es lo dice el token, no la URL. Antes bastaba conectarse
  // con `?rol=operador` para recibir el movimiento de toda la feria,
  // o con el id de otro feriante para ver sus ofertas. El cliente
  // sigue sin token: su llave es el id de su pedido.
  wss.on('connection', (ws, req) => {
    ws.on('close', () => clientes.delete(ws));
    ws.on('error', () => clientes.delete(ws));

    let url: URL;
    try {
      url = new URL(req.url ?? '/ws', 'http://localhost');
    } catch {
      return ws.close(1008, 'dirección inválida');
    }
    const rol = url.searchParams.get('rol') ?? 'cliente';
    if (rol === 'cliente') {
      clientes.set(ws, { rol, id: url.searchParams.get('id') ?? '' });
      return;
    }
    const entrar = (token: string | undefined) => verificarToken(token)
      .then((yo) => {
        if (ws.readyState === ws.OPEN) clientes.set(ws, { rol: yo.rol, id: yo.actorId });
      })
      .catch(() => ws.close(1008, 'sesión inválida'));

    // El token llega en el primer mensaje, no en la dirección: las
    // direcciones quedan escritas en los registros del hosting y de
    // cualquier proxy del camino, y con el token se entra como esa
    // persona. Las apps anteriores todavía lo mandan en la
    // dirección; se les sigue aceptando.
    const enDireccion = url.searchParams.get('token');
    if (enDireccion) return void entrar(enDireccion);

    const plazo = setTimeout(() => ws.close(1008, 'sin identificarse'), 10_000);
    ws.once('message', (dato) => {
      clearTimeout(plazo);
      let token: unknown;
      try { token = JSON.parse(String(dato))?.token; } catch { /* no era JSON */ }
      void entrar(typeof token === 'string' ? token : undefined);
    });
    ws.on('close', () => clearTimeout(plazo));
  });

  bus.on('mensaje', (m) => {
    const payload = JSON.stringify(m);
    for (const [ws, subs] of clientes) {
      if (ws.readyState === ws.OPEN && leRegistra(subs, m)) ws.send(payload);
    }
  });

  // Latido del motor y revisión de cobros: ver `motor.ts`.
  let vivo = true;
  if (process.env.FERIA_SIN_MOTOR !== '1') void latir(() => vivo);
  else console.log('[motor] FERIA_SIN_MOTOR: este servidor no hace latir el despacho.');

  // Las ventanas del freno vencen solas, pero alguien tiene que
  // sacarlas del mapa o crece con cada IP que pasó alguna vez.
  const barrido = setInterval(() => limpiarFrenos(), 60_000);
  barrido.unref();

  // Lo que ya no hace falta guardar se borra solo.
  const limpiar = () => limpiarDatosViejos()
    .then((r) => {
      const algo = Object.entries(r).filter(([, n]) => n > 0);
      if (algo.length) console.log('[retención] borrado:', Object.fromEntries(algo));
    })
    .catch((e) => console.error('[retención]', e));
  void limpiar();
  setInterval(limpiar, 6 * 3_600_000).unref();

  if (process.env.NODE_ENV === 'production' && textosLegales().borrador) {
    console.warn('[legal] A los términos y la política de privacidad les faltan datos del proveedor: '
      + textosLegales().faltan.join(', ') + '.\n        Defínelos con las variables LEGAL_* (ver .env.example).');
  }

  // Cerrar el servidor detiene también los dos relojes.
  servidor.on('close', () => { vivo = false; wss.close(); });

  await new Promise<void>((r) => servidor.listen(puerto, r));
  console.log(`Feria backend en http://localhost:${puerto}  ·  base: ${nombreMotor()}`);
  console.log(`WebSocket en ws://localhost:${puerto}/ws`);
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
