import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDB, cerrarDB, consultarUno, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import { avisoAlCliente } from '../src/realtime/push.ts';

before(async () => {
  await abrirDB({ memoria: true });
  await sembrar();
  const feria = await consultarUno<{ id: string }>('SELECT id FROM ferias ORDER BY id LIMIT 1');
  await ejecutar(`INSERT INTO clientes (id, nombre, telefono, push_token) VALUES ('cli-p', 'Ana', '+56987650009', 'ExponentPushToken[abc]')`);
  await ejecutar(`INSERT INTO clientes (id, nombre, telefono) VALUES ('cli-s', 'Sin aviso', '+56987650010')`);
  for (const [id, cli] of [['ped-p', 'cli-p'], ['ped-s', 'cli-s']]) {
    await ejecutar(
      `INSERT INTO pedidos (id, feria_id, cliente_id, cliente_nombre, cliente_telefono, direccion, lat, lng,
                            total_productos, costo_despacho, total_venta, estado)
       VALUES (?, ?, ?, 'Ana', '+56987650009', 'Calle 1', -33.04, -71.61, 3000, 2000, 5000, 'PAGADO')`,
      id, feria!.id, cli);
  }
});
after(cerrarDB);

test('al comprador se le avisa lo que le importa, y nada de los pasos internos', async () => {
  const camino = await avisoAlCliente('ped-p', 'EN_RUTA');
  assert.equal(camino?.to, 'ExponentPushToken[abc]');
  assert.match(camino!.title, /va en camino/);
  assert.equal(camino!.channelId, 'pedidos');

  assert.ok(await avisoAlCliente('ped-p', 'PAGADO'));
  assert.ok(await avisoAlCliente('ped-p', 'ENTREGADO'));
  assert.match((await avisoAlCliente('ped-p', 'CANCELADO'))!.body, /devolvemos/);

  for (const interno of ['DESPACHANDO', 'EN_PREPARACION', 'LISTO_PARA_RETIRO', 'PENDIENTE_PAGO']) {
    assert.equal(await avisoAlCliente('ped-p', interno), null, interno);
  }
});

test('sin teléfono registrado para avisos no se manda nada', async () => {
  assert.equal(await avisoAlCliente('ped-s', 'EN_RUTA'), null);
  assert.equal(await avisoAlCliente('no-existe', 'EN_RUTA'), null);
});
