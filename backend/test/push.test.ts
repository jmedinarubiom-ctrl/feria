import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import {
  enviarPush, fijarTransporte, restaurarTransporte, iniciarNotificaciones, type MensajePush,
} from '../src/realtime/push.ts';
import { crearPedido, aceptarOferta, tick } from '../src/dominio/despacho.ts';

/** Todo lo que "se envió", sin salir a internet. */
let enviados: MensajePush[] = [];
let respuestaFalsa: (lote: MensajePush[]) => any = (lote) => ({
  data: lote.map(() => ({ status: 'ok', id: 'x' })),
});

before(async () => {
  await abrirDB({ memoria: true });
  fijarTransporte(async (lote) => {
    enviados.push(...lote);
    return respuestaFalsa(lote);
  });
  iniciarNotificaciones();
});

after(async () => {
  restaurarTransporte();
  await cerrarDB();
});

beforeEach(async () => {
  await limpiarYSembrar();
  enviados = [];
  respuestaFalsa = (lote) => ({ data: lote.map(() => ({ status: 'ok', id: 'x' })) });
  // Todos con teléfono registrado, que es el caso normal en la feria.
  await ejecutar(`UPDATE feriantes SET push_token = 'ExponentPushToken[' || id || ']'`);
  await ejecutar(`UPDATE repartidores SET push_token = 'ExponentPushToken[' || id || ']'`);
  await ejecutar(`UPDATE operadores SET push_token = 'ExponentPushToken[' || id || ']'`);
});

const pedido = (items: Array<{ productoId: string; cantidad: number }>) => pedidoPagado({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items,
});

/** Los avisos salen tras el COMMIT y en tareas aparte: hay que dejarlas correr. */
const dejarSalir = () => new Promise((r) => setTimeout(r, 60));

// ============================================================

test('al feriante le llega el monto en el título', async () => {
  await pedido([{ productoId: 'p-merluza', cantidad: 2 }]);
  await dejarSalir();

  const suyos = enviados.filter((m) => m.to.includes('f-pedro'));
  assert.equal(suyos.length, 1);
  // El monto es lo único que se lee en la pantalla bloqueada.
  assert.match(suyos[0].title, /\$9\.600/);
  assert.match(suyos[0].title, /Pescados/);
  assert.equal(suyos[0].body, '2× Merluza');
});

test('solo se avisa a los feriantes del rubro', async () => {
  await pedido([{ productoId: 'p-merluza', cantidad: 2 }]);
  await dejarSalir();

  const destinos = enviados.map((m) => m.to);
  assert.equal(destinos.length, 2, 'las dos pescaderías');
  assert.ok(destinos.some((d) => d.includes('f-pedro')));
  assert.ok(destinos.some((d) => d.includes('f-rosa')));
  assert.ok(!destinos.some((d) => d.includes('f-jose')), 'el verdulero no recibe nada');
});

test('el aviso vence junto con la oferta', async () => {
  await pedido([{ productoId: 'p-tomate', cantidad: 4 }]);
  await dejarSalir();

  const aviso = enviados[0];
  // Un aviso que llega después de que venció la oferta manda al
  // feriante a una pantalla vacía. Expo lo descarta con el TTL.
  assert.ok(aviso.ttl! > 0 && aviso.ttl! <= 90, `ttl fuera de rango: ${aviso.ttl}`);
  assert.equal(aviso.priority, 'high');
  assert.equal(aviso.interruptionLevel, 'timeSensitive');
  assert.equal(aviso.channelId, 'ofertas');
});

test('no se avisa a quien no registró su teléfono', async () => {
  await ejecutar(`UPDATE feriantes SET push_token = NULL WHERE id = 'f-pedro'`);
  await pedido([{ productoId: 'p-merluza', cantidad: 2 }]);
  await dejarSalir();

  assert.ok(!enviados.some((m) => m.to.includes('f-pedro')));
  assert.ok(enviados.some((m) => m.to.includes('f-rosa')), 'los demás sí');
});

test('el viaje se avisa a los repartidores conectados', async () => {
  const { pedidoId } = await pedido([{ productoId: 'p-tomate', cantidad: 4 }]);
  enviados = [];

  const sub = await consultarUno<Fila>(
    'SELECT id FROM sub_pedidos WHERE pedido_id = ?', pedidoId);
  await aceptarOferta(sub!.id, 'f-jose');
  await dejarSalir();

  const viajes = enviados.filter((m) => m.channelId === 'viajes');
  assert.equal(viajes.length, 2, 'los dos repartidores');
  assert.match(viajes[0].title, /\$2\.500/);
});

test('cuando nadie acepta, el aviso le llega al operador', async () => {
  await pedido([{ productoId: 'p-merluza', cantidad: 2 }]);
  await ejecutar(`UPDATE ofertas SET expira_at = now() - interval '1 minute'`);
  await tick();
  await ejecutar(`UPDATE ofertas SET expira_at = now() - interval '1 minute'`);
  await tick();
  await dejarSalir();

  const alOperador = enviados.filter((m) => m.channelId === 'autogestion');
  assert.equal(alOperador.length, 1);
  assert.match(alOperador[0].title, /Nadie tomó/);
  assert.match(alOperador[0].body, /comprar tú/);
});

test('un teléfono que desinstaló la app se limpia solo', async () => {
  respuestaFalsa = (lote) => ({
    data: lote.map(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } })),
  });

  const r = await enviarPush([{
    to: 'ExponentPushToken[f-jose]', title: 'x', body: 'y',
  }]);

  assert.equal(r.enviados, 0);
  assert.equal(r.fallidos, 1);
  const jose = await consultarUno<Fila>('SELECT push_token FROM feriantes WHERE id = ?', 'f-jose');
  assert.equal(jose!.push_token, null, 'el token muerto se borra');
});

test('si Expo se cae, el despacho sigue funcionando', async () => {
  fijarTransporte(async () => { throw new Error('Expo no responde'); });

  // El pedido tiene que crearse igual: el push es un extra, no un
  // requisito. El aviso por WebSocket ya salió.
  const { pedidoId } = await pedido([{ productoId: 'p-tomate', cantidad: 4 }]);
  await dejarSalir();

  const sub = await consultarUno<Fila>(
    'SELECT estado FROM sub_pedidos WHERE pedido_id = ?', pedidoId);
  assert.equal(sub!.estado, 'OFERTANDO');

  fijarTransporte(async (lote) => {
    enviados.push(...lote);
    return respuestaFalsa(lote);
  });
});

test('los envíos se parten en lotes de 100', async () => {
  const lotes: number[] = [];
  fijarTransporte(async (lote) => {
    lotes.push(lote.length);
    return { data: lote.map(() => ({ status: 'ok' })) };
  });

  const muchos = Array.from({ length: 250 }, (_, i) => ({
    to: `ExponentPushToken[${i}]`, title: 't', body: 'b',
  }));
  const r = await enviarPush(muchos);

  assert.deepEqual(lotes, [100, 100, 50], 'Expo acepta 100 por petición');
  assert.equal(r.enviados, 250);

  fijarTransporte(async (lote) => {
    enviados.push(...lote);
    return respuestaFalsa(lote);
  });
});
