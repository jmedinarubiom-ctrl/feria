/**
 * El servidor de punta a punta, por HTTP.
 *
 * El resto de los tests llama al dominio directo. Estos bugs vivían
 * justo en la capa que eso se salta: el ruteo, qué campos se aceptan
 * del cuerpo, y qué se le muestra a quién.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';

import { cerrarDB } from '../src/db/index.ts';
import { iniciar } from '../src/http/servidor.ts';
import { limpiarYSembrar } from './ayuda.ts';
import { fijarPasarela } from '../src/dominio/pagos.ts';
import { olvidarTodo } from '../src/http/freno.ts';
import { CONFIG } from '../src/config.ts';

let servidor: Server;
let base: string;

before(async () => {
  servidor = await iniciar(0, { memoria: true });
  base = `http://localhost:${(servidor.address() as AddressInfo).port}`;
});

after(async () => {
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await cerrarDB();
});

beforeEach(async () => {
  await limpiarYSembrar();
  fijarPasarela(null);
  olvidarTodo();
});

const pedir = async (metodo: string, camino: string, cuerpo?: unknown, token?: string) => {
  const r = await fetch(base + camino, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo === undefined ? undefined
      : typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let json: any = null;
  try { json = JSON.parse(texto); } catch { /* no era JSON */ }
  return { estado: r.status, json, texto, tipo: r.headers.get('content-type') ?? '' };
};

const PEDIDO = {
  clienteNombre: 'Camila Rojas',
  clienteTelefono: '+56 9 8765 4321',
  direccion: 'Subida Ecuador 123',
  lat: -33.0458, lng: -71.6197,
  items: [{ productoId: 'p-tomate', cantidad: 4 }],
};

const CLIENTA = '+56987654321';

/** Entra con un teléfono y devuelve su token. Un número nuevo queda como cliente. */
async function entrar(telefono: string): Promise<string> {
  const c = await pedir('POST', '/auth/codigo', { telefono });
  const s = await pedir('POST', '/auth/sesion', { telefono, codigo: c.json.codigoDev });
  assert.equal(s.estado, 200);
  return s.json.token;
}

// ------------------------------------------------------------
// El servidor no se cae
// ------------------------------------------------------------

test('una dirección mal escrita devuelve 400 y el servidor sigue vivo', async () => {
  const r = await pedir('GET', '/pedidos/%E0%A4%A');
  assert.equal(r.estado, 400);
  assert.equal((await pedir('GET', '/salud')).estado, 200);
});

test('un cuerpo JSON que no es un objeto se rechaza sin romper nada', async () => {
  for (const cuerpo of ['null', '7', '[]', '{mal']) {
    const r = await pedir('POST', '/auth/codigo', cuerpo);
    assert.equal(r.estado, 400, `con ${cuerpo}`);
  }
  assert.equal((await pedir('GET', '/salud')).estado, 200);
});

test('una fecha que no existe se rechaza antes de llegar a la base', async () => {
  const token = await entrar('+56900000009');
  const r = await pedir('GET', '/operador/tablero?dia=2026-13-45', undefined, token);
  assert.equal(r.estado, 422);
});

// ------------------------------------------------------------
// Comprar
// ------------------------------------------------------------

test('para pedir hay que entrar con el teléfono; un número nuevo queda como cliente', async () => {
  assert.equal((await pedir('POST', '/pedidos', PEDIDO)).estado, 401);

  const token = await entrar(CLIENTA);
  const yo = await pedir('GET', '/auth/yo', undefined, token);
  assert.equal(yo.json.rol, 'cliente');
  assert.equal(yo.json.perfil.telefono, CLIENTA);

  const r = await pedir('POST', '/pedidos', PEDIDO, token);
  assert.equal(r.estado, 200, r.texto);
  assert.ok(r.json.pedidoId);

  // Los datos de entrega quedan para la próxima compra.
  const despues = await pedir('GET', '/auth/yo', undefined, token);
  assert.equal(despues.json.perfil.nombre, 'Camila Rojas');
  assert.equal(despues.json.perfil.direccion, 'Subida Ecuador 123');
});

