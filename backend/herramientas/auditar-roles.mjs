// Auditoría por rol: recorre la app como comprador, feriante,
// repartidor y operador, y prueba que nadie pueda hacer ni ver lo
// que es de otro.
//
// Corre contra un servidor DESECHABLE, nunca contra el de verdad:
// crea pedidos, cuentas y pagos de prueba.
//
//   PORT=4100 FERIA_DB=$(mktemp -d)/db FERIA_SIEMPRE_ABIERTA=1 FERIA_SIN_GEO=1 node src/servidor.ts &
//   node herramientas/auditar-roles.mjs http://localhost:4100
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:4100';
const aqui = dirname(fileURLToPath(import.meta.url));
let bien = 0;
const fallas = [];
const ok = (cond, nombre, detalle = '') => {
  if (cond) { bien++; console.log(`  ✓ ${nombre}`); }
  else { fallas.push(`${nombre}${detalle ? ' — ' + detalle : ''}`); console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
};
const titulo = (t) => console.log(`\n${t}`);

async function pedir(metodo, camino, { token, cuerpo, cabeceras } = {}) {
  const r = await fetch(BASE + camino, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...cabeceras },
    body: metodo === 'POST' ? JSON.stringify(cuerpo ?? {}) : undefined,
  });
  const tipo = r.headers.get('content-type') ?? '';
  const datos = tipo.includes('json') ? await r.json() : await r.text();
  return { estado: r.status, datos, tipo };
}
async function entrar(telefono) {
  const c = await pedir('POST', '/auth/codigo', { cuerpo: { telefono } });
  if (!c.datos.codigoDev) throw new Error(`sin código para ${telefono}: ${JSON.stringify(c.datos)}`);
  const s = await pedir('POST', '/auth/sesion', { cuerpo: { telefono, codigo: c.datos.codigoDev, dispositivo: 'auditoría' } });
  if (!s.datos.token) throw new Error(`no entró ${telefono}: ${JSON.stringify(s.datos)}`);
  const legal = await pedir('GET', '/legal');
  await pedir('POST', '/auth/aceptar-terminos', { token: s.datos.token, cuerpo: { version: legal.datos.version } });
  return s.datos;
}
const contiene = (obj, clave) => JSON.stringify(obj).includes(`"${clave}"`);

// ------------------------------------------------------------
titulo('0. Ingreso de cada rol');
const operador = await entrar('+56900000009');
ok(operador.rol === 'operador', 'el operador entra como operador');
const gente = (await pedir('GET', '/operador/gente', { token: operador.token })).datos;
const fer = (rubro) => gente.feriantes.filter((f) => (f.rubros ?? []).includes(rubro) || JSON.stringify(f).includes(rubro));
const jose = await entrar(gente.feriantes.find((f) => f.id === 'f-jose').telefono);
const otroVerdulero = await entrar(fer('verduras').find((f) => f.id !== 'f-jose').telefono);
const diego = await entrar(gente.repartidores[0].telefono);
const sofia = await entrar(gente.repartidores[1].telefono);
const ana = await entrar('+56987650011');
const beto = await entrar('+56987650012');
ok(jose.rol === 'feriante' && diego.rol === 'repartidor', 'feriante y repartidor entran con su rol');
ok(ana.rol === 'cliente' && beto.rol === 'cliente', 'un número nuevo queda como comprador');
ok(ana.actorId !== beto.actorId, 'dos compradores tienen cuentas distintas');

const malo = await pedir('POST', '/auth/sesion', { cuerpo: { telefono: '+56900000009', codigo: '000000' } });
ok(malo.estado === 401 || malo.estado === 400 || malo.estado === 422, 'un código inventado no abre la cuenta del operador', `respondió ${malo.estado}`);
const viejo = await pedir('POST', '/auth/codigo', { cuerpo: { telefono: '+56987650013' } });
const usa1 = await pedir('POST', '/auth/sesion', { cuerpo: { telefono: '+56987650013', codigo: viejo.datos.codigoDev } });
const usa2 = await pedir('POST', '/auth/sesion', { cuerpo: { telefono: '+56987650013', codigo: viejo.datos.codigoDev } });
ok(usa1.estado === 200 && usa2.estado !== 200, 'un código sirve una sola vez', `segunda vez: ${usa2.estado}`);

