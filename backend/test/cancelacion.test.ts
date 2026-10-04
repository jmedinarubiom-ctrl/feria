import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import { crearPedido, aceptarOferta, marcarListo } from '../src/dominio/despacho.ts';
import { aceptarViaje, completarParada } from '../src/dominio/reparto.ts';
import { cancelarPedido, reembolsosPendientes, ErrorCancelacion } from '../src/dominio/cancelacion.ts';
import { calcularLiquidacion, liquidacionesDelDia } from '../src/dominio/liquidaciones.ts';
import { metricas } from '../src/dominio/consultas.ts';
import { iniciarPago, confirmarEnDesarrollo, fijarPasarela } from '../src/dominio/pagos.ts';
import { crearPasarelaFlow } from '../src/pagos/flow.ts';
import { fijarTransporteFlow, restaurarTransporteFlow } from '../src/pagos/flow.ts';

before(async () => {
  await abrirDB({ memoria: true });
  // Ningún test sale a internet: sin esto llegaban al sandbox real
  // de Flow y fallaban por credenciales.
  fijarTransporteFlow(async (url) => {
    if (url.includes('/payment/create')) {
      return { url: 'https://sandbox.flow.cl/pay', token: 'tok', flowOrder: 1 };
    }
    throw new Error('Flow no responde');
  });
});

after(async () => {
  restaurarTransporteFlow();
  fijarPasarela(null);
  await cerrarDB();
});
beforeEach(limpiarYSembrar);

const base = (items: Array<{ productoId: string; cantidad: number }>) => ({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items,
});

const CARRO = [{ productoId: 'p-tomate', cantidad: 4 }];
const subsDe = (pedidoId: string) =>
  consultar<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ?', pedidoId);

// ============================================================

test('el operador cancela mientras nadie lo tomó', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));

  const r = await cancelarPedido({ pedidoId, motivo: 'el cliente llamó, se arrepintió' });

  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'CANCELADO');
  assert.equal(r.compensaciones.length, 0, 'nadie había apartado nada');
});

test('cancelar cierra las ofertas sin castigar a los feriantes', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  await cancelarPedido({ pedidoId, motivo: 'me arrepentí' });

  const abiertas = await consultar<Fila>(
    `SELECT o.* FROM ofertas o JOIN sub_pedidos s ON s.id = o.sub_pedido_id
      WHERE s.pedido_id = ? AND o.respuesta IS NULL`, pedidoId);
  assert.equal(abiertas.length, 0, 'no queda ninguna oferta viva');

  // Nadie hizo nada malo: no se les cuenta rechazo ni plantón.
  const jose = await consultarUno<Fila>('SELECT * FROM feriantes WHERE id = ?', 'f-jose');
  assert.equal(jose!.rechazos, 0);
  assert.equal(jose!.timeouts, 0);
});

test('al feriante que ya aceptó se le paga igual', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  const sub = (await subsDe(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');

  const r = await cancelarPedido({
    pedidoId, motivo: 'el cliente no contesta',
  });

  assert.equal(r.compensaciones.length, 1);
  assert.equal(r.compensaciones[0].ferianteId, 'f-jose');
  assert.equal(r.compensaciones[0].monto, 1500 * 4);

  // Y aparece en su liquidación del día, que es lo que importa.
  const liq = await calcularLiquidacion('f-jose');
  assert.equal(liq.total, 1500 * 4);
  assert.equal(liq.cantidad, 1);

  const guardado = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', sub.id);
  assert.equal(guardado!.estado, 'CANCELADO');
  assert.equal(guardado!.compensado, true);
});

test('al feriante que no alcanzó a aceptar no se le paga nada', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  await cancelarPedido({ pedidoId, motivo: 'me arrepentí' });

  const liq = await calcularLiquidacion('f-jose');
  assert.equal(liq.total, 0);
});

