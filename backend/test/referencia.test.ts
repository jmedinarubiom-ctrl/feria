import test from 'node:test';
import assert from 'node:assert/strict';

import { leerReferencia, hayReferencia, creditos } from '../src/dominio/referencia.ts';
import { tipoDeImagen } from '../src/dominio/archivos.ts';

/**
 * Fotos de referencia.
 *
 * Vienen con el código, así que lo que se prueba es que estén todas,
 * que sean imágenes de verdad y que tengan su atribución: casi todas
 * son Creative Commons y usarlas sin crédito no corresponde.
 */

const DEL_CATALOGO = [
  'p-tomate', 'p-papa', 'p-cebolla', 'p-lechuga', 'p-zanahoria', 'p-zapallo',
  'p-palta', 'p-platano', 'p-manzana', 'p-naranja', 'p-frutilla',
  'p-merluza', 'p-reineta', 'p-choritos', 'p-huevos', 'p-aceitunas',
  // Los que se sumaron en octubre de 2026.
  'p-choclo', 'p-pimenton', 'p-ajo', 'p-cilantro', 'p-perejil', 'p-apio', 'p-betarraga',
  'p-repollo', 'p-brocoli', 'p-acelga', 'p-zapallo-italiano', 'p-pepino', 'p-poroto-verde',
  'p-limon', 'p-pera', 'p-uva', 'p-kiwi', 'p-mandarina', 'p-salmon', 'p-jurel',
  'p-queso-fresco', 'p-queso-mantecoso', 'p-queso-cabra', 'p-quesillo',
  'p-porotos', 'p-lentejas', 'p-nueces', 'p-miel', 'p-mote',
];

test('cada producto del catálogo tiene su foto', () => {
  const faltan = DEL_CATALOGO.filter((id) => !hayReferencia(id));
  assert.deepEqual(faltan, [], 'sin foto de referencia');
});

test('son imágenes de verdad, no archivos rotos', () => {
  for (const id of DEL_CATALOGO) {
    const foto = leerReferencia(id);
    assert.ok(foto, id);
    const tipo = tipoDeImagen(foto.datos);
    assert.ok(tipo, `${id} no es una imagen`);
    assert.equal(foto.mime, tipo.mime, `${id}: el mime no calza con el contenido`);
    // Una foto de catálogo bajo 10 KB es un ícono o un error.
    assert.ok(foto.datos.length > 10_000, `${id} pesa ${foto.datos.length} bytes`);
  }
});

test('cada foto dice de quién es y con qué licencia', () => {
  for (const id of DEL_CATALOGO) {
    const c = creditos[id];
    assert.ok(c, `${id} sin crédito`);
    assert.ok(c.autor && c.autor !== 'desconocido', `${id} sin autor`);
    assert.ok(c.licencia && c.licencia !== 'ver página', `${id} sin licencia`);
    assert.match(c.pagina, /^https:\/\/commons\.wikimedia\.org\//, `${id} sin página de origen`);
  }
});

test('un id inventado no devuelve nada ni rompe', () => {
  // El id llega por la URL: si se armara el camino concatenando,
  // esto leería cualquier archivo del servidor.
  for (const intento of ['../../etc/passwd', 'p-tomate/../../x', 'no-existe', '']) {
    assert.equal(leerReferencia(intento), null, intento);
    assert.equal(hayReferencia(intento), false, intento);
  }
});

test('todo producto de la semilla tiene foto: ninguno se queda con el dibujo', async () => {
  const { abrirDB, cerrarDB, consultar } = await import('../src/db/index.ts');
  const { sembrar } = await import('../src/db/semilla.ts');
  await abrirDB({ memoria: true });
  try {
    await sembrar();
    const productos = await consultar<{ id: string }>('SELECT id FROM productos');
    assert.ok(productos.length >= 45);
    assert.deepEqual(productos.map((p) => p.id).filter((id) => !hayReferencia(id)), []);
  } finally {
    await cerrarDB();
  }
});