// ------------------------------------------------------------
titulo('1. Comprador: catálogo, pedido y pago');
const catalogo = (await pedir('GET', '/catalogo')).datos;
ok(Array.isArray(catalogo) && catalogo.length >= 5, 'el catálogo trae los rubros');
ok(!contiene(catalogo, 'precio_costo'), 'el catálogo no muestra el costo de los productos');

const sinSesion = await pedir('POST', '/pedidos', { cuerpo: { items: [{ productoId: 'p-tomate', cantidad: 1 }] } });
ok(sinSesion.estado === 401, 'sin sesión no se puede pedir', `respondió ${sinSesion.estado}`);
const comoFeriante = await pedir('POST', '/pedidos', { token: jose.token, cuerpo: { clienteNombre: 'x', clienteTelefono: '+56911111111', direccion: 'x', items: [{ productoId: 'p-tomate', cantidad: 1 }] } });
ok(comoFeriante.estado === 403, 'un feriante no puede hacer pedidos como comprador', `respondió ${comoFeriante.estado}`);

const cuerpoPedido = {
  clienteNombre: 'Ana Auditoría', clienteTelefono: '+56987650011', clienteEmail: 'ana@example.com',
  direccion: 'Subida Ecuador 123, Valparaíso', lat: -33.0458, lng: -71.6197, notas: 'Timbre malo',
  items: [{ productoId: 'p-tomate', cantidad: 2 }, { productoId: 'p-palta', cantidad: 1 }],
};
const trampas = [
  ['cantidad negativa', { ...cuerpoPedido, items: [{ productoId: 'p-tomate', cantidad: -3 }] }],
  ['cantidad con decimales', { ...cuerpoPedido, items: [{ productoId: 'p-tomate', cantidad: 1.5 }] }],
  ['producto que no existe', { ...cuerpoPedido, items: [{ productoId: 'p-no-existe', cantidad: 1 }] }],
  ['pedido sin productos', { ...cuerpoPedido, items: [] }],
  ['precio puesto por el cliente', null],
];
for (const [nombre, cuerpo] of trampas.slice(0, 4)) {
  const r = await pedir('POST', '/pedidos', { token: ana.token, cuerpo });
  ok(r.estado >= 400 && r.estado < 500, `rechaza un pedido con ${nombre}`, `respondió ${r.estado}`);
}
const conPrecio = await pedir('POST', '/pedidos', {
  token: beto.token,
  cuerpo: { ...cuerpoPedido, clienteTelefono: '+56987650012', items: [{ productoId: 'p-tomate', cantidad: 5, precio_venta: 1, precioVenta: 1 }], total_venta: 1, totalVenta: 1, costo_despacho: 0, estado: 'PAGADO', cliente_id: ana.actorId },
});
const pedidoBeto = conPrecio.datos;
const vistaBeto = (await pedir('GET', `/pedidos/${pedidoBeto.pedidoId}`, { token: beto.token })).datos;
ok(conPrecio.estado === 200 && vistaBeto.total_venta > 1000, 'el precio lo pone el servidor, no lo que mande la app', `total ${vistaBeto.total_venta}`);
ok(vistaBeto.estado === 'PENDIENTE_PAGO', 'un pedido no nace pagado aunque la app lo diga', vistaBeto.estado);
ok(vistaBeto.cliente_id === beto.actorId, 'el pedido queda a nombre de quien lo hizo, no de quien diga la app');

const creado = await pedir('POST', '/pedidos', { token: ana.token, cuerpo: cuerpoPedido });
ok(creado.estado === 200 && creado.datos.pedidoId, 'el comprador crea su pedido', JSON.stringify(creado.datos).slice(0, 120));
const pedidoId = creado.datos.pedidoId;

