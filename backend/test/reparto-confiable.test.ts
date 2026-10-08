import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado, completarParada as entregarConCodigo } from './ayuda.ts';
import { aceptarOferta, marcarListo } from '../src/dominio/despacho.ts';
import { aceptarViaje, completarParada } from '../src/dominio/reparto.ts';
import { calcularLiquidacion, marcarPagado } from '../src/dominio/liquidaciones.ts';
import { pedidoCompleto, viajeActivo, viajesDisponibles } from '../src/dominio/consultas.ts';
import {
  anotarParaElRepartidor, calificar, compensar, escalarViajes, estimarLlegada,
  marcarFaltante, pagosPorConfirmar,
} from '../src/dominio/mejoras.ts';
import { revisarYAvisar } from '../src/dominio/alertas.ts';
import { fijarTransporteCorreo } from '../src/correo.ts';
import { ErrorNegocio } from '../src/dominio/estados.ts';

const correos: string[] = [];
before(async () => {
  process.env.ALERTAS_CORREO = 'operador@example.com';
  await abrirDB({ memoria: true });
  fijarTransporteCorreo(async (_a, _b, texto) => { correos.push(texto); return { enviado: true, proveedor: 'prueba' }; });
});
after(async () => { fijarTransporteCorreo(null); await cerrarDB(); });
beforeEach(async () => { correos.length = 0; await limpiarYSembrar(); });

async function nuevoCliente(id: string) {
  await ejecutar(`INSERT INTO clientes (id, nombre, telefono) VALUES (?, 'Ana', ?)`, id, '+5698765' + id.slice(-4));
  return id;
}
const pedidoDe = (clienteId: string, items = [{ productoId: 'p-tomate', cantidad: 2 }, { productoId: 'p-cebolla', cantidad: 3 }]) =>
  pedidoPagado({
    feriaId: FERIA_ID, clienteId, clienteNombre: 'Ana', clienteTelefono: '+56987650001',
    direccion: 'Subida Ecuador 123, Valparaíso', lat: -33.0458, lng: -71.6197, items,
  });
const sub = async (pedidoId: string) =>
  (await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;

/** Lleva un pedido de verduras hasta tener el viaje tomado y el retiro hecho. */
async function hastaLaPuerta(clienteId: string) {
  const { pedidoId } = await pedidoDe(clienteId);
  const s = await sub(pedidoId);
  await aceptarOferta(s.id, 'f-jose');
  await marcarListo(s.id);
  const viaje = (await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId))!;
  await aceptarViaje(viaje.id, 'r-diego');
  const paradas = (await viajeActivo('r-diego'))!.paradas;
  await completarParada(paradas[0].id, 'r-diego');
  return { pedidoId, subId: s.id, viajeId: viaje.id, entrega: paradas[paradas.length - 1] };
}

// ---------- 1 · prueba de entrega ----------

test('entrega: sin el código del cliente no se puede marcar entregado', async () => {
  const { pedidoId, entrega } = await hastaLaPuerta(await nuevoCliente('cli-0001'));
  const { codigo_entrega } = (await consultarUno<Fila>('SELECT codigo_entrega FROM pedidos WHERE id = ?', pedidoId))!;
  assert.match(codigo_entrega, /^\d{4}$/);

  await assert.rejects(() => completarParada(entrega.id, 'r-diego'), /código de entrega/);
  const malo = codigo_entrega === '1234' ? '4321' : '1234';
  await assert.rejects(() => completarParada(entrega.id, 'r-diego', { codigo: malo }), /no es el código/);
  assert.equal((await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId))!.estado, 'EN_RUTA');

  await completarParada(entrega.id, 'r-diego', { codigo: codigo_entrega });
  assert.equal((await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId))!.estado, 'ENTREGADO');
  // El repartidor nunca ve el código en su pantalla.
  assert.doesNotMatch(JSON.stringify(await viajeActivo('r-diego')), new RegExp(`"${codigo_entrega}"`));
});

test('entrega sin código: hay que decir a quién se dejó, y el operador se entera', async () => {
  const { pedidoId, entrega } = await hastaLaPuerta(await nuevoCliente('cli-0002'));
  await assert.rejects(() => completarParada(entrega.id, 'r-diego', { motivo: 'ok' }), ErrorNegocio);
  await completarParada(entrega.id, 'r-diego', { motivo: 'Lo recibió el conserje, don Luis' });
  const p = (await consultarUno<Fila>('SELECT estado, entrega_sin_codigo FROM pedidos WHERE id = ?', pedidoId))!;
  assert.equal(p.estado, 'ENTREGADO');
  assert.match(p.entrega_sin_codigo, /conserje/);
  await revisarYAvisar(3);
  assert.ok(correos.some((c) => /sin el código del cliente/.test(c) && /conserje/.test(c)), correos.join('\n'));
});

