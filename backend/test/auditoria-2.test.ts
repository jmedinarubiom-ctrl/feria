/**
 * Segunda auditoría.
 *
 * Igual que la primera: cada test describe el comportamiento
 * correcto de algo que estaba roto.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import {
  crearPedido, confirmarPago, aceptarOferta, liberarSubPedido, marcarListo, expirarPendientes,
} from '../src/dominio/despacho.ts';
import { aceptarViaje, ViajeNoDisponible } from '../src/dominio/reparto.ts';
import { completarParada } from './ayuda.ts';
import { cancelarPedido } from '../src/dominio/cancelacion.ts';
import { calcularLiquidacion } from '../src/dominio/liquidaciones.ts';
import { fijarPasarela } from '../src/dominio/pagos.ts';
import { ErrorNegocio } from '../src/dominio/estados.ts';
import { leRegistra } from '../src/realtime/filtro.ts';
import { CONFIG } from '../src/config.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { await cerrarDB(); });
beforeEach(async () => {
  await limpiarYSembrar();
  fijarPasarela(null);
});

const base = (items: Array<{ productoId: string; cantidad: number }>) => ({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items,
});

const subDe = async (pedidoId: string, rubro: string) =>
  (await consultarUno<Fila>(
    'SELECT * FROM sub_pedidos WHERE pedido_id = ? AND rubro_id = ?', pedidoId, rubro))!;

const paradasDe = (viajeId: string) => consultar<Fila>(
  'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', viajeId);

/** Verduras con José y frutas con Carmen, viaje tomado por Diego. */
async function pedidoEnDosPuestos() {
  const { pedidoId } = await pedidoPagado(base([
    { productoId: 'p-tomate', cantidad: 4 },
    { productoId: 'p-palta', cantidad: 2 },
  ]));
  const verduras = await subDe(pedidoId, 'verduras');
  const frutas = await subDe(pedidoId, 'frutas');
  await aceptarOferta(verduras.id, 'f-jose');
  await aceptarOferta(frutas.id, 'f-carmen');
  const viaje = (await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId))!;
  await aceptarViaje(viaje.id, 'r-diego');
  return { pedidoId, verduras, frutas, viajeId: viaje.id as string };
}

// ------------------------------------------------------------
// Plata
// ------------------------------------------------------------

test('quien paga después de que venció la reserva recibe su pedido', async () => {
  const { pedidoId } = await crearPedido(base([{ productoId: 'p-tomate', cantidad: 4 }]));
  await ejecutar(
    `UPDATE pedidos SET creado_at = now() - make_interval(mins => ?) WHERE id = ?`,
    CONFIG.minutosParaPagar + 1, pedidoId);
  await expirarPendientes();

  // El checkout de la pasarela seguía abierto y el cliente pagó.
  assert.equal(await confirmarPago(pedidoId), true);

  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'DESPACHANDO');
  const ofertas = await consultar('SELECT id FROM ofertas');
  assert.ok(ofertas.length > 0, 'salió a la feria');
});

test('un pago que llega sobre un pedido cancelado no lo revive', async () => {
  const { pedidoId } = await crearPedido(base([{ productoId: 'p-tomate', cantidad: 4 }]));
  await cancelarPedido({ pedidoId, motivo: 'el cliente llamó' });

  assert.equal(await confirmarPago(pedidoId), false);
  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'CANCELADO');
});

test('cancelar en ruta le paga al feriante lo que el repartidor ya retiró', async () => {
  const { pedidoId, viajeId } = await pedidoEnDosPuestos();
  const [primera] = await paradasDe(viajeId);
  await completarParada(primera.id, 'r-diego');

  const r = await cancelarPedido({ pedidoId, motivo: 'el cliente no está' });

  // Los dos: uno ya entregó la bolsa y el otro la tenía apartada.
  assert.deepEqual(r.compensaciones.map((c) => c.ferianteId).sort(), ['f-carmen', 'f-jose']);
  const jose = await calcularLiquidacion('f-jose');
  assert.equal(jose.total, 4 * 1500);
});

// ------------------------------------------------------------
// El feriante devuelve el pedido con el viaje ya armado
// ------------------------------------------------------------

