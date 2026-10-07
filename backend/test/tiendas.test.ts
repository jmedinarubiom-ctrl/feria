import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDB, cerrarDB, consultarUno, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import { fijarTransporteCorreo } from '../src/correo.ts';
import { crearSesion, crearSesionPorCorreo, pedirCodigo, pedirCodigoPorCorreo, verificarToken } from '../src/dominio/auth.ts';
import { eliminarCuentaEquipo } from '../src/dominio/privacidad.ts';

const correos: string[] = [];

before(async () => {
  process.env.REVISION_CORREO = 'revision@example.com';
  process.env.REVISION_CODIGO = '424242';
  await abrirDB({ memoria: true });
  await sembrar();
  fijarTransporteCorreo(async (a) => { correos.push(a); return { enviado: true, proveedor: 'prueba' }; });
});
after(async () => {
  delete process.env.REVISION_CORREO; delete process.env.REVISION_CODIGO;
  fijarTransporteCorreo(null); await cerrarDB();
});

test('la cuenta de revisión entra con su código fijo, como comprador y sin mandar correo', async () => {
  await pedirCodigoPorCorreo('Revision@Example.com');
  assert.equal(correos.length, 0, 'no se manda nada');
  await assert.rejects(() => crearSesionPorCorreo('revision@example.com', '000000'));
  await pedirCodigoPorCorreo('revision@example.com');
  const s = await crearSesionPorCorreo('revision@example.com', '424242');
  assert.equal(s.rol, 'cliente');
});

test('el código fijo no sirve para ningún otro correo ni para un teléfono', async () => {
  await pedirCodigoPorCorreo('otra@example.com');
  assert.equal(correos.length, 1);
  await assert.rejects(() => crearSesionPorCorreo('otra@example.com', '424242'));
  const { codigoDev } = await pedirCodigo('+56900000009');
  if (codigoDev !== '424242') {
    await assert.rejects(() => crearSesion('+56900000009', '424242'));
  }
});

test('un feriante elimina su cuenta: no entra más y no quedan su nombre ni su teléfono', async () => {
  const { codigoDev } = await pedirCodigo('+56911111111');
  const s = await crearSesion('+56911111111', codigoDev!);
  assert.equal(s.rol, 'feriante');
  await eliminarCuentaEquipo('feriante', s.actorId);
  await assert.rejects(() => verificarToken(s.token));
  const f = await consultarUno<any>('SELECT * FROM feriantes WHERE id = ?', s.actorId);
  assert.equal(f.activo, false);
  assert.doesNotMatch(JSON.stringify(f), /Sandoval|56911111111/);
  // El número queda libre: quien lo tenga entra como comprador.
  const otra = await pedirCodigo('+56911111111');
  const nueva = await crearSesion('+56911111111', otra.codigoDev!);
  assert.equal(nueva.rol, 'cliente');
});

test('con trabajo a medias no se puede eliminar la cuenta', async () => {
  const rep = await consultarUno<any>('SELECT id FROM repartidores ORDER BY id LIMIT 1');
  const feria = await consultarUno<any>('SELECT id FROM ferias ORDER BY id LIMIT 1');
  await ejecutar(
    `INSERT INTO pedidos (id, feria_id, cliente_nombre, cliente_telefono, direccion, lat, lng,
                          total_productos, costo_despacho, total_venta, estado)
     VALUES ('ped-t', ?, 'Ana', '+56987654321', 'Calle 1', -33.04, -71.61, 9000, 2000, 11000, 'EN_RUTA')`, feria.id);
  await ejecutar(
    `INSERT INTO viajes (id, pedido_id, repartidor_id, estado, tarifa) VALUES ('via-t', 'ped-t', ?, 'EN_RUTA', 2500)`, rep.id);
  await assert.rejects(() => eliminarCuentaEquipo('repartidor', rep.id), /Termínalo/);
  await ejecutar(`UPDATE viajes SET estado = 'ENTREGADO' WHERE id = 'via-t'`);
  await eliminarCuentaEquipo('repartidor', rep.id);
  const r = await consultarUno<any>('SELECT nombre, activo FROM repartidores WHERE id = ?', rep.id);
  assert.equal(r.nombre, '(cuenta eliminada)');
  // El viaje sigue ahí: es contabilidad.
  assert.ok(await consultarUno('SELECT 1 FROM viajes WHERE id = ?', 'via-t'));
});
