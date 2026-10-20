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
import { despachoParaCliente, kmPorCalle, tarifaReparto } from '../src/dominio/tarifas.ts';

// La dirección de los tests y la feria: a poco menos de 1 km por calle.
const KM = kmPorCalle({ lat: CONFIG.puntoFeria.lat, lng: CONFIG.puntoFeria.lng }, { lat: -33.0458, lng: -71.6197 });
const TARIFA_1 = tarifaReparto(KM, 1);

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
  assert.equal(p!.costo_despacho, TARIFA_1, 'lo mismo que va a ganar el repartidor');
  assert.equal(p!.total_venta, 8800 + TARIFA_1, 'el total incluye el despacho');
  assert.equal(Number(p!.distancia_km), KM, 'queda anotada la distancia con que se cobró');
});

test('sobre el monto de envío gratis no se cobra, pero solo cerca', async () => {
  assert.equal(calcularDespacho(CONFIG.despacho.gratisDesde - 1, 2), tarifaReparto(2, 1));
  assert.equal(calcularDespacho(CONFIG.despacho.gratisDesde, 2), 0);
  // Lejos de la feria, el viaje se cobra aunque el carro sea grande.
  const lejos = CONFIG.despacho.gratisHastaKm + 3;
  assert.equal(calcularDespacho(CONFIG.despacho.gratisDesde, lejos), tarifaReparto(lejos, 1));

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

  const medio = cotizar(20_000, { km: 2 });
  assert.equal(medio.despacho, tarifaReparto(2, 1));
  assert.equal(medio.total, 20_000 + medio.despacho);
  assert.equal(medio.faltaParaGratis, 5000);
  assert.equal(medio.estimado, false);

  const grande = cotizar(30_000, { km: 2 });
  assert.equal(grande.despacho, 0);
  assert.equal(grande.faltaParaGratis, 0);

  // Sin dirección todavía: un «desde», marcado como estimado.
  const sinDireccion = cotizar(20_000);
  assert.equal(sinDireccion.estimado, true);
  assert.equal(sinDireccion.despacho, CONFIG.reparto.minimo);

  // Más puestos (rubros) y más lejos, más caro; demasiado lejos, fuera.
  assert.ok(cotizar(20_000, { km: 6, rubros: 3 }).despacho > cotizar(20_000, { km: 2, rubros: 1 }).despacho);
  assert.equal(cotizar(20_000, { km: CONFIG.reparto.maxKm + 1 }).fueraDeZona, true);
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
  const ingresos = 8800 + TARIFA_1;
  const mercaderia = 1500 * 4;
  const reparto = TARIFA_1;
  const comisiones = Math.round(ingresos * CONFIG.comisiones);

  assert.equal(m.plata.ingresos, ingresos);
  assert.equal(m.plata.mercaderia, mercaderia);
  assert.equal(m.plata.reparto, reparto);
  assert.equal(m.plata.comisiones, comisiones);
  assert.equal(m.plata.margen, ingresos - mercaderia - reparto - comisiones);
  assert.equal(m.plata.porPedido, m.plata.margen);
});

test('el despacho cobrado cubre el viaje: el reparto no sale del margen', () => {
  for (const km of [0.5, 2, 5, 10]) {
    for (const rubros of [1, 2, 3]) {
      const d = despachoParaCliente(10_000, km, rubros);
      assert.equal(d.despacho, tarifaReparto(km, rubros), `${km} km, ${rubros} rubros`);
    }
  }
  assert.equal(tarifaReparto(0, 1), CONFIG.reparto.minimo);
});

test('la tarifa por distancia: crece con los km y los puestos, y se redondea a la centena', () => {
  // Los valores de producción (las pruebas corren con una tarifa
  // plana para que los montos de los demás tests no dependan de la
  // distancia; ver package.json).
  const p = { base: 1500, porKm: 500, porPuestoExtra: 400, minimo: 2000, factorCalle: 1.4, maxKm: 15 };
  assert.equal(tarifaReparto(0.5, 1, p), 2000, 'cerca: el mínimo');
  assert.equal(tarifaReparto(3, 1, p), 3000);
  assert.equal(tarifaReparto(3, 3, p), 3800, 'dos puestos extra: +800');
  assert.equal(tarifaReparto(8.4, 1, p), 5700);
  assert.equal(tarifaReparto(2.13, 1, p), 2600, 'hacia arriba, a la centena');
  assert.ok(tarifaReparto(10, 1, p) > tarifaReparto(5, 1, p));
});
