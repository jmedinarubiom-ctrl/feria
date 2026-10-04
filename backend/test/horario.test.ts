import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultarUno, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar } from './ayuda.ts';
import { crearPedido } from '../src/dominio/despacho.ts';
import { estadoFeria, fijarHorario, momentoLocal, FeriaCerrada } from '../src/dominio/horario.ts';

/** Horario real de la Av. Argentina: miércoles y sábado. */
const REAL = { dias: [3, 6], abre: '07:00', ultimoPedido: '13:30', cierra: '15:00' };
/** Feria abierta siempre, para el resto de los tests. */
const ABIERTA = { dias: [0, 1, 2, 3, 4, 5, 6], abre: '00:00', ultimoPedido: '23:59', cierra: '23:59' };

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { fijarHorario(ABIERTA); await cerrarDB(); });
beforeEach(async () => {
  await limpiarYSembrar();
  fijarHorario(REAL);
});

/** Un instante concreto en hora de Chile. */
const enChile = (iso: string) => new Date(iso);

// Sábado 29 de agosto de 2026. Chile está en UTC-4 en invierno.
const sabado = (hhmm: string) => enChile(`2026-08-29T${hhmm}:00-04:00`);
const martes = (hhmm: string) => enChile(`2026-08-25T${hhmm}:00-04:00`);

// ============================================================

test('la hora se calcula en Valparaíso, no en el servidor', () => {
  // Las 23:00 UTC de un sábado son las 19:00 del sábado en Chile.
  const m = momentoLocal(new Date('2026-08-29T23:00:00Z'));
  assert.equal(m.dia, 6, 'sigue siendo sábado');
  assert.equal(m.minutos, 19 * 60);
});

test('el sábado a media mañana está tomando pedidos', () => {
  const e = estadoFeria(sabado('09:30'));
  assert.equal(e.abierta, true);
  assert.equal(e.aceptandoPedidos, true);
  assert.equal(e.minutosParaCerrar, 4 * 60);
});

test('un martes está cerrada y dice cuándo abre', () => {
  const e = estadoFeria(martes('10:00'));
  assert.equal(e.abierta, false);
  assert.equal(e.aceptandoPedidos, false);
  assert.deepEqual(e.proxima, { dia: 'miércoles', hora: '07:00' });
  assert.match(e.mensaje, /cerrada/);
  assert.match(e.mensaje, /miércoles/);
});

test('antes de abrir un día de feria dice que abre hoy', () => {
  const e = estadoFeria(sabado('06:00'));
  assert.equal(e.aceptandoPedidos, false);
  assert.deepEqual(e.proxima, { dia: 'hoy', hora: '07:00' });
});

test('deja de tomar pedidos antes de que cierre la feria', () => {
  // A las 14:00 todavía hay puestos, pero entre ofertar, preparar,
  // recorrer y entregar no se alcanza antes del cierre.
  const e = estadoFeria(sabado('14:00'));
  assert.equal(e.abierta, true, 'la feria sigue abierta');
  assert.equal(e.aceptandoPedidos, false, 'pero ya no da el tiempo');
  assert.match(e.mensaje, /no alcanzamos a repartir/);
});

test('justo en el límite todavía entra', () => {
  assert.equal(estadoFeria(sabado('13:29')).aceptandoPedidos, true);
  assert.equal(estadoFeria(sabado('13:30')).aceptandoPedidos, false);
  assert.equal(estadoFeria(sabado('07:00')).aceptandoPedidos, true);
  assert.equal(estadoFeria(sabado('06:59')).aceptandoPedidos, false);
});

test('no se puede pedir con la feria cerrada', async () => {
  // El horario real está puesto; salvo que hoy sea miércoles o
  // sábado en horario de feria, esto tiene que rechazar.
  const ahora = estadoFeria();
  const pedir = () => crearPedido({
    feriaId: FERIA_ID,
    clienteNombre: 'Juan Manuel',
    clienteTelefono: '+56999999999',
    direccion: 'Subida Ecuador 123',
    lat: -33.0458, lng: -71.6197,
    items: [{ productoId: 'p-tomate', cantidad: 4 }],
  });

  if (ahora.aceptandoPedidos) {
    await pedir();   // si justo estamos en feria, tiene que dejar
  } else {
    await assert.rejects(pedir, FeriaCerrada);
  }
});

test('con la feria abierta el pedido entra normal', async () => {
  fijarHorario(ABIERTA);
  const r = await crearPedido({
    feriaId: FERIA_ID,
    clienteNombre: 'Juan Manuel',
    clienteTelefono: '+56999999999',
    direccion: 'Subida Ecuador 123',
    lat: -33.0458, lng: -71.6197,
    items: [{ productoId: 'p-tomate', cantidad: 4 }],
  });
  assert.ok(r.pedidoId);
});

test('un pedido con dirección que no se puede ubicar entra igual', async () => {
  // Con el geocodificador apagado (o caído) el pedido no puede
  // fallar: el repartidor lee la dirección escrita, que es lo que
  // hacía antes de que esto existiera.
  fijarHorario(ABIERTA);
  const r = await crearPedido({
    feriaId: FERIA_ID,
    clienteNombre: 'Juan Manuel',
    clienteTelefono: '+56999999999',
    direccion: 'Una calle que no está en ningún mapa 9999',
    lat: -33.0458, lng: -71.6197,
    items: [{ productoId: 'p-tomate', cantidad: 4 }],
  });
  assert.ok(r.pedidoId);

  const p = await consultarUno<Fila>(
    'SELECT lat, lng, geo_precision FROM pedidos WHERE id = ?', r.pedidoId);
  assert.equal(p!.geo_precision, 'informada por la app',
    'si la app mandó un punto, se usa ese antes que el de la feria');
  assert.equal(Number(p!.lat).toFixed(4), '-33.0458');
});
