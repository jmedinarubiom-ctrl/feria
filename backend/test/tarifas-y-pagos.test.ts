import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado, completarParada } from './ayuda.ts';
import { aceptarOferta, marcarListo } from '../src/dominio/despacho.ts';
import { aceptarViaje } from '../src/dominio/reparto.ts';
import { viajeActivo } from '../src/dominio/consultas.ts';
import { tarifaReparto } from '../src/dominio/tarifas.ts';
import { actualizarFeria } from '../src/dominio/ferias.ts';
import {
  calcularGananciaRepartidor, confirmarPagoRepartidor, liquidacionesRepartoDelDia,
  marcarPagadoRepartidor, pagosRepartoPorConfirmar,
} from '../src/dominio/liquidaciones.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(cerrarDB);
beforeEach(limpiarYSembrar);

// Los valores de producción, explícitos (los tests corren con tarifa plana).
const PROD = { base: 1500, porKm: 500, porPuestoExtra: 400, minimo: 2000, kmTramo: 5, porKmLejos: 300 };

test('tarifa en tramos: los primeros 5 km a $500, después a $300', () => {
  assert.equal(tarifaReparto(5, 1, PROD), 4000);
  assert.equal(tarifaReparto(8.8, 1, PROD), 5200, 'Reñaca desde Viña');
  assert.equal(tarifaReparto(14.4, 1, PROD), 6900, 'Quilpué desde Viña');
  assert.ok(tarifaReparto(14.4, 1, PROD) < tarifaReparto(14.4, 1, { ...PROD, kmTramo: undefined as any }),
    'con tramos, lo lejano sale más barato que con un precio único por km');
  // Sigue creciendo con la distancia.
  assert.ok(tarifaReparto(10, 1, PROD) > tarifaReparto(6, 1, PROD));
});

test('una feria no se abre sin su ubicación confirmada, y la ubicación se valida', async () => {
  await ejecutar(`UPDATE feriantes SET feria_id = 'feria-marga-marga' WHERE id = 'f-jose'`);
  await assert.rejects(() => actualizarFeria('feria-marga-marga', { activa: true }), /ubicación/);
  await assert.rejects(() => actualizarFeria('feria-marga-marga', { ubicacion: 'en el estero' }), /-33/);
  await assert.rejects(() => actualizarFeria('feria-marga-marga', { ubicacion: '-12.05, -77.04' }), /-33/, 'Lima no');
  const f = await actualizarFeria('feria-marga-marga', {
    ubicacion: 'https://www.google.com/maps/@-33.02650,-71.55000,17z', activa: true,
  });
  assert.equal(f.activa, true);
  assert.deepEqual(f.ubicacion, { lat: -33.0265, lng: -71.55, revisada: true });
  // Guardar el horario no toca la ubicación.
  const g = await actualizarFeria('feria-marga-marga', { abre: '08:00' });
  assert.equal(g.ubicacion!.revisada, true);
});

async function viajeEntregado(cliente: string): Promise<string> {
  const { pedidoId } = await pedidoPagado({
    feriaId: FERIA_ID, clienteNombre: 'Ana', clienteTelefono: '+56987650001',
    direccion: 'Subida Ecuador 123', lat: -33.0458, lng: -71.6197,
    items: [{ productoId: 'p-tomate', cantidad: 4 }],
  });
  void cliente;
  const s = (await consultarUno<Fila>('SELECT id FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;
  await aceptarOferta(s.id, 'f-jose');
  await marcarListo(s.id);
  const v = (await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId))!;
  await aceptarViaje(v.id, 'r-diego');
  for (const p of (await viajeActivo('r-diego'))!.paradas) await completarParada(p.id, 'r-diego');
  return v.id;
}

test('el repartidor ve lo que ganó, el operador le paga y él lo confirma', async () => {
  assert.equal((await calcularGananciaRepartidor('r-diego')).total, 0);
  await viajeEntregado('a');
  await viajeEntregado('b');
  const g = await calcularGananciaRepartidor('r-diego');
  assert.equal(g.cantidad, 2);
  const tarifas = g.viajes.reduce((a: number, v: Fila) => a + v.tarifa, 0);
  assert.equal(g.total, tarifas);

  const dia = await liquidacionesRepartoDelDia();
  assert.equal(dia.repartidores.length, 1);
  assert.equal(dia.totalAPagar, g.total);

  await assert.rejects(() => confirmarPagoRepartidor('r-diego'), /Todavía no/);
  await assert.rejects(() => marcarPagadoRepartidor('r-sofia'), /no tiene viajes/);
  const pagado = await marcarPagadoRepartidor('r-diego');
  assert.equal(pagado.pendiente, 0);
  assert.equal((await liquidacionesRepartoDelDia()).totalAPagar, 0);
  assert.equal((await pagosRepartoPorConfirmar('r-diego')).length, 1);

  const confirmado = await confirmarPagoRepartidor('r-diego');
  assert.ok(confirmado.confirmadoAt);
  assert.equal((await pagosRepartoPorConfirmar('r-diego')).length, 0);

  // Un viaje más después del pago: queda pendiente solo la diferencia.
  await viajeEntregado('c');
  const despues = await calcularGananciaRepartidor('r-diego');
  assert.equal(despues.pendiente, despues.total - pagado.total);
});

test('la feria se elige sola por la ubicación: la abierta más cercana que llega hasta ahí', async () => {
  const { feriaParaUbicacion } = await import('../src/dominio/ferias.ts');
  const { CONFIG } = await import('../src/config.ts');
  // Cerro Alegre, Valparaíso: le toca Av. Argentina (la única abierta).
  const valpo = await feriaParaUbicacion({ lat: -33.0430, lng: -71.6270 });
  assert.equal(valpo.elegida?.id, 'feria-av-argentina');
  assert.ok(valpo.elegida!.km < 5);

  // Abrimos Marga Marga: desde Viña centro le toca esa y no Valparaíso.
  await ejecutar(`UPDATE feriantes SET feria_id = 'feria-marga-marga' WHERE id = 'f-jose'`);
  await actualizarFeria('feria-marga-marga', { activa: true, ubicacion: '-33.0250, -71.5440' });
  const vina = await feriaParaUbicacion({ lat: -33.0245, lng: -71.5518 });
  assert.equal(vina.elegida?.id, 'feria-marga-marga');

  // Villa Alemana: ninguna abierta llega hasta allá.
  const lejos = await feriaParaUbicacion({ lat: -33.0422, lng: -71.3733 });
  assert.equal(lejos.elegida, null);
  assert.ok(lejos.masCercana && lejos.masCercana.km > CONFIG.reparto.maxKm);
});