test('un feriante no puede hacer pedidos con su sesión de feriante', async () => {
  const feriante = await entrar('+56911111111');
  assert.equal((await pedir('POST', '/pedidos', PEDIDO, feriante)).estado, 403);
});

test('el pedido queda con el teléfono confirmado si no se deja otro de contacto', async () => {
  const token = await entrar(CLIENTA);
  const r = await pedir('POST', '/pedidos', { ...PEDIDO, clienteTelefono: '' }, token);
  const p = (await pedir('GET', `/pedidos/${r.json.pedidoId}`, undefined, token)).json;
  assert.equal(p.cliente_telefono, CLIENTA);
});

test('lo que el cliente mande de más en el pedido se ignora', async () => {
  const token = await entrar(CLIENTA);
  const r = await pedir('POST', '/pedidos', {
    ...PEDIDO, costoDespacho: -8000, total_venta: 1, estado: 'PAGADO',
    clienteId: 'otro',
  }, token);
  assert.equal(r.estado, 200, r.texto);
  const p = (await pedir('GET', `/pedidos/${r.json.pedidoId}`, undefined, token)).json;
  assert.equal(p.costo_despacho, CONFIG.despacho.costo);
  assert.equal(p.total_venta, 4 * 2200 + CONFIG.despacho.costo);
  assert.equal(p.feria_id, 'feria-av-argentina');
  assert.equal(p.estado, 'PENDIENTE_PAGO');
});

test('un pedido mal armado es un 422, no un error interno', async () => {
  const casos: Array<[string, unknown]> = [
    ['sin items', { ...PEDIDO, items: undefined }],
    ['items vacío', { ...PEDIDO, items: [] }],
    ['cantidad absurda', { ...PEDIDO, items: [{ productoId: 'p-tomate', cantidad: 1e9 }] }],
    ['cantidad con decimales', { ...PEDIDO, items: [{ productoId: 'p-tomate', cantidad: 1.5 }] }],
    ['sin nombre', { ...PEDIDO, clienteNombre: '  ' }],
    ['sin dirección', { ...PEDIDO, direccion: undefined }],
    ['producto inventado', { ...PEDIDO, items: [{ productoId: 'p-nada', cantidad: 5 }] }],
  ];
  const token = await entrar(CLIENTA);
  for (const [nombre, cuerpo] of casos) {
    const r = await pedir('POST', '/pedidos', cuerpo, token);
    assert.equal(r.estado, 422, `${nombre}: ${r.texto}`);
  }
});

// ------------------------------------------------------------
// Qué ve cada uno
// ------------------------------------------------------------

test('el catálogo público no muestra lo que se le paga al feriante', async () => {
  const r = await pedir('GET', '/catalogo');
  assert.equal(r.estado, 200);
  assert.ok(r.json[0].productos.length > 0);
  assert.ok(!r.texto.includes('precio_costo'));
});

test('el seguimiento del cliente no trae costos; el del operador sí', async () => {
  const clienta = await entrar(CLIENTA);
  const { json: creado } = await pedir('POST', '/pedidos', PEDIDO, clienta);

  const publico = await pedir('GET', `/pedidos/${creado.pedidoId}`, undefined, clienta);
  assert.equal(publico.estado, 200);
  assert.ok(!publico.texto.includes('precio_costo'));
  assert.ok(!publico.texto.includes('monto_feriante'));
  assert.equal(publico.json.subPedidos[0].items[0].nombre, 'Tomate');

  const token = await entrar('+56900000009');
  const interno = await pedir('GET', `/pedidos/${creado.pedidoId}`, undefined, token);
  assert.equal(interno.json.subPedidos[0].monto_feriante, 4 * 1500);
});

