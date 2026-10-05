/**
 * Alta, cambios y baja de feriantes y repartidores, y los
 * reembolsos que quedan pendientes.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, type Fila } from '../src/db/index.ts';
import { FERIA_ID, sembrar } from '../src/db/semilla.ts';
import { limpiarYSembrar, pasarelaDeMentira, pedidoPagado } from './ayuda.ts';
import {
  crearFeriante, actualizarFeriante, crearRepartidor, actualizarRepartidor,
} from '../src/dominio/gente.ts';
import { pedirCodigo, crearSesion, verificarToken, ErrorAuth } from '../src/dominio/auth.ts';
import { crearPedido, aceptarOferta } from '../src/dominio/despacho.ts';
import { aceptarViaje } from '../src/dominio/reparto.ts';
import {
  cancelarPedido, reembolsosPendientes, reintentarReembolso, anotarReembolsoManual,
} from '../src/dominio/cancelacion.ts';
import { iniciarPago, confirmarEnDesarrollo, fijarPasarela } from '../src/dominio/pagos.ts';
import { ErrorNegocio } from '../src/dominio/estados.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { fijarPasarela(null); await cerrarDB(); });
beforeEach(async () => { await limpiarYSembrar(); fijarPasarela(null); });

const pedido = (items = [{ productoId: 'p-tomate', cantidad: 4 }]) => ({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel', clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123', lat: -33.0458, lng: -71.6197, items,
});

const rechaza = (codigo: number) => (e: unknown) => e instanceof ErrorNegocio && e.codigo === codigo;

async function entrar(telefono: string) {
  const { codigoDev } = await pedirCodigo(telefono);
  return crearSesion(telefono, codigoDev!, 'test');
}

// ------------------------------------------------------------

test('un feriante nuevo puede entrar con su teléfono y empieza en pausa', async () => {
  const f = await crearFeriante({
    nombre: 'Elena Tapia', puesto: 'Puesto 30', telefono: '9 7654 3210', rubros: ['verduras'],
  }, FERIA_ID);
  assert.equal(f.telefono, '+56976543210');

  const s = await entrar('+56 9 7654 3210');
  assert.equal(s.rol, 'feriante');
  assert.equal(s.actorId, f.id);

  // En pausa: no le llegan ofertas hasta que encienda el interruptor.
  await pedidoPagado(pedido());
  const ofertas = await consultar('SELECT id FROM ofertas WHERE feriante_id = ?', f.id);
  assert.equal(ofertas.length, 0);
});

test('no se pueden cargar dos personas con el mismo teléfono', async () => {
  // Es de José, que es feriante: tampoco puede ser de un repartidor.
  await assert.rejects(() => crearRepartidor({
    nombre: 'Otro', vehiculo: 'moto', telefono: '+56911111111',
  }), rechaza(409));
  await assert.rejects(() => crearFeriante({
    nombre: 'Otro', puesto: 'P', telefono: '+56900000009', rubros: ['frutas'],
  }, FERIA_ID), rechaza(409));
});

test('un feriante sin rubro o con datos vacíos no se guarda', async () => {
  const base = { nombre: 'Elena', puesto: 'Puesto 30', telefono: '+56976543210', rubros: ['verduras'] };
  await assert.rejects(() => crearFeriante({ ...base, rubros: [] }, FERIA_ID), rechaza(422));
  await assert.rejects(() => crearFeriante({ ...base, rubros: ['nada'] }, FERIA_ID), rechaza(422));
  await assert.rejects(() => crearFeriante({ ...base, nombre: ' ' }, FERIA_ID), rechaza(422));
  await assert.rejects(() => crearFeriante({ ...base, telefono: '123' }, FERIA_ID), ErrorAuth);
  assert.equal((await consultar(`SELECT id FROM feriantes WHERE nombre = 'Elena'`)).length, 0);
});

test('dar de baja a un feriante lo saca de la app y de las ofertas', async () => {
  const sesion = await entrar('+56911111111');
  await actualizarFeriante('f-jose', { activo: false });

  await assert.rejects(() => verificarToken(sesion.token), ErrorAuth);
  // Puede seguir entrando, pero como cliente: compra, no vende.
  assert.equal((await entrar('+56911111111')).rol, 'cliente');

  await pedidoPagado(pedido());
  const ofertas = await consultar(`SELECT id FROM ofertas WHERE feriante_id = 'f-jose'`);
  assert.equal(ofertas.length, 0);

  // Y vuelve, en pausa, si se lo reactiva.
  await actualizarFeriante('f-jose', { activo: true });
  const f = await consultarUno<Fila>(`SELECT activo, conectado FROM feriantes WHERE id = 'f-jose'`);
  assert.deepEqual([f!.activo, f!.conectado], [true, false]);
});

test('cambiar los rubros cambia qué se le ofrece', async () => {
  await actualizarFeriante('f-pedro', { rubros: ['verduras'] });   // era pescado
  await pedidoPagado(pedido());
  const ofertas = await consultar(
    `SELECT id FROM ofertas WHERE feriante_id = 'f-pedro'`);
  assert.equal(ofertas.length, 1);
});

test('cambiarle el teléfono a alguien le cierra la sesión vieja', async () => {
  const sesion = await entrar('+56900000001');
  await actualizarRepartidor('r-diego', { telefono: '+56987654321' });
  await assert.rejects(() => verificarToken(sesion.token), ErrorAuth);
  assert.equal((await entrar('+56987654321')).actorId, 'r-diego');
});

test('no se da de baja a un repartidor con un viaje en curso', async () => {
  const { pedidoId } = await pedidoPagado(pedido());
  const sub = (await consultarUno<Fila>('SELECT id FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;
  await aceptarOferta(sub.id, 'f-jose');
  const viaje = (await consultarUno<Fila>('SELECT id FROM viajes WHERE pedido_id = ?', pedidoId))!;
  await aceptarViaje(viaje.id, 'r-diego');

  await assert.rejects(() => actualizarRepartidor('r-diego', { activo: false }), rechaza(409));
});

test('en producción la base arranca sin gente de ejemplo', async () => {
  const tablas = ['feriante_rubros', 'feriantes', 'repartidores', 'operadores', 'productos', 'rubros'];
  const { ejecutar } = await import('../src/db/index.ts');
  await ejecutar(`TRUNCATE ${tablas.join(', ')} CASCADE`);

  const anterior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await sembrar();
  } finally {
    process.env.NODE_ENV = anterior;
  }
  const n = async (t: string) =>
    (await consultarUno<Fila>(`SELECT COUNT(*)::int AS n FROM ${t}`))!.n;
  assert.equal(await n('feriantes'), 0);
  assert.equal(await n('repartidores'), 0);
  assert.ok(await n('productos') > 0, 'el catálogo sí');
  assert.equal(await n('operadores'), 1, 'y el operador, que es quien carga al resto');
});

// ------------------------------------------------------------
// Reembolsos pendientes
// ------------------------------------------------------------

/** Pedido pagado y cancelado con la pasarela caída: queda por devolver. */
async function conReembolsoPendiente() {
  const falsa = pasarelaDeMentira();
  falsa.caida = true;
  fijarPasarela(falsa);
  const { pedidoId } = await crearPedido(pedido());
  const { pagoId } = await iniciarPago(pedidoId, 'c@c.cl');
  await confirmarEnDesarrollo(pagoId);
  await cancelarPedido({ pedidoId, motivo: 'sin stock' });
  assert.equal((await reembolsosPendientes()).length, 1);
  return { falsa, pagoId };
}