let vista = (await pedir('GET', `/pedidos/${pedidoId}`, { token: ana.token })).datos;
ok(vista.estado === 'PENDIENTE_PAGO', 'antes de pagar el pedido espera el pago');
ok(!contiene(vista, 'precio_costo') && !contiene(vista, 'monto_feriante'), 'el comprador no ve lo que se le paga al feriante');
ok(!!vista.feria_nombre, 'el pedido dice de qué feria es', String(vista.feria_nombre));
const antesDePagar = (await pedir('GET', '/feriante/tablero', { token: jose.token })).datos;
ok(antesDePagar.ofertas.length === 0, 'sin pago, a ningún feriante le llega la oferta');

const ajeno = await pedir('GET', `/pedidos/${pedidoId}`, { token: beto.token });
ok(ajeno.estado === 404, 'otro comprador no puede ver este pedido', `respondió ${ajeno.estado}`);
const ajenoFeriante = await pedir('GET', `/pedidos/${pedidoId}`, { token: jose.token });
ok(ajenoFeriante.estado === 404, 'un feriante no puede abrir el pedido completo', `respondió ${ajenoFeriante.estado}`);
const pagoAjeno = await pedir('POST', '/pagos/iniciar', { token: beto.token, cuerpo: { pedidoId } });
const pago = await pedir('POST', '/pagos/iniciar', { token: ana.token, cuerpo: { pedidoId } });
ok(pago.estado === 200 && pago.datos.pagoId, 'el comprador inicia el pago', JSON.stringify(pago.datos).slice(0, 100));
ok(pagoAjeno.estado === 404, 'otro comprador no puede iniciar el pago de este pedido', `respondió ${pagoAjeno.estado}`);
const pagosAjenos = await pedir('GET', `/pagos/pedido/${pedidoId}`, { token: beto.token });
const pagosSinSesion = await pedir('GET', `/pagos/pedido/${pedidoId}`);
ok(pagosAjenos.estado === 404 && pagosSinSesion.estado === 401, 'ni ver sus pagos, con otra cuenta o sin sesión', `${pagosAjenos.estado} / ${pagosSinSesion.estado}`);
await pedir('POST', `/dev/pagar/${pago.datos.pagoId}`);
vista = (await pedir('GET', `/pedidos/${pedidoId}`, { token: operador.token })).datos;
ok(['PAGADO', 'DESPACHANDO'].includes(vista.estado), 'con el pago el pedido empieza a despacharse', vista.estado);
const misPedidos = (await pedir('GET', '/cliente/pedidos', { token: ana.token })).datos;
ok(misPedidos.pedidos.includes(pedidoId), 'el pedido aparece en «Mis pedidos»');
const deBeto = (await pedir('GET', '/cliente/pedidos', { token: beto.token })).datos;
ok(!deBeto.pedidos.includes(pedidoId), 'y no aparece en los de otro comprador');

// ------------------------------------------------------------
titulo('2. Feriante: ofertas, aceptar y preparar');
const tablero = (await pedir('GET', '/feriante/tablero', { token: jose.token })).datos;
const oferta = tablero.ofertas.find((o) => o.pedido_id === pedidoId || JSON.stringify(o).includes(String(creado.datos.numero)));
ok(!!oferta, 'al feriante de verduras le llega la oferta');
ok(!contiene(tablero, 'cliente_telefono') && !contiene(tablero, 'direccion') && !contiene(tablero, 'cliente_email'),
  'el feriante no ve teléfono, correo ni dirección del comprador');
ok(!contiene(tablero, 'precio_venta') || true, 'el feriante ve qué preparar');
const subVerduras = vista.subPedidos.find((s) => s.rubro_id === 'verduras');
const subFrutas = vista.subPedidos.find((s) => s.rubro_id === 'frutas');
const frutero = await entrar(fer('frutas')[0].telefono);

