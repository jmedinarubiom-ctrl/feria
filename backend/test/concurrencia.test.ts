/**
 * Carreras de verdad.
 *
 * PGlite tiene una sola conexión y atiende de a una transacción:
 * ahí estas carreras no existen. Con Postgres hay un pool, y dos
 * peticiones que llegan juntas corren juntas. Por eso estos tests
 * solo corren con `DATABASE_URL` (ver `npm run test:postgres`).
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import {
  crearPedido, confirmarPago, aceptarOferta, tick,
} from '../src/dominio/despacho.ts';
import { aceptarViaje } from '../src/dominio/reparto.ts';
import { completarParada } from './ayuda.ts';
import { pedirCodigo, crearSesion } from '../src/dominio/auth.ts';
import { fijarPasarela } from '../src/dominio/pagos.ts';

const saltar = !process.env.DATABASE_URL && 'solo con Postgres real (DATABASE_URL)';

before(async () => { if (!saltar) await abrirDB(); });
after(async () => { if (!saltar) await cerrarDB(); });
beforeEach(async () => {
  if (saltar) return;
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

const resultados = async <T>(tareas: Array<Promise<T>>) => {
  const r = await Promise.allSettled(tareas);
  return {
    bien: r.filter((x) => x.status === 'fulfilled').length,
    mal: r.filter((x) => x.status === 'rejected').length,
    valores: r.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : [])),
  };
};

test('tres feriantes aceptan a la vez: gana uno solo', { skip: saltar }, async () => {
  const { pedidoId } = await pedidoPagado(base([{ productoId: 'p-tomate', cantidad: 4 }]));
  const sub = (await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;

  const r = await resultados(['f-jose', 'f-ana', 'f-luis'].map((f) => aceptarOferta(sub.id, f)));
  assert.equal(r.bien, 1);
  assert.equal(r.mal, 2);

  const aceptadas = await consultar(
    `SELECT id FROM ofertas WHERE sub_pedido_id = ? AND respuesta = 'ACEPTA'`, sub.id);
  assert.equal(aceptadas.length, 1);
  const viajes = await consultar('SELECT id FROM viajes WHERE pedido_id = ?', pedidoId);
  assert.equal(viajes.length, 1);
});

test('el pago confirmado por tres caminos a la vez despacha una sola vez', { skip: saltar }, async () => {
  const { pedidoId } = await crearPedido(base([
    { productoId: 'p-tomate', cantidad: 4 }, { productoId: 'p-palta', cantidad: 2 },
  ]));

  // Webhook, revisión periódica y la app preguntando: llegan juntos.
  const r = await resultados([1, 2, 3].map(() => confirmarPago(pedidoId)));
  assert.equal(r.valores.filter(Boolean).length, 1);

  const repetidas = await consultar(
    `SELECT sub_pedido_id, feriante_id, COUNT(*)::int AS n FROM ofertas
      GROUP BY 1, 2 HAVING COUNT(*) > 1`);
  assert.equal(repetidas.length, 0);
});

test('aceptar justo cuando vence la ronda no deja el pedido con dos dueños', { skip: saltar }, async () => {
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    await limpiarYSembrar();
    const { pedidoId } = await pedidoPagado(base([{ productoId: 'p-tomate', cantidad: 4 }]));
    const sub = (await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;

    // La oferta vence en la base pero el feriante alcanza a tocar:
    // el reloj y la aceptación corren a la vez.
    await ejecutar(`UPDATE ofertas SET expira_at = now() WHERE sub_pedido_id = ?`, sub.id);
    await Promise.allSettled([tick(), aceptarOferta(sub.id, 'f-jose')]);

    const final = (await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', sub.id))!;
    const abiertas = await consultar(
      'SELECT id FROM ofertas WHERE sub_pedido_id = ? AND respuesta IS NULL', sub.id);
    if (final.estado === 'ACEPTADO') {
      assert.equal(final.feriante_id, 'f-jose');
      assert.equal(abiertas.length, 0, 'aceptado y todavía ofertándose');
    } else {
      assert.equal(final.estado, 'OFERTANDO');
      assert.equal(final.feriante_id, null, 'ofertándose con dueño');
    }
  }
});

test('dos repartidores toman el mismo viaje: uno solo se lo queda', { skip: saltar }, async () => {
  const { pedidoId } = await pedidoPagado(base([{ productoId: 'p-tomate', cantidad: 4 }]));
  const sub = (await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;
  await aceptarOferta(sub.id, 'f-jose');
  const viaje = (await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId))!;

  const r = await resultados(['r-diego', 'r-sofia'].map((x) => aceptarViaje(viaje.id, x)));
  assert.equal(r.bien, 1);
});

test('dos toques a ENTREGADO no rompen nada', { skip: saltar }, async () => {
  const { pedidoId } = await pedidoPagado(base([{ productoId: 'p-tomate', cantidad: 4 }]));
  const sub = (await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;
  await aceptarOferta(sub.id, 'f-jose');
  const viaje = (await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId))!;
  await aceptarViaje(viaje.id, 'r-diego');
  const paradas = await consultar<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', viaje.id);

  const retiro = await resultados([1, 2].map(() => completarParada(paradas[0].id, 'r-diego')));
  assert.equal(retiro.mal, 0);
  const entrega = await resultados([1, 2].map(() => completarParada(paradas[1].id, 'r-diego')));
  assert.equal(entrega.mal, 0);

  const eventos = await consultar(
    `SELECT id FROM eventos WHERE entidad_id = ? AND tipo = '-> ENTREGADO'`, pedidoId);
  assert.equal(eventos.length, 1);
});

test('el mismo código canjeado dos veces a la vez da una sola sesión', { skip: saltar }, async () => {
  const { codigoDev } = await pedirCodigo('+56911111111');
  const r = await resultados([1, 2].map(() => crearSesion('+56911111111', codigoDev!, 'test')));
  assert.equal(r.bien, 1);
  const sesiones = await consultar('SELECT id FROM sesiones');
  assert.equal(sesiones.length, 1);
});