test('un pedido lo ve quien lo hizo y el operador, nadie más', async () => {
  const clienta = await entrar(CLIENTA);
  const { json: creado } = await pedir('POST', '/pedidos', PEDIDO, clienta);

  assert.equal((await pedir('GET', `/pedidos/${creado.pedidoId}`)).estado, 401);
  // Otra clienta, aunque consiga el id.
  const otra = await entrar('+56912345678');
  assert.equal((await pedir('GET', `/pedidos/${creado.pedidoId}`, undefined, otra)).estado, 404);
  // Y ni la dueña lo busca por número: eso es del operador.
  assert.equal((await pedir('GET', `/pedidos/${creado.numero}`, undefined, clienta)).estado, 404);

  const mios = await pedir('GET', '/cliente/pedidos', undefined, clienta);
  assert.deepEqual(mios.json.pedidos, [creado.pedidoId]);
  assert.deepEqual((await pedir('GET', '/cliente/pedidos', undefined, otra)).json.pedidos, []);

  // Un feriante tampoco: no tiene por qué ver la dirección del cliente.
  const feriante = await entrar('+56911111111');
  assert.equal((await pedir('GET', `/pedidos/${creado.numero}`, undefined, feriante)).estado, 404);

  const operador = await entrar('+56900000009');
  const r = await pedir('GET', `/pedidos/${creado.numero}`, undefined, operador);
  assert.equal(r.estado, 200);
  assert.equal(r.json.id, creado.pedidoId);
});

test('volver de la pasarela muestra una página, no JSON', async () => {
  const r = await pedir('GET', '/pagos/retorno');
  assert.equal(r.estado, 200);
  assert.match(r.tipo, /text\/html/);
  assert.match(r.texto, /feria:\/\/pago/);
});

// ------------------------------------------------------------
// WebSocket
// ------------------------------------------------------------

const abrir = (consulta: string) => new Promise<{ ws: WebSocket; cerrado: Promise<number> }>(
  (resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws?' + consulta);
    const cerrado = new Promise<number>((r) => ws.on('close', (codigo) => r(codigo)));
    ws.on('open', () => resolve({ ws, cerrado }));
    ws.on('error', reject);
  });

test('nadie escucha como operador sin sesión', async () => {
  const { cerrado } = await abrir('rol=operador&id=op-juan');
  assert.equal(await cerrado, 1008);

  const otro = await abrir('rol=feriante&id=f-jose&token=inventado');
  assert.equal(await otro.cerrado, 1008);
});