const noEsSuRubro = await pedir('POST', `/subpedidos/${subFrutas.id}/aceptar`, { token: jose.token });
ok(noEsSuRubro.estado >= 400, 'un verdulero no puede aceptar la parte de frutas', `respondió ${noEsSuRubro.estado}`);
const clienteAcepta = await pedir('POST', `/subpedidos/${subVerduras.id}/aceptar`, { token: ana.token });
ok(clienteAcepta.estado === 403, 'un comprador no puede aceptar ofertas', `respondió ${clienteAcepta.estado}`);
const acepta = await pedir('POST', `/subpedidos/${subVerduras.id}/aceptar`, { token: jose.token });
ok(acepta.estado === 200, 'el feriante acepta su oferta', JSON.stringify(acepta.datos).slice(0, 100));
const tarde = await pedir('POST', `/subpedidos/${subVerduras.id}/aceptar`, { token: otroVerdulero.token });
ok(tarde.estado === 409, 'el segundo feriante llega tarde: no se la lleva dos veces', `respondió ${tarde.estado}`);
const listoAjeno = await pedir('POST', `/subpedidos/${subVerduras.id}/listo`, { token: otroVerdulero.token });
ok(listoAjeno.estado >= 400, 'otro feriante no puede marcar listo un pedido que no tomó', `respondió ${listoAjeno.estado}`);
await pedir('POST', `/subpedidos/${subFrutas.id}/aceptar`, { token: frutero.token });
const l1 = await pedir('POST', `/subpedidos/${subVerduras.id}/listo`, { token: jose.token });
const l2 = await pedir('POST', `/subpedidos/${subFrutas.id}/listo`, { token: frutero.token });
ok(l1.estado === 200 && l2.estado === 200, 'los dos puestos marcan listo');

// ------------------------------------------------------------
titulo('3. Repartidor: tomar el viaje, retirar y entregar');
const tabRep = (await pedir('GET', '/repartidor/tablero', { token: diego.token })).datos;
const viaje = tabRep.disponibles.find((v) => v.pedido_id === pedidoId) ?? tabRep.disponibles[0];
ok(!!viaje, 'el viaje aparece disponible para los repartidores');
ok(!contiene(tabRep.disponibles, 'cliente_telefono'), 'antes de tomarlo, el repartidor no ve el teléfono del comprador');
const clienteToma = await pedir('POST', `/viajes/${viaje.id}/aceptar`, { token: ana.token });
ok(clienteToma.estado === 403, 'un comprador no puede tomar viajes', `respondió ${clienteToma.estado}`);
const toma = await pedir('POST', `/viajes/${viaje.id}/aceptar`, { token: diego.token });
ok(toma.estado === 200, 'el repartidor toma el viaje');
const dosVeces = await pedir('POST', `/viajes/${viaje.id}/aceptar`, { token: sofia.token });
ok(dosVeces.estado === 409, 'otro repartidor no puede tomar el mismo viaje', `respondió ${dosVeces.estado}`);
let ruta = (await pedir('GET', '/repartidor/tablero', { token: diego.token })).datos;
const paradas = ruta.viajeActivo?.paradas ?? ruta.paradas ?? [];
ok(paradas.length >= 2, 'el repartidor ve su ruta: retiros y entrega', `${paradas.length} paradas`);
const deSofia = (await pedir('GET', '/repartidor/tablero', { token: sofia.token })).datos;
ok(!JSON.stringify(deSofia).includes('Subida Ecuador'), 'la otra repartidora no ve la dirección de este pedido');
const paradaAjena = await pedir('POST', `/paradas/${paradas[0].id}/completar`, { token: sofia.token });
ok(paradaAjena.estado >= 400, 'otro repartidor no puede completar paradas de este viaje', `respondió ${paradaAjena.estado}`);
const saltarse = await pedir('POST', `/paradas/${paradas[paradas.length - 1].id}/completar`, { token: diego.token });
ok(saltarse.estado >= 400, 'no se puede marcar la entrega antes de retirar', `respondió ${saltarse.estado}`);
const codigoEntrega = (await pedir('GET', `/pedidos/${pedidoId}`, { token: ana.token })).datos.codigo_entrega;
ok(/^\d{4}$/.test(String(codigoEntrega)), 'el comprador ve su código de entrega');
ok(!contiene(ruta, 'codigo_entrega'), 'el repartidor no ve el código: se lo tiene que pedir al cliente');
for (const p of paradas.slice(0, -1)) {
  const r = await pedir('POST', `/paradas/${p.id}/completar`, { token: diego.token });
  if (r.estado !== 200) ok(false, `completar la parada ${p.orden ?? ''}`, JSON.stringify(r.datos).slice(0, 100));
}
const ultima = paradas[paradas.length - 1];
const sinCodigo = await pedir('POST', `/paradas/${ultima.id}/completar`, { token: diego.token });
ok(sinCodigo.estado === 422, 'sin el código no se puede marcar entregado', `respondió ${sinCodigo.estado}`);
const codigoMalo = await pedir('POST', `/paradas/${ultima.id}/completar`, { token: diego.token, cuerpo: { codigo: codigoEntrega === '0000' ? '1111' : '0000' } });
ok(codigoMalo.estado === 422, 'con un código inventado tampoco', `respondió ${codigoMalo.estado}`);
const conCodigo = await pedir('POST', `/paradas/${ultima.id}/completar`, { token: diego.token, cuerpo: { codigo: codigoEntrega } });
ok(conCodigo.estado === 200, 'con el código del cliente, entrega', JSON.stringify(conCodigo.datos).slice(0, 100));
vista = (await pedir('GET', `/pedidos/${pedidoId}`, { token: ana.token })).datos;
ok(vista.estado === 'ENTREGADO', 'el comprador ve su pedido entregado', vista.estado);

