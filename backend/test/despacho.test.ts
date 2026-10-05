import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import {
  crearPedido, aceptarOferta, rechazarOferta, liberarSubPedido, marcarListo, tick,
  OfertaNoDisponible,
} from '../src/dominio/despacho.ts';
import { aceptarViaje, completarParada, ViajeNoDisponible } from '../src/dominio/reparto.ts';
import { calcularLiquidacion, marcarPagado, confirmarRecepcion } from '../src/dominio/liquidaciones.ts';
import { ofertasAbiertas, colaAutogestion, viajeActivo, metricas } from '../src/dominio/consultas.ts';

before(async () => {
  // PGlite en memoria: PostgreSQL de verdad, sin nada que instalar.
  await abrirDB({ memoria: true });
});

after(async () => {
  await cerrarDB();
});

beforeEach(limpiarYSembrar);

const pedidoBase = (items: Array<{ productoId: string; cantidad: number }>) => ({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items,
});

const subs = (pedidoId: string) =>
  consultar<Fila>('SELECT * FROM sub_pedidos WHERE pedido_id = ? ORDER BY rubro_id', pedidoId);

/** Fuerza el vencimiento de la ronda abierta sin esperar 90 segundos. */
const vencerRonda = async () => {
  await ejecutar(`UPDATE ofertas SET expira_at = now() - interval '1 minute'
                   WHERE respuesta IS NULL`);
  await tick();
};

// ============================================================

test('parte el pedido en un sub-pedido por rubro', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([
    { productoId: 'p-tomate', cantidad: 2 },   // verduras
    { productoId: 'p-cebolla', cantidad: 1 },  // verduras
    { productoId: 'p-palta', cantidad: 1 },    // frutas
    { productoId: 'p-merluza', cantidad: 1 },  // pescado
  ]));

  const s = await subs(pedidoId);
  assert.equal(s.length, 3, 'tres rubros → tres sub-pedidos');
  assert.deepEqual(s.map((x) => x.rubro_id), ['frutas', 'pescado', 'verduras']);
  assert.ok(s.every((x) => x.estado === 'OFERTANDO'), 'todos salen a ofertar de inmediato');

  const verduras = s.find((x) => x.rubro_id === 'verduras')!;
  assert.equal(verduras.monto_feriante, 1500 * 2 + 1200, 'monto al feriante = suma de costos');

  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(pedido!.total_productos, 2200 * 2 + 1900 + 5900 + 6500);
  assert.equal(pedido!.costo_despacho, 2500, 'se le cobra el despacho');
  assert.equal(pedido!.total_venta, pedido!.total_productos + 2500);
  assert.equal(pedido!.estado, 'DESPACHANDO');
});

test('los números de pedido son correlativos y no se repiten', async () => {
  const a = await pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 4 }]));
  const b = await pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 4 }]));
  assert.equal(b.numero, a.numero + 1);
});

test('solo se ofrece a feriantes del rubro que están conectados', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));
  const sub = (await subs(pedidoId))[0];

  const ofrecidos = (await consultar<Fila>(
    'SELECT feriante_id FROM ofertas WHERE sub_pedido_id = ?', sub.id)).map((o) => o.feriante_id);
  assert.deepEqual(ofrecidos.sort(), ['f-pedro', 'f-rosa'], 'solo las pescaderías');
});

test('el primer feriante que acepta se lo queda; el segundo recibe error', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));
  const sub = (await subs(pedidoId))[0];

  await aceptarOferta(sub.id, 'f-pedro');
  await assert.rejects(() => aceptarOferta(sub.id, 'f-rosa'), OfertaNoDisponible);

  const despues = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', sub.id);
  assert.equal(despues!.estado, 'ACEPTADO');
  assert.equal(despues!.feriante_id, 'f-pedro');

  // Al perdedor no se le cuenta como rechazo ni como timeout: no
  // hizo nada malo, y castigarlo arruinaría su reputación.
  const rosa = await consultarUno<Fila>('SELECT * FROM feriantes WHERE id = ?', 'f-rosa');
  assert.equal(rosa!.rechazos, 0);
  assert.equal(rosa!.timeouts, 0);
  const oferta = await consultarUno<Fila>(
    'SELECT * FROM ofertas WHERE sub_pedido_id = ? AND feriante_id = ?', sub.id, 'f-rosa');
  assert.equal(oferta!.respuesta, 'CERRADA');
});

