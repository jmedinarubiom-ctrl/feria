import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Fotos de producto.
 *
 * Lo que se guarda acá después se sirve por HTTP a cualquiera que
 * mire el catálogo, así que las pruebas son sobre lo que pasa
 * cuando llega algo que no es una foto.
 *
 * La carpeta se apunta a una temporal ANTES de importar nada: tanto
 * `config` como `archivos` la resuelven al cargarse. La primera
 * versión de esta prueba limpiaba la carpeta de verdad y se llevó
 * por delante las fotos del catálogo de desarrollo — correr los
 * tests no puede tocar datos de nadie.
 */
const CARPETA = mkdtempSync(join(tmpdir(), 'feria-fotos-'));
process.env.FERIA_DATOS = CARPETA;

const { CONFIG } = await import('../src/config.ts');
const {
  guardarFoto, leerFoto, desdeBase64, tipoDeImagen, ErrorArchivo, MAX_FOTO,
} = await import('../src/dominio/archivos.ts');
type ErrorArchivo = InstanceType<typeof ErrorArchivo>;

test('las pruebas no escriben fuera de su carpeta temporal', () => {
  assert.equal(CONFIG.carpetaDatos, CARPETA);
  assert.ok(CARPETA.startsWith(tmpdir()));
});

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]),
  Buffer.alloc(64, 7),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.alloc(64, 7),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 7),
]);

test.after(() => {
  rmSync(CARPETA, { recursive: true, force: true });
});

test('reconoce las imágenes por sus primeros bytes', () => {
  assert.equal(tipoDeImagen(JPEG)?.ext, 'jpg');
  assert.equal(tipoDeImagen(PNG)?.ext, 'png');
  assert.equal(tipoDeImagen(WEBP)?.ext, 'webp');
});

test('guarda la foto y la devuelve igual', () => {
  const r = guardarFoto(JPEG);
  assert.match(r.camino, /^\/fotos\/[0-9a-f]{32}\.jpg$/);
  assert.equal(r.mime, 'image/jpeg');

  const leida = leerFoto(r.camino.replace('/fotos/', ''));
  assert.ok(leida);
  assert.deepEqual(leida.datos, JPEG);
});

test('la misma foto dos veces no deja dos copias', () => {
  const a = guardarFoto(PNG);
  const b = guardarFoto(PNG);
  assert.equal(a.camino, b.camino, 'el nombre es el hash del contenido');
});

test('un archivo que no es imagen se rechaza aunque diga que lo es', () => {
  // El caso real: alguien sube un PDF, un .exe o un HTML con script
  // renombrado a .jpg. La extensión no la mira nadie; los bytes sí.
  const texto = Buffer.from('<html><script>alert(1)</script></html>');
  assert.throws(() => guardarFoto(texto), (e: ErrorArchivo) => e.codigo === 422);
  assert.throws(() => guardarFoto(Buffer.from('%PDF-1.7')), ErrorArchivo);
  assert.throws(() => guardarFoto(Buffer.alloc(0)), ErrorArchivo);
});

test('una foto más grande que el tope se rechaza', () => {
  const enorme = Buffer.concat([JPEG, Buffer.alloc(MAX_FOTO)]);
  assert.throws(() => guardarFoto(enorme), (e: ErrorArchivo) => e.codigo === 413);
});

test('no se puede salir de la carpeta de fotos', () => {
  // Si el nombre del archivo lo eligiera quien sube, esto leería
  // cualquier archivo del servidor.
  for (const intento of [
    '../../../etc/passwd',
    '../semilla.ts',
    'a'.repeat(32) + '.jpg/../../x',
    'no-es-un-hash.jpg',
    '/etc/passwd',
  ]) {
    assert.equal(leerFoto(intento), null, intento);
  }
});

test('una foto que no existe no rompe', () => {
  assert.equal(leerFoto('a'.repeat(32) + '.png'), null);
});

test('acepta base64 con y sin el prefijo de la cámara', () => {
  const plano = desdeBase64(JPEG.toString('base64'));
  const conPrefijo = desdeBase64('data:image/jpeg;base64,' + JPEG.toString('base64'));
  assert.deepEqual(plano, JPEG);
  assert.deepEqual(conPrefijo, JPEG);
  assert.throws(() => desdeBase64(''), ErrorArchivo);
});