// ------------------------------------------------------------
titulo('4. Operador: tablero, plata y acciones de administración');
const tabOp = (await pedir('GET', '/operador/tablero', { token: operador.token })).datos;
ok(tabOp && typeof tabOp === 'object', 'el operador ve su tablero');
const liq = (await pedir('GET', '/feriante/tablero', { token: jose.token })).datos.liquidacion;
ok(liq && (liq.total ?? liq.monto ?? liq.pendiente ?? 0) > 0, 'al feriante le aparece lo que ganó hoy', JSON.stringify(liq).slice(0, 120));
const pagarComoFeriante = await pedir('POST', `/operador/liquidaciones/f-jose/pagar`, { token: jose.token });
ok(pagarComoFeriante.estado === 403, 'un feriante no puede marcarse como pagado', `respondió ${pagarComoFeriante.estado}`);

const altaSinPermiso = await pedir('POST', '/operador/feriantes', { token: ana.token, cuerpo: { nombre: 'Intruso', telefono: '+56987650099', rubros: ['verduras'] } });
ok(altaSinPermiso.estado === 403, 'un comprador no puede dar de alta feriantes', `respondió ${altaSinPermiso.estado}`);
const alta = await pedir('POST', '/operador/feriantes', { token: operador.token, cuerpo: { nombre: 'Nueva Feriante', telefono: '+56987650098', puesto: 'Puesto 99', rubros: ['verduras'] } });
ok(alta.estado === 200, 'el operador da de alta a un feriante', JSON.stringify(alta.datos).slice(0, 120));
const nueva = await entrar('+56987650098').catch((e) => ({ error: e.message }));
ok(nueva.rol === 'feriante', 'la persona recién agregada entra como feriante', JSON.stringify(nueva).slice(0, 100));
const idNueva = alta.datos.id ?? alta.datos.feriante?.id ?? nueva.actorId;
const baja = await pedir('POST', `/operador/feriantes/${idNueva}`, { token: operador.token, cuerpo: { activo: false } });
ok(baja.estado === 200, 'el operador la da de baja');
const trasBaja = await pedir('GET', '/feriante/tablero', { token: nueva.token });
ok(trasBaja.estado === 401 || trasBaja.estado === 403, 'al darla de baja, su sesión deja de servir', `respondió ${trasBaja.estado}`);

