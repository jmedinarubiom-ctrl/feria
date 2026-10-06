import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDB, cerrarDB, consultarUno, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import { fijarTransporteCorreo } from '../src/correo.ts';
import { registrarError, revisarYAvisar } from '../src/dominio/alertas.ts';

const correos: string[] = [];
let falla = false;

before(async () => {
  process.env.ALERTAS_CORREO = 'operador@example.com';
  await abrirDB({ memoria: true });
  await sembrar();
  fijarTransporteCorreo(async (_a, _asunto, texto) => {
    if (falla) return { enviado: false, proveedor: 'prueba' };
    correos.push(texto);
    return { enviado: true, proveedor: 'prueba' };
  });
});
after(async () => { fijarTransporteCorreo(null); await cerrarDB(); });

test('sin problemas no se manda nada', async () => {
  assert.equal(await revisarYAvisar(3), 0);
  assert.equal(correos.length, 0);
});

test('un viaje sin repartidor y una autogestión se avisan una sola vez, en un correo', async () => {
  const feria = await consultarUno<{ id: string }>('SELECT id FROM ferias ORDER BY id LIMIT 1');
  await ejecutar(
    `INSERT INTO pedidos (id, feria_id, cliente_nombre, cliente_telefono, direccion, lat, lng,
                          total_productos, costo_despacho, total_venta, estado)
     VALUES ('ped-al', ?, 'Ana', '+56987654321', 'Calle 1', -33.04, -71.61, 3000, 2000, 5000, 'PAGADO')`, feria!.id);
  await ejecutar(
    `INSERT INTO sub_pedidos (id, pedido_id, rubro_id, estado, monto_feriante, autogestionado)
     VALUES ('sub-al', 'ped-al', 'verduras', 'AUTOGESTION', 2000, true)`);
  await ejecutar(
    `INSERT INTO viajes (id, pedido_id, estado, tarifa, creado_at)
     VALUES ('via-al', 'ped-al', 'BUSCANDO', 2500, now() - interval '20 minutes')`);

  assert.equal(await revisarYAvisar(3), 2);
  assert.equal(correos.length, 1);
  assert.match(correos[0], /nadie aceptó la parte de verduras/);
  assert.match(correos[0], /sin que un repartidor tome el viaje/);

  assert.equal(await revisarYAvisar(3), 0, 'al minuto siguiente no se repite');
  assert.equal(correos.length, 1);
});

test('el motor detenido y un error interno también avisan; si el correo falla se reintenta', async () => {
  await registrarError('/pedidos/abc123/pagar', new Error('se cayó la pasarela'));
  falla = true;
  assert.equal(await revisarYAvisar(600), 0);
  falla = false;
  assert.equal(await revisarYAvisar(600), 2);
  const ultimo = correos.at(-1)!;
  assert.match(ultimo, /estuvo detenido 10 minutos/);
  assert.match(ultimo, /Error interno en \/pedidos \(1 en/);
});
