import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar } from './ayuda.ts';
import { crearPedido, expirarPendientes } from '../src/dominio/despacho.ts';
import {
  iniciarPago, confirmarDesdePasarela, fijarPasarela, ErrorPago,
} from '../src/dominio/pagos.ts';
import {
  firmar, fijarTransporteFlow, restaurarTransporteFlow, crearPasarelaFlow,
} from '../src/pagos/flow.ts';
import { CONFIG } from '../src/config.ts';

const CFG = {
  apiKey: 'llave-de-prueba',
  secretKey: 'secreto-de-prueba',
  base: 'https://sandbox.flow.cl/api',
  urlConfirmacion: 'https://feria.cl/webhooks/flow/confirmacion',
  urlRetorno: 'https://feria.cl/pagos/retorno',
};

/** Flow de mentira: guarda lo que se le pidió y responde lo que le digamos. */
let creados: Array<Record<string, string>> = [];
let estadoQueDevuelve: any = null;
let firmasRecibidas: string[] = [];

before(async () => {
  await abrirDB({ memoria: true });
  fijarPasarela(crearPasarelaFlow(CFG));
  fijarTransporteFlow(async (url, cuerpo) => {
    if (url.includes('/payment/create')) {
      const params = Object.fromEntries(cuerpo!);
      creados.push(params);
      firmasRecibidas.push(params.s);
      return {
        url: 'https://sandbox.flow.cl/app/web/pay.php',
        token: 'token-' + params.commerceOrder,
        flowOrder: 12345,
      };
    }
    return estadoQueDevuelve;
  });
});

after(async () => {
  restaurarTransporteFlow();
  fijarPasarela(null);
  await cerrarDB();
});

beforeEach(async () => {
  await limpiarYSembrar();
  creados = [];
  firmasRecibidas = [];
  estadoQueDevuelve = null;
});

const armarPedido = () => crearPedido({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items: [{ productoId: 'p-tomate', cantidad: 4 }],
});

/** Lo que responde Flow cuando el pago salió bien. */
const flowPagado = (ordenComercio: string, monto = 11300, media = 'Transferencia') => ({
  status: 2, commerceOrder: ordenComercio, amount: monto, paymentData: { media },
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

test('iniciar el pago devuelve la URL de Flow y firma la petición', async () => {
  const { pedidoId, numero } = await armarPedido();
  const r = await iniciarPago(pedidoId, 'cliente@correo.cl');

  assert.ok(r.url!.startsWith('https://sandbox.flow.cl/app/web/pay.php?token='));
  assert.equal(creados.length, 1);
  assert.equal(creados[0].amount, '11300', 'cobra el total con despacho');
  assert.equal(creados[0].currency, 'CLP');
  assert.match(creados[0].commerceOrder, new RegExp(`^feria-${numero}-`));

  // La firma tiene que ser la que Flow espera, o rechaza sin decir por qué.
  const { s: firma, ...params } = creados[0];
  assert.equal(firma, firmar(params, CFG.secretKey));
});

test('volver atrás en la app no genera dos cobros', async () => {
  const { pedidoId } = await armarPedido();
  const a = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const b = await iniciarPago(pedidoId, 'cliente@correo.cl');

  assert.equal(a.url, b.url, 'se reusa la misma orden de pago');
  assert.equal(creados.length, 1, 'a Flow se le pidió una sola vez');
});

test('cuando Flow confirma, recién ahí sale a la feria', async () => {
  const { pedidoId } = await armarPedido();
  const { pagoId } = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);

  estadoQueDevuelve = flowPagado(pago!.orden_comercio);
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

test('un aviso repetido de Flow no despacha dos veces', async () => {
  const { pedidoId } = await armarPedido();
  const { pagoId } = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  estadoQueDevuelve = flowPagado(pago!.orden_comercio);

  await confirmarDesdePasarela(pago!.referencia_externa);
  const ofertasTras1 = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM ofertas');

  // Flow reintenta sus confirmaciones durante horas.
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
  estadoQueDevuelve = flowPagado(pago!.orden_comercio, 100);
  await assert.rejects(() => confirmarDesdePasarela(pago!.referencia_externa), ErrorPago);

  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'PENDIENTE_PAGO', 'el pedido no avanza');
});

test('un pago rechazado deja el pedido sin despachar', async () => {
  const { pedidoId } = await armarPedido();
  const { pagoId } = await iniciarPago(pedidoId, 'cliente@correo.cl');
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);

  estadoQueDevuelve = { status: 3, commerceOrder: pago!.orden_comercio, amount: 11300 };
  const r = await confirmarDesdePasarela(pago!.referencia_externa);

  assert.equal(r.pagado, false);
  const guardado = await consultarUno<Fila>('SELECT estado FROM pagos WHERE id = ?', pagoId);
  assert.equal(guardado!.estado, 'RECHAZADO');
  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'PENDIENTE_PAGO');
});

test('un aviso con un token inventado no confirma nada', async () => {
  await armarPedido();
  estadoQueDevuelve = { status: 2, commerceOrder: 'feria-9999-falsa', amount: 11300 };

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
    fijarPasarela(crearPasarelaFlow(CFG));
  }
});