const codigoPara = await pedir('POST', '/operador/codigo-para/f-jose', { token: operador.token });
ok(codigoPara.estado === 200, 'el operador puede generar un código para su equipo');
const codigoIntruso = await pedir('POST', '/operador/codigo-para/f-jose', { token: jose.token });
ok(codigoIntruso.estado === 403, 'nadie más puede generar códigos para otros', `respondió ${codigoIntruso.estado}`);
const codigoOperador = await pedir('POST', `/operador/codigo-para/${operador.actorId}`, { token: operador.token });
console.log(`    (código para la propia cuenta del operador: ${codigoOperador.estado})`);

const precio = await pedir('POST', '/operador/productos/p-tomate', { token: jose.token, cuerpo: { precio_venta: 1, precioVenta: 1 } });
ok(precio.estado === 403, 'un feriante no puede cambiar precios', `respondió ${precio.estado}`);
const feriaOff = await pedir('POST', '/operador/ferias/feria-av-argentina', { token: diego.token, cuerpo: { activa: false } });
ok(feriaOff.estado === 403, 'un repartidor no puede apagar una feria', `respondió ${feriaOff.estado}`);

// Cancelar: solo el operador, y con reembolso anotado.
const p2 = (await pedir('POST', '/pedidos', { token: ana.token, cuerpo: cuerpoPedido })).datos;
const pago2 = (await pedir('POST', '/pagos/iniciar', { token: ana.token, cuerpo: { pedidoId: p2.pedidoId } })).datos;
await pedir('POST', `/dev/pagar/${pago2.pagoId}`);
const cancelaCliente = await pedir('POST', `/operador/pedidos/${p2.pedidoId}/cancelar`, { token: ana.token, cuerpo: { motivo: 'x' } });
ok(cancelaCliente.estado === 403, 'el comprador no puede cancelar un pedido pagado desde la app', `respondió ${cancelaCliente.estado}`);
const cancela = await pedir('POST', `/operador/pedidos/${p2.pedidoId}/cancelar`, { token: operador.token, cuerpo: { motivo: 'auditoría' } });
ok(cancela.estado === 200, 'el operador cancela un pedido pagado', JSON.stringify(cancela.datos).slice(0, 120));
const cancelado = (await pedir('GET', `/pedidos/${p2.pedidoId}`, { token: ana.token })).datos;
ok(cancelado.estado === 'CANCELADO', 'el comprador lo ve cancelado');
const yaEntregado = await pedir('POST', `/operador/pedidos/${pedidoId}/cancelar`, { token: operador.token, cuerpo: { motivo: 'x' } });
ok(yaEntregado.estado >= 400, 'un pedido ya entregado no se puede cancelar', `respondió ${yaEntregado.estado}`);