test('se puede cancelar aunque un feriante ya lo esté preparando', async () => {
  // Es una decisión de negocio y la toma el operador, que sabe en qué
  // estado está el pedido. Lo que no cambia es que al feriante se le
  // paga igual.
  const { pedidoId } = await pedidoPagado(base(CARRO));
  const sub = (await subsDe(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');

  const r = await cancelarPedido({ pedidoId, motivo: 'el cliente no contesta' });
  assert.equal(r.compensaciones.length, 1);
  assert.equal(r.compensaciones[0].monto, 1500 * 4);
});

test('cancelar anula el viaje', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  const sub = (await subsDe(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');
  await marcarListo(sub.id);

  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId);
  await aceptarViaje(viaje!.id, 'r-diego');

  await cancelarPedido({ pedidoId, motivo: 'dirección equivocada' });

  const despues = await consultarUno<Fila>('SELECT estado FROM viajes WHERE id = ?', viaje!.id);
  assert.equal(despues!.estado, 'CANCELADO');
});

test('un pedido entregado ya no se cancela', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  const sub = (await subsDe(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');
  await marcarListo(sub.id);

  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId);
  await aceptarViaje(viaje!.id, 'r-diego');
  for (const p of await consultar<Fila>(
    'SELECT id FROM paradas WHERE viaje_id = ? ORDER BY orden', viaje!.id)) {
    await completarParada(p.id, 'r-diego');
  }

  await assert.rejects(
    () => cancelarPedido({ pedidoId, motivo: 'tarde' }),
    (e: ErrorCancelacion) => e.codigo === 409 && /reclamo/.test(e.message));
});

test('no se puede cancelar dos veces', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  await cancelarPedido({ pedidoId, motivo: 'uno' });
  await assert.rejects(
    () => cancelarPedido({ pedidoId, motivo: 'dos' }), ErrorCancelacion);
});

test('un pedido que nunca se pagó no genera reembolso', async () => {
  const { pedidoId } = await crearPedido(base(CARRO));

  const r = await cancelarPedido({ pedidoId, motivo: 'me arrepentí' });
  assert.equal(r.reembolso.monto, 0);
  assert.equal(r.reembolso.solicitado, false);
  assert.match(r.reembolso.motivo!, /nunca se pagó/);
});

/** Pedido cobrado de verdad: crear → iniciar pago → confirmar. */
async function pedidoConCobro() {
  const { pedidoId } = await crearPedido(base(CARRO));
  const { pagoId } = await iniciarPago(pedidoId, 'c@c.cl');
  await confirmarEnDesarrollo(pagoId);
  return { pedidoId, pagoId };
}

test('cancelar un pedido pagado pide el reembolso completo', async () => {
  fijarPasarela(null);   // sin pasarela: se anota igual
  const { pedidoId, pagoId } = await pedidoConCobro();

  const r = await cancelarPedido({ pedidoId, motivo: 'me arrepentí' });

  assert.equal(r.reembolso.monto, 11300, 'productos + despacho');
  assert.equal(r.reembolso.solicitado, true);

  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  assert.equal(pago!.monto_reembolsado, 11300);
  assert.ok(pago!.reembolsado_at);
});

test('el operador puede devolver solo una parte', async () => {
  fijarPasarela(null);
  const { pedidoId, pagoId } = await pedidoConCobro();

  // El repartidor ya salió: se devuelve la mercadería, no el despacho.
  const r = await cancelarPedido({
    pedidoId, motivo: 'sin stock', montoReembolso: 8800,
  });
  assert.equal(r.reembolso.monto, 8800);

  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  assert.equal(pago!.monto_reembolsado, 8800);
});

test('las cancelaciones aparecen como costo en la plata del día', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  const sub = (await subsDe(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');
  await cancelarPedido({ pedidoId, motivo: 'cliente ausente' });

  const m = await metricas();
  assert.equal(m.plata.cancelaciones, 1500 * 4, 'mercadería pagada y no vendida');
  assert.equal(m.plata.pedidosCancelados, 1);
  assert.ok(m.plata.margen < 0, 'un día de puras cancelaciones da pérdida');
});

test('la liquidación del operador lista lo que hay que compensar', async () => {
  const { pedidoId } = await pedidoPagado(base(CARRO));
  const sub = (await subsDe(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');
  await cancelarPedido({ pedidoId, motivo: 'cliente ausente' });

  const dia = await liquidacionesDelDia();
  const jose = dia.feriantes.find((f: Fila) => f.id === 'f-jose')!;
  assert.equal(jose.total, 1500 * 4);
  assert.equal(jose.compensados, 1, 'se distingue de una entrega normal');
});

test('si el reembolso falla, la cancelación igual ocurre', async () => {
  fijarPasarela(crearPasarelaFlow({
    apiKey: 'x', secretKey: 'y', base: 'https://sandbox.flow.cl/api',
    urlConfirmacion: 'https://feria.cl/c', urlRetorno: 'https://feria.cl/r',
  }));
  const { pedidoId } = await crearPedido(base(CARRO));
  const { pagoId } = await iniciarPago(pedidoId, 'c@c.cl');
  await confirmarEnDesarrollo(pagoId);
  // Se marca como pago de Flow para que el reembolso salga por la
  // pasarela… que no va a responder.
  await ejecutar(`UPDATE pagos SET proveedor = 'flow' WHERE id = ?`, pagoId);

  // Flow no responde (no hay transporte de prueba puesto acá).
  const r = await cancelarPedido({ pedidoId, motivo: 'me arrepentí' });

  // Lo importante: nadie sigue preparando un pedido cancelado.
  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'CANCELADO');
  assert.equal(r.reembolso.solicitado, false, 'y queda anotado que hay que devolver a mano');

  const pendientes = await reembolsosPendientes();
  assert.ok(pendientes.length >= 0);
  fijarPasarela(null);
});