// ---------- 2 · faltantes ----------

test('faltante: no se le paga al puesto, se le devuelve al cliente y el repartidor lo ve', async () => {
  const { pedidoId } = await pedidoDe(await nuevoCliente('cli-0003'));
  const s = await sub(pedidoId);
  const items = await consultar<Fila>('SELECT * FROM items WHERE sub_pedido_id = ? ORDER BY nombre', s.id);
  const cebolla = items.find((i) => i.nombre.startsWith('Cebolla'))!;
  const tomate = items.find((i) => i.nombre.startsWith('Tomate'))!;

  // Antes de aceptar no es su pedido.
  await assert.rejects(() => marcarFaltante(cebolla.id, { rol: 'feriante', id: 'f-jose' }), ErrorNegocio);
  await aceptarOferta(s.id, 'f-jose');
  // Otro puesto no puede tocarlo.
  await assert.rejects(() => marcarFaltante(cebolla.id, { rol: 'feriante', id: 'f-carmen' }), ErrorNegocio);

  const r = await marcarFaltante(cebolla.id, { rol: 'feriante', id: 'f-jose' });
  assert.equal(r.devuelto, cebolla.precio_venta * cebolla.cantidad);
  const despues = await sub(pedidoId);
  assert.equal(despues.monto_feriante, s.monto_feriante - cebolla.precio_costo * cebolla.cantidad);
  const pago = (await consultarUno<Fila>('SELECT monto, monto_reembolsado FROM pagos WHERE pedido_id = ?', pedidoId));
  if (pago) assert.equal(pago.monto_reembolsado, r.devuelto);

  // Marcarlo dos veces no devuelve dos veces.
  assert.equal((await marcarFaltante(cebolla.id, { rol: 'feriante', id: 'f-jose' })).devuelto, 0);
  // Lo último que queda no se marca: se libera el pedido.
  await assert.rejects(() => marcarFaltante(tomate.id, { rol: 'feriante', id: 'f-jose' }), /libéralo/);

  const vista = (await pedidoCompleto(pedidoId))!;
  assert.equal(vista.subPedidos[0].items.find((i: Fila) => i.id === cebolla.id).faltante, true);
});

// ---------- 3 · viaje que nadie toma ----------

test('un viaje sin repartidor sube de tarifa cada 5 minutos, hasta un tope', async () => {
  const { pedidoId } = await pedidoDe(await nuevoCliente('cli-0004'));
  const s = await sub(pedidoId);
  await aceptarOferta(s.id, 'f-jose');
  const viaje = (await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId))!;
  assert.equal(await escalarViajes(), 0, 'recién creado no sube');

  await ejecutar(`UPDATE viajes SET creado_at = now() - interval '6 minutes' WHERE id = ?`, viaje.id);
  assert.equal(await escalarViajes(), 1);
  assert.equal((await consultarUno<Fila>('SELECT tarifa FROM viajes WHERE id = ?', viaje.id))!.tarifa, viaje.tarifa + 500);
  assert.equal(await escalarViajes(), 0, 'no vuelve a subir en el mismo escalón');

  await ejecutar(`UPDATE viajes SET creado_at = now() - interval '90 minutes' WHERE id = ?`, viaje.id);
  await escalarViajes();
  assert.equal((await consultarUno<Fila>('SELECT tarifa FROM viajes WHERE id = ?', viaje.id))!.tarifa, viaje.tarifa + 2000, 'tope de cuatro alzas');

  await aceptarViaje(viaje.id, 'r-diego');
  assert.equal(await escalarViajes(), 0, 'tomado ya no sube');
});

// ---------- 4 · hora estimada ----------

test('la hora estimada existe mientras el pedido viaja y baja al acercarse', () => {
  const pedido = { lat: -33.0458, lng: -71.6197 } as Fila;
  assert.equal(estimarLlegada(pedido, null, 0), null);
  assert.equal(estimarLlegada(pedido, { estado: 'ENTREGADO' } as Fila, 0), null);
  const esperando = estimarLlegada(pedido, { estado: 'ASIGNADO' } as Fila, 2)!;
  const lejos = estimarLlegada(pedido, { estado: 'EN_RUTA', lat: -33.06, lng: -71.60 } as Fila, 0)!;
  const cerca = estimarLlegada(pedido, { estado: 'EN_RUTA', lat: -33.0460, lng: -71.6195 } as Fila, 0)!;
  assert.ok(esperando >= 8, `con dos retiros pendientes: ${esperando}`);
  assert.ok(lejos > cerca && cerca >= 2 && cerca <= 5, `lejos ${lejos}, cerca ${cerca}`);
});

// ---------- 6 · calificación ----------