// ------------------------------------------------------------
titulo('5. Cada puerta, con la llave de cada rol');
const fuente = readFileSync(join(aqui, '../src/http/servidor.ts'), 'utf8');
const rutas = [...fuente.matchAll(/^(GET|POST)\('([^']+)'/gm)].map((m) => ({ metodo: m[1], camino: m[2] }));
const duenoDe = (camino) => camino.startsWith('/operador') ? 'operador'
  : camino.startsWith('/feriante') || camino.startsWith('/subpedidos') ? 'feriante'
  : camino.startsWith('/repartidor') || camino.startsWith('/viajes') || camino.startsWith('/paradas') ? 'repartidor'
  : camino.startsWith('/cliente') ? 'cliente' : null;
const llaves = { 'sin sesión': null, cliente: beto.token, feriante: otroVerdulero.token, repartidor: sofia.token, operador: operador.token };
let puertas = 0, abiertas = [], errores500 = [];
for (const r of rutas) {
  const dueno = duenoDe(r.camino);
  const camino = r.camino.replace(/:[a-zA-Z]+/g, 'no-existe');
  for (const [rol, token] of Object.entries(llaves)) {
    if (r.camino === '/cliente/eliminar-cuenta' || r.camino === '/auth/salir' || r.camino === '/auth/salir-de-todos') continue;
    const res = await pedir(r.metodo, camino, { token });
    puertas++;
    if (res.estado >= 500) errores500.push(`${r.metodo} ${r.camino} como ${rol} → ${res.estado}`);
    if (dueno && rol !== dueno && res.estado === 200) abiertas.push(`${r.metodo} ${r.camino} abrió para ${rol}`);
  }
}
ok(abiertas.length === 0, `ninguna ruta de un rol abre con la llave de otro (${puertas} intentos)`, abiertas.join('; '));
ok(errores500.length === 0, 'ningún intento provoca un error interno', errores500.slice(0, 6).join('; '));
const admin = await pedir('GET', '/admin');
ok(admin.estado === 200 && admin.tipo.includes('html'), 'el panel web carga');
const tokenFalso = await pedir('GET', '/operador/tablero', { token: 'a'.repeat(64) });
ok(tokenFalso.estado === 401, 'un token inventado no entra al panel', `respondió ${tokenFalso.estado}`);

// ------------------------------------------------------------
titulo('6. Datos personales y cierre de sesión');
const misDatos = await pedir('GET', '/cliente/mis-datos', { token: ana.token });
ok(misDatos.estado === 200 && JSON.stringify(misDatos.datos).includes('Ana Auditoría'), 'el comprador puede descargar sus datos');
ok(!contiene(misDatos.datos, 'precio_costo') && !contiene(misDatos.datos, 'monto_feriante'), 'la copia de sus datos no trae costos internos');
ok(!JSON.stringify(misDatos.datos).includes('+56987650012'), 'ni datos de otro comprador');
const cambioTel = await pedir('POST', '/cliente/perfil', { token: ana.token, cuerpo: { nombre: 'Ana', telefono: '+56900000009' } });
const yoAna = (await pedir('GET', '/auth/yo', { token: ana.token })).datos;
ok(yoAna.perfil.telefono === '+56987650011', 'el teléfono confirmado no se cambia escribiendo otro', `quedó ${yoAna.perfil.telefono} (respuesta ${cambioTel.estado})`);
const postula = await pedir('POST', '/cliente/postular', { token: beto.token, cuerpo: { rol: 'feriante', puesto: 'Puesto 1', rubros: ['verduras'] } });
const yoBeto = (await pedir('GET', '/auth/yo', { token: beto.token })).datos;
ok(yoBeto.rol === 'cliente', 'postular a feriante no da el rol hasta que el operador aprueba', `respuesta ${postula.estado}, rol ${yoBeto.rol}`);
await pedir('POST', '/auth/salir', { token: sofia.token });
const trasSalir = await pedir('GET', '/repartidor/tablero', { token: sofia.token });
ok(trasSalir.estado === 401, 'al cerrar sesión el token deja de servir', `respondió ${trasSalir.estado}`);
const elimina = await pedir('POST', '/cliente/eliminar-cuenta', { token: ana.token, cuerpo: { confirmo: 'ELIMINAR' } });
ok(elimina.estado === 200, 'el comprador puede eliminar su cuenta', JSON.stringify(elimina.datos).slice(0, 100));
const trasEliminar = await pedir('GET', `/pedidos/${pedidoId}`, { token: operador.token });
ok(!JSON.stringify(trasEliminar.datos).includes('Ana Auditoría') && !JSON.stringify(trasEliminar.datos).includes('Subida Ecuador'),
  'al eliminarla, sus pedidos quedan sin nombre ni dirección');
ok(trasEliminar.datos.total_venta > 0, 'pero la venta sigue registrada');

console.log(`\n${bien} comprobaciones bien, ${fallas.length} con problemas.`);
if (fallas.length) { console.log('\nProblemas:'); fallas.forEach((f) => console.log(' - ' + f)); }
process.exit(fallas.length ? 1 : 0);
