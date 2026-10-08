/**
 * Los datos de cada persona: aceptar los términos, llevárselos,
 * irse, y que lo viejo se borre solo.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pasarelaDeMentira } from './ayuda.ts';
import { pedirCodigo, crearSesion, verificarToken, ErrorAuth } from '../src/dominio/auth.ts';
import {
  crearPedido, confirmarPago, aceptarOferta, expirarPendientes,
} from '../src/dominio/despacho.ts';
import { aceptarViaje, registrarUbicacion } from '../src/dominio/reparto.ts';
import { completarParada } from './ayuda.ts';
import { cancelarPedido } from '../src/dominio/cancelacion.ts';
import { postular } from '../src/dominio/gente.ts';
import { iniciarPago, confirmarEnDesarrollo, fijarPasarela } from '../src/dominio/pagos.ts';
import {
  textosLegales, terminosPendientes, aceptarTerminos, datosDelCliente,
  eliminarCuentaCliente, limpiarDatosViejos,
} from '../src/dominio/privacidad.ts';
import { paraElRegistro } from '../src/sms.ts';
import { ErrorNegocio } from '../src/dominio/estados.ts';
import { CONFIG } from '../src/config.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { fijarPasarela(null); await cerrarDB(); });
beforeEach(async () => { await limpiarYSembrar(); fijarPasarela(null); });

const CAMILA = '+56987654321';

async function entrar(telefono: string) {
  const { codigoDev } = await pedirCodigo(telefono);
  return crearSesion(telefono, codigoDev!, 'test');
}

const pedidoDe = (clienteId: string) => crearPedido({
  feriaId: FERIA_ID, clienteId,
  clienteNombre: 'Camila Rojas', clienteTelefono: CAMILA, clienteEmail: 'camila@correo.cl',
  direccion: 'Subida Ecuador 123', lat: -33.0458, lng: -71.6197,
  notas: 'Timbre roto', items: [{ productoId: 'p-tomate', cantidad: 4 }],
});

/** Un pedido de la clienta, entregado de punta a punta. */
async function pedidoEntregado(clienteId: string) {
  const { pedidoId } = await pedidoDe(clienteId);
  await confirmarPago(pedidoId);
  const sub = (await consultarUno<Fila>('SELECT id FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;
  await aceptarOferta(sub.id, 'f-jose');
  const viaje = (await consultarUno<Fila>('SELECT id FROM viajes WHERE pedido_id = ?', pedidoId))!;
  await aceptarViaje(viaje.id, 'r-diego');
  for (const p of await consultar<Fila>(
    'SELECT id FROM paradas WHERE viaje_id = ? ORDER BY orden', viaje.id)) {
    await completarParada(p.id, 'r-diego');
  }
  return pedidoId;
}

const rechaza = (codigo: number) => (e: unknown) => e instanceof ErrorNegocio && e.codigo === codigo;

// ------------------------------------------------------------
// Términos
// ------------------------------------------------------------

test('los términos se aceptan una vez por versión y queda registrado', async () => {
  const s = await entrar(CAMILA);
  assert.equal(await terminosPendientes(s.actorId), true);

  await assert.rejects(() => aceptarTerminos(s.actorId, 'cliente', 'una-versión-vieja'), rechaza(409));
  await aceptarTerminos(s.actorId, 'cliente', CONFIG.legal.version);
  await aceptarTerminos(s.actorId, 'cliente', CONFIG.legal.version);   // dos toques

  assert.equal(await terminosPendientes(s.actorId), false);
  const filas = await consultar<Fila>('SELECT * FROM aceptaciones WHERE actor_id = ?', s.actorId);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].rol, 'cliente');
});