test('un reembolso que falló se puede reintentar', async () => {
  const { falsa, pagoId } = await conReembolsoPendiente();

  falsa.caida = false;
  const r = await reintentarReembolso(pagoId);

  assert.equal(r.solicitado, true);
  assert.equal(falsa.reembolsos[0].monto, 11300);
  assert.equal((await reembolsosPendientes()).length, 0);
});

test('lo devuelto a mano se anota y sale de la lista', async () => {
  const { falsa, pagoId } = await conReembolsoPendiente();

  await anotarReembolsoManual(pagoId, 'op-juan');

  assert.equal((await reembolsosPendientes()).length, 0);
  assert.equal(falsa.reembolsos.length, 0, 'no se le pidió nada a la pasarela');
  // Y no se puede devolver dos veces.
  await assert.rejects(() => reintentarReembolso(pagoId));
  await assert.rejects(() => anotarReembolsoManual(pagoId, 'op-juan'));
});

test('dos toques a pagar generan un solo cobro', async () => {
  const falsa = pasarelaDeMentira();
  fijarPasarela(falsa);
  const { pedidoId } = await crearPedido(pedido());

  const [a, b] = await Promise.all([
    iniciarPago(pedidoId, 'c@c.cl'), iniciarPago(pedidoId, 'c@c.cl'),
  ]);

  assert.equal(a.pagoId, b.pagoId);
  assert.equal(falsa.creados.length, 1);
  assert.equal((await consultar('SELECT id FROM pagos')).length, 1);
});