test('si un feriante devuelve el pedido, el repartidor deja de ir a ese puesto', async () => {
  const { verduras, viajeId } = await pedidoEnDosPuestos();
  assert.equal((await paradasDe(viajeId)).length, 3);

  await liberarSubPedido(verduras.id, 'f-jose');

  const paradas = await paradasDe(viajeId);
  assert.deepEqual(paradas.map((p) => p.tipo), ['RETIRO', 'ENTREGA']);
  assert.match(paradas[0].etiqueta, /Carmen/);
  assert.deepEqual(paradas.map((p) => p.orden), [0, 1]);
});

test('lo que se está ofertando de nuevo no se puede dar por retirado', async () => {
  const { verduras, frutas, viajeId } = await pedidoEnDosPuestos();
  await liberarSubPedido(verduras.id, 'f-jose');

  const [carmen, entrega] = await paradasDe(viajeId);
  await completarParada(carmen.id, 'r-diego');

  assert.equal((await subDe(frutas.pedido_id, 'frutas')).estado, 'RETIRADO');
  assert.equal((await subDe(frutas.pedido_id, 'verduras')).estado, 'OFERTANDO');

  // Falta una bolsa: ni sale a ruta ni puede entregar.
  const viaje = await consultarUno<Fila>('SELECT estado FROM viajes WHERE id = ?', viajeId);
  assert.equal(viaje!.estado, 'RETIRANDO');
  await assert.rejects(() => completarParada(entrega.id, 'r-diego'), ViajeNoDisponible);
});

test('cuando otro puesto lo toma, aparece su parada y el viaje termina bien', async () => {
  const { pedidoId, verduras, viajeId } = await pedidoEnDosPuestos();
  await liberarSubPedido(verduras.id, 'f-jose');
  const [carmen] = await paradasDe(viajeId);
  await completarParada(carmen.id, 'r-diego');

  await aceptarOferta(verduras.id, 'f-luis');

  const paradas = await paradasDe(viajeId);
  assert.deepEqual(paradas.map((p) => p.tipo), ['RETIRO', 'RETIRO', 'ENTREGA']);
  assert.ok(paradas[0].completada_at, 'la de Carmen sigue hecha');
  assert.match(paradas[1].etiqueta, /Luis/);

  await marcarListo(verduras.id);
  await completarParada(paradas[1].id, 'r-diego');
  await completarParada(paradas[2].id, 'r-diego');

  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'ENTREGADO');
  // A José no se le paga lo que devolvió; a Luis sí.
  assert.equal((await calcularLiquidacion('f-jose')).total, 0);
  assert.equal((await calcularLiquidacion('f-luis')).total, 4 * 1500);
});

test('el repartidor puede retirar aunque el feriante no haya marcado listo', async () => {
  const { pedidoId, viajeId } = await pedidoEnDosPuestos();
  const paradas = await paradasDe(viajeId);

  // Nadie tocó LISTO: le pasaron las bolsas en la mano.
  await completarParada(paradas[0].id, 'r-diego');
  await completarParada(paradas[1].id, 'r-diego');

  const p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'EN_RUTA');
  await completarParada(paradas[2].id, 'r-diego');
  assert.equal((await calcularLiquidacion('f-jose')).total, 4 * 1500);
});

test('si nada cambió, las paradas conservan su id', async () => {
  const { frutas, viajeId } = await pedidoEnDosPuestos();
  const antes = (await paradasDe(viajeId)).map((p) => p.id);
  await marcarListo(frutas.id);
  assert.deepEqual((await paradasDe(viajeId)).map((p) => p.id), antes);
});

// ------------------------------------------------------------
// Entrada y avisos
// ------------------------------------------------------------

test('un pedido sin items o sin datos es un error de quien lo manda', async () => {
  const malo = (cambio: object) => assert.rejects(
    () => crearPedido({ ...base([{ productoId: 'p-tomate', cantidad: 4 }]), ...cambio } as any),
    (e: unknown) => e instanceof ErrorNegocio && e.codigo === 422);

  await malo({ items: undefined });
  await malo({ items: [] });
  await malo({ clienteNombre: '' });
  await malo({ direccion: 'x'.repeat(300) });
  await malo({ items: [{ productoId: 'p-tomate', cantidad: 100000 }] });
});

test('la posición del repartidor solo le llega al cliente de ese pedido', () => {
  const m = { tipo: 'ubicacion', viajeId: 'v1', pedidoId: 'p1', lat: 0, lng: 0 } as const;
  assert.equal(leRegistra({ rol: 'cliente', id: 'p1' }, m), true);
  assert.equal(leRegistra({ rol: 'cliente', id: 'p2' }, m), false);
  assert.equal(leRegistra({ rol: 'operador', id: 'op' }, m), true);
});
