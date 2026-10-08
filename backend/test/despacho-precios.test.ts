import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultarUno, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import {
  crearPedido, cotizar, calcularDespacho, aceptarOferta, marcarListo, PedidoMuyChico,
} from '../src/dominio/despacho.ts';
import { aceptarViaje } from '../src/dominio/reparto.ts';
import { completarParada } from './ayuda.ts';
import { metricas } from '../src/dominio/consultas.ts';
import { CONFIG } from '../src/config.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { await cerrarDB(); });
beforeEach(limpiarYSembrar);

const pedir = (items: Array<{ productoId: string; cantidad: number }>) => pedidoPagado({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items,
});

// ============================================================

test('el despacho se le cobra al cliente', async () => {
  // 4× tomate = $8.800, sobre el mínimo y bajo el envío gratis.
  const { pedidoId } = await pedir([{ productoId: 'p-tomate', cantidad: 4 }]);
  const p = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);

  assert.equal(p!.total_productos, 8800);
  assert.equal(p!.costo_despacho, 2500);
  assert.equal(p!.total_venta, 11300, 'el total incluye el despacho');
});

test('sobre el monto de envío gratis no se cobra', async () => {
  assert.equal(calcularDespacho(CONFIG.despacho.gratisDesde - 1), CONFIG.despacho.costo);
  assert.equal(calcularDespacho(CONFIG.despacho.gratisDesde), 0);

  // 5× palta = $29.500
  const { pedidoId } = await pedir([{ productoId: 'p-palta', cantidad: 5 }]);
  const p = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.costo_despacho, 0);
  assert.equal(p!.total_venta, p!.total_productos);
});

test('un carro demasiado chico no se acepta', async () => {
  // Un pedido de $2.200 no paga ni el viaje del repartidor.
  await assert.rejects(
    () => pedir([{ productoId: 'p-tomate', cantidad: 1 }]), PedidoMuyChico);

  const n = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM pedidos');
  assert.equal(n!.n, 0, 'no queda nada a medias');
});

test('la cotización le dice al cliente cuánto falta para el envío gratis', async () => {
  const chico = cotizar(5000);
  assert.equal(chico.alcanzaMinimo, false);
  assert.equal(chico.minimo, CONFIG.despacho.pedidoMinimo);

  const medio = cotizar(20_000);
  assert.equal(medio.despacho, 2500);
  assert.equal(medio.total, 22_500);
  assert.equal(medio.faltaParaGratis, 5000);

  const grande = cotizar(30_000);
  assert.equal(grande.despacho, 0);
  assert.equal(grande.faltaParaGratis, 0);
});

test('el margen del día cuenta mercadería, reparto y comisiones', async () => {
  const { pedidoId } = await pedir([{ productoId: 'p-tomate', cantidad: 4 }]);
  const sub = await consultarUno<Fila>(
    'SELECT id FROM sub_pedidos WHERE pedido_id = ?', pedidoId);

  await aceptarOferta(sub!.id, 'f-jose');
  await marcarListo(sub!.id);

  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId);
  await aceptarViaje(viaje!.id, 'r-diego');
  const paradas = await consultarUno<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden LIMIT 1', viaje!.id);
  await completarParada(paradas!.id, 'r-diego');
  const entrega = await consultarUno<Fila>(
    `SELECT * FROM paradas WHERE viaje_id = ? AND tipo = 'ENTREGA'`, viaje!.id);
  await completarParada(entrega!.id, 'r-diego');

  const m = await metricas();
  const ingresos = 8800 + 2500;
  const mercaderia = 1500 * 4;
  const reparto = CONFIG.tarifaReparto;
  const comisiones = Math.round(ingresos * CONFIG.comisiones);

  assert.equal(m.plata.ingresos, ingresos);
  assert.equal(m.plata.mercaderia, mercaderia);
  assert.equal(m.plata.reparto, reparto);
  assert.equal(m.plata.comisiones, comisiones);
  assert.equal(m.plata.margen, ingresos - mercaderia - reparto - comisiones);
  assert.equal(m.plata.porPedido, m.plata.margen);
});

test('sin el despacho cobrado este pedido perdería plata', async () => {
  // La razón por la que existe el cobro: 4× tomate deja $2.800 de
  // margen bruto y el reparto cuesta $2.500.
  const margenBruto = (2200 - 1500) * 4;
  const conCobro = margenBruto + CONFIG.despacho.costo - CONFIG.tarifaReparto
    - Math.round((8800 + 2500) * CONFIG.comisiones);
  const sinCobro = margenBruto - CONFIG.tarifaReparto
    - Math.round(8800 * CONFIG.comisiones);

  assert.ok(sinCobro < 0, `sin cobrar despacho el pedido pierde ${sinCobro}`);
  assert.ok(conCobro > 0, `cobrándolo deja ${conCobro}`);
});
