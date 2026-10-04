import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar } from '../src/db/index.ts';

/**
 * Migraciones.
 *
 * El esquema se aplica con `CREATE ... IF NOT EXISTS`, que no toca
 * una tabla que ya existe. La primera vez que una columna se agregó
 * a `productos`, la base de desarrollo —creada antes— se quedó sin
 * ella y el catálogo falló al guardar una foto. De eso salen estas
 * pruebas.
 */

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { await cerrarDB(); });

test('al arrancar quedan anotadas las migraciones que corrieron', async () => {
  const filas = await consultar<{ nombre: string }>('SELECT nombre FROM migraciones ORDER BY nombre');
  assert.ok(filas.length > 0, 'tiene que haber al menos una');
  assert.ok(filas.every((f) => f.nombre.endsWith('.sql')));
});

test('no se vuelven a correr en el siguiente arranque', async () => {
  // `abrirDB` ya corrió `migrar()`. Volver a correrlo no debe
  // duplicar filas ni fallar: el servidor arranca muchas veces.
  const antes = await consultarUno<{ n: number }>('SELECT COUNT(*)::int AS n FROM migraciones');
  const { migrar } = await import('../src/db/index.ts');
  await migrar();
  const despues = await consultarUno<{ n: number }>('SELECT COUNT(*)::int AS n FROM migraciones');
  assert.equal(despues!.n, antes!.n);
});

test('la columna de la foto existe y acepta null', async () => {
  const col = await consultarUno(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'productos' AND column_name = 'imagen_url'`);
  assert.ok(col, 'falta imagen_url en productos');
  assert.equal(col!.data_type, 'text');
  assert.equal(col!.is_nullable, 'YES', 'un producto sin foto es lo normal');
});

test('una base vieja sin la columna la recupera al migrar', async () => {
  // El caso exacto que rompió: la tabla existe de antes y le falta
  // la columna. La migración tiene que poder agregarla de nuevo.
  await ejecutar('ALTER TABLE productos DROP COLUMN imagen_url');
  await ejecutar("DELETE FROM migraciones WHERE nombre = '001-foto-de-producto.sql'");

  const { migrar } = await import('../src/db/index.ts');
  await migrar();

  const col = await consultarUno(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'productos' AND column_name = 'imagen_url'`);
  assert.ok(col, 'la migración tiene que volver a agregarla');
});
