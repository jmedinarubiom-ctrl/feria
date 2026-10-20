import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import { aceptarOferta, cotizar, marcarListo } from '../src/dominio/despacho.ts';
import { aceptarViaje, completarParada, ViajeNoDisponible } from '../src/dominio/reparto.ts';
import { pedidoCompleto, viajesDisponibles } from '../src/dominio/consultas.ts';
import {
  armarRuta, cargarCamion, llegadasDeRuta, ordenarEntregas, pendientesDeRuta, rutaActiva,
} from '../src/dominio/rutas.ts';
import { calcularGananciaRepartidor } from '../src/dominio/liquidaciones.ts';
import { CONFIG } from '../src/config.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(cerrarDB);
beforeEach(limpiarYSembrar);

/** Un pedido programado, pagado y aceptado por el feriante. */
async function programado(nombre: string, lat: number, lng: number): Promise<string> {
  const { pedidoId } = await pedidoPagado({
    feriaId: FERIA_ID, clienteNombre: nombre, clienteTelefono: '+56987650001',
    direccion: `Calle de ${nombre} 123`, lat, lng, puntoMarcado: true,
    items: [{ productoId: 'p-tomate', cantidad: 4 }],
    modalidad: 'PROGRAMADO',
  });
  const s = (await consultarUno<Fila>('SELECT id FROM sub_pedidos WHERE pedido_id = ?', pedidoId))!;
  await aceptarOferta(s.id, 'f-jose');
  return pedidoId;
}

test('el despacho programado es fijo y más barato, y gratis igual con carro grande y cerca', () => {
  const c = cotizar(12_000, { km: 6, rubros: 3, programado: true });
  assert.equal(c.despacho, CONFIG.programado.costo);
  assert.equal(c.modalidad, 'PROGRAMADO');
  assert.equal(cotizar(30_000, { km: 2, programado: true }).despacho, 0);
  assert.equal(cotizar(30_000, { km: 7, programado: true }).despacho, CONFIG.programado.costo);
});

test('el orden de la ruta recorre menos: de lo más cerca a lo más lejos en una línea', () => {
  const origen = { lat: -33.05, lng: -71.60 };
  const puntos = [
    { lat: -33.05, lng: -71.63 }, { lat: -33.05, lng: -71.61 },
    { lat: -33.05, lng: -71.64 }, { lat: -33.05, lng: -71.62 },
  ];
  const { orden, km } = ordenarEntregas(origen, puntos);
  assert.deepEqual(orden, [1, 3, 0, 2]);
  assert.ok(km > 3 && km < 6, `km ${km}`);
  assert.deepEqual(ordenarEntregas(origen, []), { orden: [], km: 0 });
});

test('un programado no se les ofrece a las motos: espera la ruta', async () => {
  const pedidoId = await programado('Ana', -33.045, -71.61);
  const viaje = (await consultarUno<Fila>('SELECT * FROM viajes WHERE pedido_id = ?', pedidoId))!;
  assert.equal(viaje.programado, true);
  assert.equal(viaje.tarifa, CONFIG.programado.pagoPorEntrega);
  assert.equal((await viajesDisponibles()).length, 0);
  assert.equal((await pendientesDeRuta(FERIA_ID)).length, 1);

  const p = (await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId))!;
  assert.equal(p.modalidad, 'PROGRAMADO');
  assert.equal(p.costo_despacho, CONFIG.programado.costo);
  assert.match(p.ventana, /16:00/);
});

test('la ruta del camión de punta a punta: armar, cargar, entregar y cobrar', async () => {
  // Se piden desordenados: lejos, cerca, medio.
  const lejos = await programado('Carla', -33.035, -71.63);
  const cerca = await programado('Ana', -33.046, -71.607);
  const medio = await programado('Berta', -33.04, -71.62);

  const { entregas } = await armarRuta(FERIA_ID, 'r-sofia');
  assert.equal(entregas, 3);
  assert.equal((await pendientesDeRuta()).length, 0);
  await assert.rejects(() => armarRuta(FERIA_ID, 'r-diego'), /No hay pedidos programados/);

  const ruta = (await rutaActiva('r-sofia'))!;
  assert.deepEqual(ruta.entregas.map((e: Fila) => e.pedido_id), [cerca, medio, lejos]);
  assert.equal(ruta.resumen.porCargar, 3);

  // Un viaje de la ruta no lo puede tomar otro repartidor.
  await assert.rejects(() => aceptarViaje(ruta.entregas[0].id, 'r-diego'), ViajeNoDisponible);

  // El feriante termina uno; el camión carga todo de una vez.
  const sub = (await consultarUno<Fila>('SELECT id FROM sub_pedidos WHERE pedido_id = ?', cerca))!;
  await marcarListo(sub.id);
  const carga = await cargarCamion('r-sofia');
  assert.equal(carga.cargados, 3);
  assert.deepEqual(carga.pendientes, []);

  const enCamino = (await rutaActiva('r-sofia'))!;
  assert.equal(enCamino.estado, 'EN_CURSO');
  assert.ok(enCamino.entregas.every((e: Fila) => e.estado === 'EN_RUTA'));

  // Cuándo llega cada uno: en orden, con las entregas de antes.
  const llegadas = await llegadasDeRuta(enCamino.id);
  assert.deepEqual(llegadas.map((l) => l.antes), [0, 1, 2]);
  assert.ok(llegadas[0].minutos < llegadas[1].minutos && llegadas[1].minutos < llegadas[2].minutos);
  const seguimiento = (await pedidoCompleto(lejos))!;
  assert.equal(seguimiento.viaje.entregas_antes, 2);
  assert.equal(seguimiento.viaje.eta_minutos, llegadas[2].minutos);

  for (const e of enCamino.entregas) {
    const codigo = (await consultarUno<Fila>('SELECT codigo_entrega FROM pedidos WHERE id = ?', e.pedido_id))!;
    await completarParada(e.paradaEntregaId, 'r-sofia', { codigo: codigo.codigo_entrega });
  }
  const estados = await consultar<Fila>('SELECT estado FROM pedidos');
  assert.ok(estados.every((p) => p.estado === 'ENTREGADO'));
  const cerrada = (await consultarUno<Fila>('SELECT estado FROM rutas'))!;
  assert.equal(cerrada.estado, 'TERMINADA');
  assert.equal(await rutaActiva('r-sofia'), null);

  // El chofer cobra lo mismo que con cualquier viaje: por entrega.
  const g = await calcularGananciaRepartidor('r-sofia');
  assert.equal(g.cantidad, 3);
  assert.equal(g.total, 3 * CONFIG.programado.pagoPorEntrega);
});

test('no se le arma una ruta a quien ya tiene una sin terminar', async () => {
  await programado('Ana', -33.045, -71.61);
  await armarRuta(FERIA_ID, 'r-sofia');
  await programado('Berta', -33.04, -71.62);
  await assert.rejects(() => armarRuta(FERIA_ID, 'r-sofia'), /ya tiene una ruta/);
});