test('dos feriantes aceptando a la vez: gana uno solo', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));
  const sub = (await subs(pedidoId))[0];

  // Las dos promesas arrancan antes de que ninguna termine: es la
  // carrera real de dos dedos apretando el botón en el mismo segundo.
  const resultados = await Promise.allSettled([
    aceptarOferta(sub.id, 'f-pedro'),
    aceptarOferta(sub.id, 'f-rosa'),
  ]);

  const ganadores = resultados.filter((r) => r.status === 'fulfilled');
  assert.equal(ganadores.length, 1, 'exactamente uno gana');
  assert.ok(resultados.some((r) => r.status === 'rejected'), 'el otro recibe error');

  const despues = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', sub.id);
  assert.equal(despues!.estado, 'ACEPTADO');
});

test('la cascada amplía el público ronda a ronda y termina en autogestión', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));
  const sub = (await subs(pedidoId))[0];

  const cuenta = await consultarUno<Fila>(
    'SELECT COUNT(*)::int AS n FROM ofertas WHERE sub_pedido_id = ? AND ronda = 1', sub.id);
  assert.equal(cuenta!.n, 2, 'ronda 1: las dos pescaderías');

  await vencerRonda();
  // La ronda 2 no agrega a nadie nuevo del rubro, así que la cascada
  // sigue hasta la 3, que abre a toda la feria.
  const ronda3 = await consultar<Fila>(
    'SELECT * FROM ofertas WHERE sub_pedido_id = ? AND ronda = 3', sub.id);
  assert.ok(ronda3.length >= 5, 'la ronda 3 sale a toda la feria');

  await vencerRonda();
  const final = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', sub.id);
  assert.equal(final!.estado, 'AUTOGESTION', 'nadie aceptó → lo compra el operador');
  assert.equal(final!.autogestionado, true);

  assert.equal((await colaAutogestion()).length, 1, 'aparece en la cola del operador');
});

test('si no hay ningún feriante conectado, va directo a autogestión', async () => {
  await ejecutar('UPDATE feriantes SET conectado = false');
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 4 }]));

  const s = (await subs(pedidoId))[0];
  assert.equal(s.estado, 'AUTOGESTION');

  // Y el pedido igual avanza: el cliente nunca se entera de que
  // nadie lo tomó.
  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(pedido!.estado, 'EN_PREPARACION');
  assert.ok(await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId),
    'se crea el viaje igual');
});

test('cuando todos rechazan no se espera a que venza la ventana', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));
  const sub = (await subs(pedidoId))[0];

  await rechazarOferta(sub.id, 'f-pedro');
  const medio = await consultarUno<Fila>('SELECT ronda FROM sub_pedidos WHERE id = ?', sub.id);
  assert.equal(medio!.ronda, 1);

  await rechazarOferta(sub.id, 'f-rosa');
  const despues = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', sub.id);
  assert.ok(despues!.ronda > 1 || despues!.estado === 'AUTOGESTION',
    'con el último rechazo avanza sin esperar');
});

test('un feriante que se arrepiente devuelve el pedido a la cascada', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 4 }]));
  const sub = (await subs(pedidoId))[0];

  await aceptarOferta(sub.id, 'f-jose');
  await liberarSubPedido(sub.id, 'f-jose');

  const despues = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', sub.id);
  assert.equal(despues!.estado, 'OFERTANDO', 'vuelve a ofrecerse');
  assert.equal(despues!.feriante_id, null);

  const jose = await consultarUno<Fila>('SELECT * FROM feriantes WHERE id = ?', 'f-jose');
  assert.equal(jose!.incumplidos, 1, 'queda registrado el incumplimiento');

  const abiertas = await consultar<Fila>(
    'SELECT * FROM ofertas WHERE sub_pedido_id = ? AND respuesta IS NULL', sub.id);
  assert.ok(!abiertas.some((o) => o.feriante_id === 'f-jose'),
    'no se le vuelve a ofrecer el mismo');
});

test('el viaje agrupa las paradas por puesto y cobra por parada extra', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([
    { productoId: 'p-tomate', cantidad: 1 },   // verduras
    { productoId: 'p-palta', cantidad: 1 },    // frutas
  ]));
  const s = await subs(pedidoId);

  // Ana vende verduras y frutas: si toma los dos, es una sola parada.
  for (const x of s) await aceptarOferta(x.id, 'f-ana');

  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId);
  const paradas = await consultar<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', viaje!.id);

  assert.equal(paradas.length, 2, 'un retiro + una entrega');
  assert.equal(paradas[0].tipo, 'RETIRO');
  assert.match(paradas[0].etiqueta, /Ana Poblete/);
  assert.equal(paradas[1].tipo, 'ENTREGA');
  assert.equal(viaje!.tarifa, 2500, 'un solo puesto → tarifa base');
});