test('con su sesión, el operador recibe los avisos', async () => {
  const token = await entrar('+56900000009');
  // Declara ser feriante: lo que vale es lo que dice el token.
  const { ws } = await abrir(`rol=feriante&id=f-jose&token=${token}`);
  await new Promise((r) => setTimeout(r, 100));

  const aviso = new Promise<any>((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
  const clienta = await entrar(CLIENTA);
  const { json: creado } = await pedir('POST', '/pedidos', PEDIDO, clienta);
  const pago = await pedir('POST', '/pagos/iniciar', { pedidoId: creado.pedidoId }, clienta);
  await pedir('POST', `/dev/pagar/${pago.json.pagoId}`);

  const m = await aviso;
  assert.equal(m.pedidoId, creado.pedidoId);
  ws.close();
});

// ------------------------------------------------------------
// Detrás del túnel
// ------------------------------------------------------------

test('en desarrollo local el código de ingreso se devuelve; es el modo normal', async () => {
  const r = await pedir('POST', '/auth/codigo', { telefono: '+56900000009' });
  assert.match(r.json.codigoDev, /^\d{6}$/);
});

// ------------------------------------------------------------
// Pedir ser feriante o repartidor
// ------------------------------------------------------------

test('quien pide ser feriante espera la aprobación y después entra como feriante', async () => {
  const NUEVO = '+56955512345';
  const cliente = await entrar(NUEVO);

  const pedido = await pedir('POST', '/cliente/postular', {
    tipo: 'feriante', nombre: 'Elena Tapia', puesto: 'Puesto 30', rubros: ['verduras'],
    telefono: '+56911111111',   // no se le cree: vale el de su sesión
  }, cliente);
  assert.equal(pedido.estado, 200, pedido.texto);
  assert.equal(pedido.json.estado, 'pendiente');

  // Mientras tanto sigue siendo cliente, y no puede postular dos veces.
  assert.equal((await pedir('GET', '/auth/yo', undefined, cliente)).json.solicitud.estado, 'pendiente');
  assert.equal((await pedir('POST', '/cliente/postular',
    { tipo: 'repartidor', nombre: 'Elena', vehiculo: 'auto' }, cliente)).estado, 409);
  assert.equal((await pedir('GET', '/auth/yo', undefined, await entrar(NUEVO))).json.rol, 'cliente');

  // El operador la ve y la aprueba.
  const operador = await entrar('+56900000009');
  const gente = (await pedir('GET', '/operador/gente', undefined, operador)).json;
  const solicitud = gente.feriantes.find((f: any) => f.pendiente);
  assert.equal(solicitud.nombre, 'Elena Tapia');
  assert.equal(solicitud.telefono, NUEVO);
  const ok = await pedir('POST', `/operador/feriantes/${solicitud.id}`, { activo: true }, operador);
  assert.equal(ok.estado, 200, ok.texto);

  // Su sesión de cliente se cerró: al entrar de nuevo ya es feriante.
  assert.equal((await pedir('GET', '/auth/yo', undefined, cliente)).estado, 401);
  const yo = await pedir('GET', '/auth/yo', undefined, await entrar(NUEVO));
  assert.equal(yo.json.rol, 'feriante');
  assert.equal(yo.json.actorId, solicitud.id);
});

test('una solicitud rechazada no deja entrar como repartidor', async () => {
  const NUEVO = '+56955598765';
  const cliente = await entrar(NUEVO);
  await pedir('POST', '/cliente/postular',
    { tipo: 'repartidor', nombre: 'Tomás Rey', vehiculo: 'moto' }, cliente);

  const operador = await entrar('+56900000009');
  const gente = (await pedir('GET', '/operador/gente', undefined, operador)).json;
  const solicitud = gente.repartidores.find((r: any) => r.pendiente);
  await pedir('POST', `/operador/repartidores/${solicitud.id}`, { pendiente: false }, operador);

  const yo = await pedir('GET', '/auth/yo', undefined, await entrar(NUEVO));
  assert.equal(yo.json.rol, 'cliente');
  assert.equal(yo.json.solicitud.estado, 'cerrada');
});

// ------------------------------------------------------------
// El perfil del cliente nuevo
// ------------------------------------------------------------

test('un cliente nuevo parte sin perfil, lo crea, y sus pedidos usan ese teléfono', async () => {
  // Entra con correo: no hay número confirmado.
  const c = await pedir('POST', '/auth/codigo', { correo: 'nueva@feria.test' });
  const s = await pedir('POST', '/auth/sesion', { correo: 'nueva@feria.test', codigo: c.json.codigoDev });
  const token = s.json.token;

  const antes = (await pedir('GET', '/auth/yo', undefined, token)).json.perfil;
  assert.equal(antes.nombre, '', 'recién registrada: sin nombre');
  assert.equal(antes.telefono_contacto, null);

  const guardado = await pedir('POST', '/cliente/perfil',
    { nombre: 'Rosa Díaz', telefonoContacto: '+56 9 7777 1234' }, token);
  assert.equal(guardado.estado, 200);
  const yo = (await pedir('GET', '/auth/yo', undefined, token)).json.perfil;
  assert.equal(yo.nombre, 'Rosa Díaz');
  assert.equal(yo.telefono_contacto, '+56 9 7777 1234');

  // Guardar otra cosa después no le borra el teléfono.
  await pedir('POST', '/cliente/perfil', { nombre: 'Rosa Díaz', direccion: 'Calle 1' }, token);
  assert.equal((await pedir('GET', '/auth/yo', undefined, token)).json.perfil.telefono_contacto,
    '+56 9 7777 1234');

  // Y el pedido sale con ese número aunque la app no lo mande.
  const p = await pedir('POST', '/pedidos', { ...PEDIDO, clienteTelefono: '' }, token);
  assert.equal(p.estado, 200, p.texto);
  const visto = (await pedir('GET', `/pedidos/${p.json.pedidoId}`, undefined, token)).json;
  assert.equal(visto.cliente_telefono, '+56 9 7777 1234');
});

// ------------------------------------------------------------
// El punto exacto de entrega
// ------------------------------------------------------------

test('el punto que marca el cliente se guarda tal cual, con su margen', async () => {
  const token = await entrar(CLIENTA);
  const r = await pedir('POST', '/pedidos', {
    ...PEDIDO, puntoMarcado: true, lat: -33.047238, lng: -71.612688, precisionM: 7.6,
  }, token);
  assert.equal(r.estado, 200, r.texto);

  const p = (await pedir('GET', `/pedidos/${r.json.pedidoId}`, undefined, token)).json;
  assert.equal(p.lat, -33.047238);
  assert.equal(p.lng, -71.612688);
  assert.equal(p.geo_precision, 'marcado por el cliente (±8 m)');
});

test('ajustado a mano en el mapa no lleva margen de GPS', async () => {
  const token = await entrar(CLIENTA);
  const r = await pedir('POST', '/pedidos',
    { ...PEDIDO, puntoMarcado: true, lat: -33.0301, lng: -71.5512 }, token);
  const p = (await pedir('GET', `/pedidos/${r.json.pedidoId}`, undefined, token)).json;
  assert.equal(p.geo_precision, 'marcado por el cliente');
});

test('un punto marcado fuera de la región se rechaza en vez de mandar al repartidor ahí', async () => {
  const token = await entrar(CLIENTA);
  const casos: Array<[string, number, number]> = [
    ['el GPS sin señal', 0, 0], ['Santiago', -33.45, -70.66], ['sin número', NaN, NaN],
    ['Buenos Aires', -34.6, -58.4],
  ];
  for (const [que, lat, lng] of casos) {
    const r = await pedir('POST', '/pedidos', { ...PEDIDO, puntoMarcado: true, lat, lng }, token);
    assert.equal(r.estado, 422, que);
  }
});

test('el repartidor ve si el punto es exacto o aproximado', async () => {
  const token = await entrar(CLIENTA);
  const r = await pedir('POST', '/pedidos',
    { ...PEDIDO, puntoMarcado: true, lat: -33.0472, lng: -71.6127, precisionM: 5 }, token);
  const pago = await pedir('POST', '/pagos/iniciar', { pedidoId: r.json.pedidoId }, token);
  await pedir('POST', `/dev/pagar/${pago.json.pagoId}`);

  const jose = await entrar('+56911111111');
  const tablero = (await pedir('GET', '/feriante/tablero', undefined, jose)).json;
  await pedir('POST', `/subpedidos/${tablero.ofertas[0].sub_pedido_id}/aceptar`, {}, jose);

  const diego = await entrar('+56900000001');
  const disp = (await pedir('GET', '/repartidor/tablero', undefined, diego)).json.disponibles;
  await pedir('POST', `/viajes/${disp[0].id}/aceptar`, {}, diego);
  const viaje = (await pedir('GET', '/repartidor/tablero', undefined, diego)).json.viajeActivo;

  assert.equal(viaje.geo_precision, 'marcado por el cliente (±5 m)');
  const entrega = viaje.paradas.find((x: any) => x.tipo === 'ENTREGA');
  assert.equal(entrega.lat, -33.0472, 'la parada de entrega lleva al punto marcado');
  assert.equal(entrega.lng, -71.6127);
});

test('el mapa para elegir el punto se abre en la comuna de la feria del cliente', async () => {
  const token = await entrar(CLIENTA);
  assert.equal((await pedir('GET', '/cliente/ubicar?direccion=Calle%201')).estado, 401);

  // En los tests no se sale al buscador: cae al centro de la comuna.
  const valpo = await pedir('GET', '/cliente/ubicar?direccion=Subida%20Ecuador%20123', undefined, token);
  assert.deepEqual(valpo.json, { lat: -33.0472, lng: -71.6127, encontrada: false });

  const vina = await pedir('GET',
    '/cliente/ubicar?direccion=Calle%20Valpara%C3%ADso%20500&feria=feria-marga-marga', undefined, token);
  assert.equal(vina.json.lat, -33.0245);
  assert.equal(vina.json.encontrada, false);
});