test('los textos legales existen y avisan qué datos del proveedor faltan', () => {
  const t = textosLegales();
  assert.ok(t.terminos.length > 2000 && t.privacidad.length > 2000);
  // Sin las variables LEGAL_* no se pueden publicar: la ley exige
  // identificar al proveedor.
  assert.equal(t.borrador, true);
  assert.ok(t.faltan.includes('RUT') && t.faltan.includes('razón social'));
  assert.match(t.terminos, /\[por completar: RUT\]/);
  // Lo que no depende de esas variables sí queda resuelto.
  assert.doesNotMatch(t.terminos + t.privacidad, /\{\{/);
  // Lo que la ley chilena obliga a informar al consumidor.
  for (const exigido of [/retracto/i, /Garantía legal/, /SERNAC/, /19\.496/, /boleta/i]) {
    assert.match(t.terminos, exigido);
  }
  for (const exigido of [/19\.628/, /21\.719/, /rectificar/i, /supresión/i, /portabilidad/i, /Plazos de conservación/]) {
    assert.match(t.privacidad, exigido);
  }
});

// ------------------------------------------------------------
// Llevarse los datos
// ------------------------------------------------------------

test('la copia de mis datos trae lo mío y ningún costo interno', async () => {
  const s = await entrar(CAMILA);
  await pedidoEntregado(s.actorId);

  const copia = await datosDelCliente(s.actorId);
  assert.equal(copia.cuenta.telefono, CAMILA);
  assert.equal(copia.pedidos.length, 1);
  assert.equal(copia.pedidos[0].direccion, 'Subida Ecuador 123');
  assert.equal(copia.pedidos[0].productos[0].nombre, 'Tomate');

  const texto = JSON.stringify(copia);
  assert.ok(!texto.includes('precio_costo') && !texto.includes('monto_feriante'));
  assert.ok(!texto.includes('token_hash') && !texto.includes('google_sub'));
});

// ------------------------------------------------------------
// Irse
// ------------------------------------------------------------

test('eliminar la cuenta borra los datos personales y conserva la venta sin nombre', async () => {
  const s = await entrar(CAMILA);
  const pedidoId = await pedidoEntregado(s.actorId);
  await aceptarTerminos(s.actorId, 'cliente', CONFIG.legal.version);

  await eliminarCuentaCliente(s.actorId);

  assert.equal((await consultar('SELECT id FROM clientes')).length, 0);
  await assert.rejects(() => verificarToken(s.token), ErrorAuth);

  // La venta sigue —hay que poder dar cuenta de ella— pero ya no dice de quién era.
  const p = (await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId))!;
  assert.equal(p.total_venta, 4 * 2200 + CONFIG.despacho.costo);
  assert.equal(p.estado, 'ENTREGADO');
  assert.equal(p.cliente_id, null);

  // En ninguna tabla queda su nombre, su teléfono, su correo ni su dirección.
  const tablas = await consultar<{ nombre: string }>(
    `SELECT tablename AS nombre FROM pg_tables WHERE schemaname = 'public'`);
  for (const { nombre } of tablas) {
    const todo = JSON.stringify(await consultar(`SELECT * FROM "${nombre}"`));
    for (const dato of ['Camila', '987654321', 'camila@correo.cl', 'Subida Ecuador', 'Timbre roto']) {
      assert.ok(!todo.includes(dato), `«${dato}» sigue en la tabla ${nombre}`);
    }
  }

  // A José se le sigue debiendo lo que entregó.
  const jose = await consultarUno<Fila>(
    `SELECT monto_feriante FROM sub_pedidos WHERE pedido_id = ?`, pedidoId);
  assert.equal(jose!.monto_feriante, 4 * 1500);
});

test('quien eliminó su cuenta puede volver, como alguien nuevo', async () => {
  const s = await entrar(CAMILA);
  await eliminarCuentaCliente(s.actorId);
  const otra = await entrar(CAMILA);
  assert.notEqual(otra.actorId, s.actorId);
  assert.deepEqual((await datosDelCliente(otra.actorId)).pedidos, []);
});

test('con un pedido en curso no se puede eliminar la cuenta', async () => {
  const s = await entrar(CAMILA);
  const { pedidoId } = await pedidoDe(s.actorId);
  await confirmarPago(pedidoId);

  await assert.rejects(() => eliminarCuentaCliente(s.actorId), rechaza(409));
  assert.equal((await consultar('SELECT id FROM clientes')).length, 1);
});

test('con una devolución pendiente tampoco: hay que saber a quién devolverle', async () => {
  const falsa = pasarelaDeMentira();
  falsa.caida = true;
  fijarPasarela(falsa);
  const s = await entrar(CAMILA);
  const { pedidoId } = await pedidoDe(s.actorId);
  const { pagoId } = await iniciarPago(pedidoId, 'camila@correo.cl');
  await confirmarEnDesarrollo(pagoId);
  await cancelarPedido({ pedidoId, motivo: 'sin stock' });

  await assert.rejects(() => eliminarCuentaCliente(s.actorId), rechaza(409));
});

test('al irse, su solicitud para vender que nadie aprobó también se borra', async () => {
  const s = await entrar(CAMILA);
  await postular(CAMILA, { tipo: 'feriante', nombre: 'Camila Rojas', puesto: 'P9', rubros: ['frutas'] }, FERIA_ID);
  await eliminarCuentaCliente(s.actorId);
  assert.equal((await consultar('SELECT id FROM feriantes WHERE telefono = ?', CAMILA)).length, 0);
});

// ------------------------------------------------------------
// Lo viejo se borra solo
// ------------------------------------------------------------

test('la ubicación de los repartidores no se guarda para siempre', async () => {
  const s = await entrar(CAMILA);
  const { pedidoId } = await pedidoDe(s.actorId);
  await confirmarPago(pedidoId);
  const sub = (await consultarUno<Fila>('SELECT id FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;
  await aceptarOferta(sub.id, 'f-jose');
  const viaje = (await consultarUno<Fila>('SELECT id FROM viajes WHERE pedido_id = ?', pedidoId))!;
  await aceptarViaje(viaje.id, 'r-diego');
  await registrarUbicacion('r-diego', -33.04, -71.61);
  await registrarUbicacion('r-diego', -33.05, -71.62);

  // Reciente: se conserva.
  assert.equal((await limpiarDatosViejos()).ubicaciones, 0);

  await ejecutar(`UPDATE ubicaciones SET at = now() - make_interval(days => ?)
                   WHERE lat = -33.04`, CONFIG.retencion.ubicacionesDias + 1);
  await ejecutar(`UPDATE repartidores SET ubicacion_at = now() - interval '2 days'`);
  const r = await limpiarDatosViejos();
  assert.equal(r.ubicaciones, 1);
  assert.equal((await consultar('SELECT id FROM ubicaciones')).length, 1);
  const diego = await consultarUno<Fila>(`SELECT lat FROM repartidores WHERE id = 'r-diego'`);
  assert.equal(diego!.lat, null, 'tampoco su último punto conocido');
});

test('los códigos viejos y los carros que nunca se pagaron se borran', async () => {
  const s = await entrar(CAMILA);
  const { pedidoId } = await pedidoDe(s.actorId);
  await ejecutar(`UPDATE pedidos SET creado_at = now() - interval '40 days' WHERE id = ?`, pedidoId);
  await expirarPendientes();
  await ejecutar(`UPDATE codigos_acceso SET creado_at = now() - interval '3 days'`);

  const r = await limpiarDatosViejos();
  assert.equal(r.pedidosSinPagar, 1);
  assert.ok(r.codigos >= 1);
  assert.equal((await consultar('SELECT id FROM pedidos')).length, 0);
  assert.equal((await consultar('SELECT id FROM items')).length, 0, 'con todo lo suyo');
});

test('una venta de verdad no se borra por vieja', async () => {
  const s = await entrar(CAMILA);
  const pedidoId = await pedidoEntregado(s.actorId);
  await ejecutar(`UPDATE pedidos SET creado_at = now() - interval '400 days' WHERE id = ?`, pedidoId);
  await limpiarDatosViejos();
  assert.equal((await consultar('SELECT id FROM pedidos')).length, 1);
});

test('en producción el código de ingreso no queda escrito en el registro', () => {
  const anterior = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(paraElRegistro('Feria: tu código es 418757. Vence en 5 minutos.'),
      'Feria: tu código es ••••••. Vence en 5 minutos.');
    process.env.NODE_ENV = 'development';
    assert.match(paraElRegistro('tu código es 418757'), /418757/);
  } finally {
    process.env.NODE_ENV = anterior;
  }
});