test('flujo completo: pedido mixto hasta entregado', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([
    { productoId: 'p-tomate', cantidad: 2 },
    { productoId: 'p-merluza', cantidad: 1 },
  ]));
  const s = await subs(pedidoId);
  const verduras = s.find((x) => x.rubro_id === 'verduras')!;
  const pescado = s.find((x) => x.rubro_id === 'pescado')!;

  await aceptarOferta(verduras.id, 'f-jose');
  await aceptarOferta(pescado.id, 'f-pedro');

  let p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'EN_PREPARACION');

  await marcarListo(verduras.id);
  await marcarListo(pescado.id);
  p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'LISTO_PARA_RETIRO');

  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId);
  assert.equal(viaje!.tarifa, 3000, 'dos puestos → base + 500');
  await aceptarViaje(viaje!.id, 'r-diego');
  await assert.rejects(() => aceptarViaje(viaje!.id, 'r-sofia'), ViajeNoDisponible);

  const activo = (await viajeActivo('r-diego'))!;
  assert.equal(activo.paradas.length, 3);
  assert.ok(activo.paradas[0].items.length > 0, 'el repartidor ve qué retira en cada puesto');

  // No se puede saltar una parada.
  await assert.rejects(
    () => completarParada(activo.paradas[1].id, 'r-diego'), ViajeNoDisponible);

  await completarParada(activo.paradas[0].id, 'r-diego');
  await completarParada(activo.paradas[1].id, 'r-diego');
  p = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.estado, 'EN_RUTA');

  await completarParada(activo.paradas[2].id, 'r-diego');
  const final = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(final!.estado, 'ENTREGADO');
  assert.ok(final!.entregado_at);
});

test('la liquidación solo cuenta lo que el repartidor efectivamente retiró', async () => {
  const { pedidoId } = await pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 4 }]));
  const sub = (await subs(pedidoId))[0];
  await aceptarOferta(sub.id, 'f-jose');

  assert.equal((await calcularLiquidacion('f-jose')).total, 0,
    'aceptado pero no retirado no se paga');

  await marcarListo(sub.id);
  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId);
  await aceptarViaje(viaje!.id, 'r-diego');
  const paradas = await consultar<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', viaje!.id);
  await completarParada(paradas[0].id, 'r-diego');

  const liq = await calcularLiquidacion('f-jose');
  assert.equal(liq.total, 1500 * 4);
  assert.equal(liq.cantidad, 1);

  const pagada = await marcarPagado('f-jose');
  assert.ok(pagada.pagadoAt);
  assert.equal(pagada.confirmadoAt, null);

  const confirmada = await confirmarRecepcion('f-jose');
  assert.ok(confirmada.confirmadoAt, 'el feriante confirma que recibió la plata');
});

test('el feriante ve la oferta con los items y el monto que va a cobrar', async () => {
  await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));

  const abiertas = await ofertasAbiertas('f-pedro');
  assert.equal(abiertas.length, 1);
  assert.equal(abiertas[0].monto_feriante, 4800 * 2);
  assert.equal(abiertas[0].items[0].nombre, 'Merluza');
  assert.equal(abiertas[0].items[0].cantidad, 2);
});

test('las métricas reflejan aceptación y autogestión', async () => {
  await pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 4 }]));
  const s1 = (await consultar<Fila>('SELECT * FROM sub_pedidos'))[0];
  await aceptarOferta(s1.id, 'f-jose');

  await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));
  await vencerRonda();
  await vencerRonda();

  const m = await metricas();
  assert.equal(m.pedidos.total, 2);
  assert.equal(m.ofertas.aceptadas, 1);
  assert.equal(m.subPedidos.autogestion, 1);
  assert.equal(m.subPedidos.tasaAutogestion, 0.5);
  assert.ok(m.ofertas.tasaAceptacion !== null);
});

test('la autogestión sigue contando después de que el pedido avanza', async () => {
  await pedidoPagado(pedidoBase([{ productoId: 'p-merluza', cantidad: 2 }]));
  await vencerRonda();
  await vencerRonda();

  const sub = (await colaAutogestion())[0];
  await marcarListo(sub.id);

  const m = await metricas();
  assert.equal(m.subPedidos.autogestion, 1, 'la marca sobrevive al cambio de estado');
  assert.equal(m.subPedidos.pendientes, 0, 'pero ya no está pendiente de comprar');
});

test('rechaza cantidades inválidas y productos inexistentes', async () => {
  await assert.rejects(() => pedidoPagado(pedidoBase([{ productoId: 'p-nope', cantidad: 1 }])));
  await assert.rejects(() => pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 0 }])));
  await assert.rejects(() => pedidoPagado(pedidoBase([{ productoId: 'p-tomate', cantidad: 1.5 }])));
  await assert.rejects(() => pedidoPagado(pedidoBase([])));

  const n = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM pedidos');
  assert.equal(n!.n, 0, 'ningún pedido a medias queda en la base');
});
