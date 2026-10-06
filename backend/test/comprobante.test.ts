import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDB, cerrarDB, consultarUno, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import { fijarTransporteCorreo } from '../src/correo.ts';
import { enviarComprobante } from '../src/dominio/comprobante.ts';

const enviados: Array<{ a: string; asunto: string; texto: string }> = [];
let falla = false;

before(async () => {
  await abrirDB({ memoria: true });
  await sembrar();
  fijarTransporteCorreo(async (a, asunto, texto) => {
    if (falla) return { enviado: false, proveedor: 'prueba', detalle: 'caído' };
    enviados.push({ a, asunto, texto });
    return { enviado: true, proveedor: 'prueba' };
  });
});
after(async () => { fijarTransporteCorreo(null); await cerrarDB(); });

async function pedidoPagado(id: string, email: string | null) {
  const feria = await consultarUno<{ id: string }>('SELECT id FROM ferias ORDER BY id LIMIT 1');
  await ejecutar(
    `INSERT INTO pedidos (id, feria_id, cliente_nombre, cliente_telefono, cliente_email, direccion, lat, lng,
                          total_productos, costo_despacho, total_venta, estado)
     VALUES (?, ?, 'Ana <b>', '+56987654321', ?, 'Av. Argentina 123', -33.04, -71.61, 3000, 2000, 5000, 'PAGADO')`,
    id, feria!.id, email);
  await ejecutar(
    `INSERT INTO sub_pedidos (id, pedido_id, rubro_id, estado, monto_feriante) VALUES (?, ?, 'verduras', 'PENDIENTE', 2000)`,
    'sub-' + id, id);
  await ejecutar(
    `INSERT INTO items (id, sub_pedido_id, producto_id, nombre, formato, cantidad, precio_venta, precio_costo)
     VALUES (?, ?, 'p-ajo', 'Ajo', 'Malla 3 un.', 2, 1500, 1000)`, 'it-' + id, 'sub-' + id);
}

test('el comprobante sale una sola vez, con el detalle y sin costos', async () => {
  await pedidoPagado('ped-comp-1', 'ana@example.com');
  assert.equal(await enviarComprobante('ped-comp-1'), true);
  assert.equal(await enviarComprobante('ped-comp-1'), false, 'la segunda confirmación no manda otro');
  assert.equal(enviados.length, 1);
  const c = enviados[0];
  assert.equal(c.a, 'ana@example.com');
  assert.match(c.texto, /2 × Ajo \(Malla 3 un\.\) — \$3\.000/);
  assert.match(c.texto, /Total pagado: \$5\.000/);
  assert.doesNotMatch(c.texto, /1\.000|2\.000 de costo/, 'no muestra lo que se le paga al feriante');
});

test('sin correo no se manda nada, y si el envío falla se reintenta después', async () => {
  await pedidoPagado('ped-comp-2', null);
  assert.equal(await enviarComprobante('ped-comp-2'), false);

  await pedidoPagado('ped-comp-3', 'ana@example.com');
  falla = true;
  assert.equal(await enviarComprobante('ped-comp-3'), false);
  falla = false;
  assert.equal(await enviarComprobante('ped-comp-3'), true, 'el candado se soltó');
});