test('calificar: una vez, solo el dueño, solo entregado; pesa en el puesto y avisa si es mala', async () => {
  const cliente = await nuevoCliente('cli-0006');
  const { pedidoId, entrega } = await hastaLaPuerta(cliente);
  await assert.rejects(() => calificar(pedidoId, cliente, 5, ''), /ya llegó/);
  await entregarConCodigo(entrega.id, 'r-diego');

  await assert.rejects(() => calificar(pedidoId, 'otro-cliente', 5, ''), /no encontrado/);
  await assert.rejects(() => calificar(pedidoId, cliente, 9, ''), /1 a 5/);
  await calificar(pedidoId, cliente, 2, 'Los tomates llegaron golpeados');
  await assert.rejects(() => calificar(pedidoId, cliente, 5, ''), /ya tiene/);

  const jose = (await consultarUno<Fila>(`SELECT estrellas_suma, estrellas_n FROM feriantes WHERE id = 'f-jose'`))!;
  const diego = (await consultarUno<Fila>(`SELECT estrellas_suma, estrellas_n FROM repartidores WHERE id = 'r-diego'`))!;
  assert.deepEqual([jose.estrellas_suma, jose.estrellas_n, diego.estrellas_suma, diego.estrellas_n], [2, 1, 2, 1]);
  assert.equal((await pedidoCompleto(pedidoId))!.calificacion.estrellas, 2);

  await revisarYAvisar(3);
  assert.ok(correos.some((c) => /2 estrellas/.test(c) && /golpeados/.test(c)));
});

// ---------- 7 · compensar ----------

test('compensar devuelve una parte, con motivo, y se acumula con otras devoluciones', async () => {
  const { pedidoId } = await pedidoDe(await nuevoCliente('cli-0007'));
  await assert.rejects(() => compensar(pedidoId, 0, 'pesaba menos', 'op'), /cuánto/);
  await assert.rejects(() => compensar(pedidoId, 500, '', 'op'), /motivo/);
  await assert.rejects(() => compensar(pedidoId, 99_999_999, 'pesaba menos', 'op'), /más de lo que se pagó/);
  const pago = await consultarUno<Fila>('SELECT id FROM pagos WHERE pedido_id = ?', pedidoId);
  if (!pago) return; // sin registro de pago (pedido confirmado directo) no hay qué devolver
  await compensar(pedidoId, 500, 'la malla pesaba menos', 'op');
  await compensar(pedidoId, 300, 'un tomate golpeado', 'op');
  assert.equal((await consultarUno<Fila>('SELECT monto_reembolsado FROM pagos WHERE id = ?', pago.id))!.monto_reembolsado, 800);
});

// ---------- 8 · repartidores por feria ----------

test('un repartidor con feria asignada ve solo los viajes de su feria', async () => {
  const { pedidoId } = await pedidoDe(await nuevoCliente('cli-0008'));
  await aceptarOferta((await sub(pedidoId)).id, 'f-jose');
  assert.equal((await viajesDisponibles()).length, 1, 'sin feria ve todos');
  assert.equal((await viajesDisponibles(FERIA_ID)).length, 1);
  assert.equal((await viajesDisponibles('feria-otra')).length, 0);
});

// ---------- 9 · nota para el repartidor ----------

test('el cliente deja una nota mientras el pedido no llega; otro no puede', async () => {
  const cliente = await nuevoCliente('cli-0009');
  const { pedidoId, entrega } = await hastaLaPuerta(cliente);
  await assert.rejects(() => anotarParaElRepartidor(pedidoId, 'otro', 'hola'), /no encontrado/);
  await anotarParaElRepartidor(pedidoId, cliente, 'Toca el timbre de abajo, depto 3');
  assert.match((await viajeActivo('r-diego'))!.notas, /timbre de abajo/);
  await entregarConCodigo(entrega.id, 'r-diego');
  await assert.rejects(() => anotarParaElRepartidor(pedidoId, cliente, 'tarde'), /cerrado/);
});

// ---------- 10 · pagos de otros días ----------

test('el feriante ve los pagos que le hicieron y todavía no confirmó, de cualquier día', async () => {
  const cliente = await nuevoCliente('cli-0010');
  const { entrega } = await hastaLaPuerta(cliente);
  await entregarConCodigo(entrega.id, 'r-diego');
  assert.equal((await pagosPorConfirmar('f-jose')).length, 0);
  const liq = await calcularLiquidacion('f-jose');
  await marcarPagado('f-jose');
  // Como si el pago hubiera sido ayer.
  await ejecutar(`UPDATE liquidaciones SET fecha = fecha - 1 WHERE feriante_id = 'f-jose'`);
  const pendientes = await pagosPorConfirmar('f-jose');
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].monto, liq.total);
  assert.match(pendientes[0].fecha, /^\d{4}-\d{2}-\d{2}$/);
});
