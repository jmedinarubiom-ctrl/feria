/**
 * Bugs encontrados en la auditoría.
 *
 * Cada test describe el comportamiento CORRECTO. Se escribieron
 * fallando a propósito, para probar que el bug era real antes de
 * tocar nada.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pasarelaDeMentira, pedidoPagado } from './ayuda.ts';
import { crearPedido, aceptarOferta, marcarListo } from '../src/dominio/despacho.ts';
import { aceptarViaje, completarParada, ViajeNoDisponible } from '../src/dominio/reparto.ts';
import { cancelarPedido } from '../src/dominio/cancelacion.ts';
import { calcularLiquidacion, marcarPagado } from '../src/dominio/liquidaciones.ts';
import { iniciarPago, confirmarEnDesarrollo, fijarPasarela } from '../src/dominio/pagos.ts';
import { enviarPush, fijarTransporte, restaurarTransporte } from '../src/realtime/push.ts';
import { fijarHorario } from '../src/dominio/horario.ts';

let falsa = pasarelaDeMentira();

before(async () => { await abrirDB({ memoria: true }); });

after(async () => {
  restaurarTransporte();
  fijarPasarela(null);
  await cerrarDB();
});

beforeEach(async () => {
  await limpiarYSembrar();
  falsa = pasarelaDeMentira();
  fijarPasarela(falsa);
});

const base = (items = [{ productoId: 'p-tomate', cantidad: 4 }]) => ({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123',
  lat: -33.0458, lng: -71.6197,
  items,
});

const subsDe = (pedidoId: string) =>
  consultar<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ?', pedidoId);

// ============================================================

test('BUG 1 · el reembolso va al correo real del cliente', async () => {
  const { pedidoId } = await crearPedido({ ...base(), clienteEmail: 'juan@correo.cl' } as any);
  const { pagoId } = await iniciarPago(pedidoId, 'juan@correo.cl');
  await confirmarEnDesarrollo(pagoId);

  await cancelarPedido({ pedidoId, motivo: 'me arrepentí' });

  const [reembolso] = falsa.reembolsos;
  assert.ok(reembolso, 'se pidió el reembolso');
  assert.equal(reembolso.emailCliente, 'juan@correo.cl',
    'si va a un correo inventado, la plata no le llega a nadie');
});

test('BUG 2 · no se puede completar una parada de un viaje cancelado', async () => {
  const { pedidoId } = await pedidoPagado(base());
  const sub = (await subsDe(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');
  await marcarListo(sub.id);

  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId);
  await aceptarViaje(viaje!.id, 'r-diego');
  const paradas = await consultar<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', viaje!.id);

  await cancelarPedido({ pedidoId, motivo: 'cliente ausente' });

  // El repartidor puede no haberse enterado y seguir tocando botones.
  await assert.rejects(
    () => completarParada(paradas[0].id, 'r-diego'),
    (e: Error) => e instanceof ViajeNoDisponible && /cancel/i.test(e.message));

  const p = await consultarUno<Fila>('SELECT * FROM paradas WHERE id = ?', paradas[0].id);
  assert.equal(p!.completada_at, null, 'la parada no queda marcada');
});

test('BUG 4 · después de pagarle, lo que se acumula queda como pendiente', async () => {
  // Primer pedido, entregado y pagado.
  const uno = await pedidoPagado(base());
  const s1 = (await subsDe(uno.pedidoId))[0];
  await aceptarOferta(s1.id, 'f-jose');
  await marcarListo(s1.id);
  const v1 = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', uno.pedidoId);
  await aceptarViaje(v1!.id, 'r-diego');
  for (const p of await consultar<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', v1!.id)) {
    await completarParada(p.id, 'r-diego');
  }

  const pagada = await marcarPagado('f-jose');
  assert.equal(pagada.pagado, 6000, 'se le entregaron $6.000');

  // Llega otro pedido después del pago.
  const dos = await pedidoPagado(base());
  const s2 = (await subsDe(dos.pedidoId))[0];
  await aceptarOferta(s2.id, 'f-jose');
  await marcarListo(s2.id);
  const v2 = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', dos.pedidoId);
  await aceptarViaje(v2!.id, 'r-sofia');
  for (const p of await consultar<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', v2!.id)) {
    await completarParada(p.id, 'r-sofia');
  }

  const ahora = await calcularLiquidacion('f-jose');
  assert.equal(ahora.total, 12_000, 'ganó el doble');
  assert.equal(ahora.pagado, 6000, 'pero solo recibió la mitad');
  assert.equal(ahora.pendiente, 6000, 'y eso es lo que hay que darle');
});

test('BUG 5 · un token muerto de operador también se limpia', async () => {
  await ejecutar(`UPDATE operadores SET push_token = 'ExponentPushToken[op]'`);
  fijarTransporte(async (lote) => ({
    data: lote.map(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } })),
  }));

  await enviarPush([{ to: 'ExponentPushToken[op]', title: 'x', body: 'y' }]);

  const op = await consultarUno<Fila>('SELECT push_token FROM operadores LIMIT 1');
  assert.equal(op!.push_token, null,
    'si no se borra, cada autogestión gasta un envío inútil para siempre');
  restaurarTransporte();
});

test('BUG 7 · el feriante solo recibe avisos de sus propios pedidos', async () => {
  // El filtro del WebSocket manda 'subpedido:cambio' a TODOS los
  // feriantes: el celular de cada puesto se entera de lo que pasa en
  // los otros ocho.
  const { leRegistra } = await import('../src/realtime/filtro.ts');

  const cambio = {
    tipo: 'subpedido:cambio' as const, subPedidoId: 's1', pedidoId: 'p1',
    estado: 'LISTO', ferianteId: 'f-jose',
  };

  assert.equal(leRegistra({ rol: 'feriante', id: 'f-jose' }, cambio), true, 'sí los suyos');
  assert.equal(leRegistra({ rol: 'feriante', id: 'f-ana' }, cambio), false, 'no los ajenos');
  assert.equal(leRegistra({ rol: 'operador', id: 'op' }, cambio), true, 'el operador ve todo');
  assert.equal(leRegistra({ rol: 'cliente', id: 'p1' }, cambio), true, 'el cliente, el suyo');
  assert.equal(leRegistra({ rol: 'cliente', id: 'p2' }, cambio), false, 'no el de otro');
});
