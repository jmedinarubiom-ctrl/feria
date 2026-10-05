import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pasarelaDeMentira } from './ayuda.ts';
import { crearPedido, expirarPendientes } from '../src/dominio/despacho.ts';
import {
  iniciarPago, confirmarDesdePasarela, fijarPasarela, ErrorPago,
} from '../src/dominio/pagos.ts';
import { CONFIG } from '../src/config.ts';

let falsa = pasarelaDeMentira();

before(async () => { await abrirDB({ memoria: true }); });

after(async () => {
  fijarPasarela(null);
  await cerrarDB();
});

beforeEach(async () => {
  await limpiarYSembrar();
  falsa = pasarelaDeMentira();
  fijarPasarela(falsa);
});

const armarPedido = () => crearPedido({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items: [{ productoId: 'p-tomate', cantidad: 4 }],
});

/** Lo que responde la pasarela cuando el pago salió bien. */
const pagado = (ordenComercio: string, monto = 11300, medio = 'Transferencia') => ({
  pagado: true, ordenComercio, monto, medio,
});

// ============================================================

test('un pedido nuevo no se despacha hasta que se paga', async () => {
  const { pedidoId } = await armarPedido();

  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'PENDIENTE_PAGO');

  // Nadie preparando mercadería que nadie pagó.
  const ofertas = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM ofertas');
  assert.equal(ofertas!.n, 0, 'no se ofreció a ningún feriante');

  const subs = await consultar<Fila>('SELECT estado FROM sub_pedidos WHERE pedido_id = ?', pedidoId);
  assert.ok(subs.every((s) => s.estado === 'PENDIENTE'));
});

test('iniciar el pago devuelve la URL de la pasarela y cobra el total', async () => {
  const { pedidoId, numero } = await armarPedido();
  const r = await iniciarPago(pedidoId, 'cliente@correo.cl');

  assert.ok(r.url!.startsWith('https://pasarela.test/pagar?token='));
  assert.equal(falsa.creados.length, 1);
  assert.equal(falsa.creados[0].monto, 11300, 'cobra el total con despacho');
  assert.equal(falsa.creados[0].email, 'cliente@correo.cl');
  assert.match(falsa.creados[0].ordenComercio, new RegExp(`^feria-${numero}-`));
});

test('volver atrás en la app no genera dos cobros', async () => {
  const { pedidoId } = await armarPedido();
  const a = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const b = await iniciarPago(pedidoId, 'cliente@correo.cl');

  assert.equal(a.url, b.url, 'se reusa la misma orden de pago');
  assert.equal(falsa.creados.length, 1, 'a la pasarela se le pidió una sola vez');
});

test('cuando la pasarela confirma, recién ahí sale a la feria', async () => {
  const { pedidoId } = await armarPedido();
  const { pagoId } = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);

  falsa.estado = pagado(pago!.orden_comercio);
  const r = await confirmarDesdePasarela(pago!.referencia_externa);

  assert.equal(r.pagado, true);
  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'DESPACHANDO', 'ahora sí se despacha');

  const ofertas = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM ofertas');
  assert.ok(ofertas!.n > 0, 'les llegó a los feriantes');

  const guardado = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  assert.equal(guardado!.estado, 'PAGADO');
  assert.equal(guardado!.medio, 'Transferencia');
});

test('un aviso repetido de la pasarela no despacha dos veces', async () => {
  const { pedidoId } = await armarPedido();
  const { pagoId } = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  falsa.estado = pagado(pago!.orden_comercio);

  await confirmarDesdePasarela(pago!.referencia_externa);
  const ofertasTras1 = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM ofertas');

  // Las pasarelas reintentan sus avisos durante horas.
  await confirmarDesdePasarela(pago!.referencia_externa);
  await confirmarDesdePasarela(pago!.referencia_externa);

  const ofertasTras3 = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM ofertas');
  assert.equal(ofertasTras3!.n, ofertasTras1!.n, 'no se volvió a ofertar');
});

test('si el monto pagado no coincide, no se despacha nada', async () => {
  const { pedidoId } = await armarPedido();
  const { pagoId } = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);

  // Alguien manipuló el monto en el camino.
  falsa.estado = pagado(pago!.orden_comercio, 100);
  await assert.rejects(() => confirmarDesdePasarela(pago!.referencia_externa), ErrorPago);

  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'PENDIENTE_PAGO', 'el pedido no avanza');
});

test('un pago rechazado deja el pedido sin despachar', async () => {
  const { pedidoId } = await armarPedido();
  const { pagoId } = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);

  falsa.estado = { pagado: false, cerrado: true, ordenComercio: pago!.orden_comercio, monto: 11300 };
  const r = await confirmarDesdePasarela(pago!.referencia_externa);

  assert.equal(r.pagado, false);
  const guardado = await consultarUno<Fila>('SELECT estado FROM pagos WHERE id = ?', pagoId);
  assert.equal(guardado!.estado, 'RECHAZADO');
  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'PENDIENTE_PAGO');
});

test('un aviso con un token inventado no confirma nada', async () => {
  await armarPedido();
  falsa.estado = { pagado: true, ordenComercio: 'feria-9999-falsa', monto: 11300 };

  // El callback es HTTP abierto: cualquiera puede llamarlo.
  await assert.rejects(() => confirmarDesdePasarela('token-inventado'), ErrorPago);
});

test('el pedido de quien abandonó el checkout expira solo', async () => {
  const { pedidoId } = await armarPedido();
  await iniciarPago(pedidoId, 'cliente@correo.cl');

  assert.equal(await expirarPendientes(), 0, 'todavía no');

  await ejecutar(
    `UPDATE pedidos SET creado_at = now() - make_interval(mins => ?) WHERE id = ?`,
    CONFIG.minutosParaPagar + 1, pedidoId);

  assert.equal(await expirarPendientes(), 1);
  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'EXPIRADO');
});

test('no se puede pagar un pedido que ya expiró', async () => {
  const { pedidoId } = await armarPedido();
  await ejecutar(
    `UPDATE pedidos SET creado_at = now() - make_interval(mins => ?) WHERE id = ?`,
    CONFIG.minutosParaPagar + 1, pedidoId);
  await expirarPendientes();

  await assert.rejects(
    () => iniciarPago(pedidoId, 'cliente@correo.cl'),
    (e: ErrorPago) => e.codigo === 410);
});

test('sin pasarela configurada, en producción no se cobra gratis', async () => {
  fijarPasarela(null);
  const anterior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { pedidoId } = await armarPedido();
    await assert.rejects(
      () => iniciarPago(pedidoId, 'cliente@correo.cl'),
      (e: ErrorPago) => e.codigo === 503);
  } finally {
    process.env.NODE_ENV = anterior;
    fijarPasarela(falsa);
  }
});
