/**
 * Baja las fotos de referencia del catálogo desde Wikimedia Commons.
 *
 * Se corre a mano cuando cambia el catálogo, no en cada arranque: la
 * feria no puede depender de que un servicio de afuera esté arriba
 * para mostrar un tomate. Las fotos quedan versionadas en el
 * repositorio y viajan dentro de la imagen de Docker.
 *
 *   node herramientas/bajar-fotos.mjs              las que falten
 *   node herramientas/bajar-fotos.mjs p-ajo p-miel  esas, aunque ya estén
 *
 * Las que ya están no se vuelven a bajar: la búsqueda de Commons
 * cambia con el tiempo y repetirla le cambiaría la foto a un
 * producto que ya estaba revisado.
 *
 * Guarda `creditos.json` en la misma carpeta. Las licencias CC
 * exigen atribución: bajar la foto sin anotar de quién es no es una
 * opción, así que el archivo se escribe en el mismo paso.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESTINO = join(dirname(fileURLToPath(import.meta.url)), '../src/fotos');
const UA = 'FeriaApp/1.0 (catalogo de feria libre; contacto@feria.cl)';

/**
 * Término de búsqueda por producto.
 *
 * Están revisados a ojo uno por uno: «hake» devuelve grabados de un
 * libro de 1887 y «lettuce» una bandeja de ensalada con pan. El
 * nombre científico o «white background» es lo que trae la foto de
 * producto que sirve.
 */
const BUSCAR = [
  ['p-tomate', 'ripe red tomatoes'],
  ['p-papa', 'potatoes white background'],
  ['p-cebolla', 'onion white background'],
  ['p-lechuga', 'lettuce head harvested'],
  ['p-zanahoria', 'Daucus carota carrots bunch'],
  ['p-zapallo', 'Cucurbita moschata butternut'],
  ['p-palta', 'avocado white background'],
  ['p-platano', 'bananas white background'],
  ['p-manzana', 'fuji apple white background'],
  ['p-naranja', 'oranges white background'],
  ['p-frutilla', 'strawberries white background'],
  ['p-merluza', 'Merluccius merluccius'],
  ['p-reineta', 'raw fish fillet plate'],
  ['p-choritos', 'cooked mussels dish'],
  ['p-huevos', 'chicken eggs carton'],
  ['p-aceitunas', 'black olives bowl'],
  // Los que se sumaron al catálogo en octubre de 2026.
  ['p-choclo', 'sweet corn cobs fresh'],
  ['p-pimenton', 'red bell pepper white background'],
  ['p-ajo', 'garlic bulbs white background'],
  ['p-cilantro', 'Coriandrum sativum fresh leaves bunch'],
  ['p-perejil', 'parsley bunch fresh'],
  ['p-apio', 'celery white background'],
  ['p-betarraga', 'beetroots Beta vulgaris roots white background'],
  ['p-repollo', 'white cabbage Brassica oleracea capitata head'],
  ['p-brocoli', 'broccoli'],
  ['p-acelga', 'Swiss chard'],
  ['p-zapallo-italiano', 'zucchini white background'],
  ['p-pepino', 'cucumber white background'],
  ['p-poroto-verde', 'green beans fresh pods'],
  ['p-limon', 'lemons white background'],
  ['p-pera', 'pear fruit white background'],
  ['p-uva', 'grapes white background'],
  ['p-kiwi', 'kiwifruit white background'],
  ['p-mandarina', 'mandarin orange fruit'],
  ['p-salmon', 'raw salmon fillet'],
  ['p-jurel', 'Trachurus trachurus'],
  ['p-queso-fresco', 'fresh cheese'],
  ['p-queso-mantecoso', 'Gouda cheese'],
  ['p-queso-cabra', 'goat cheese'],
  ['p-quesillo', 'ricotta'],
  ['p-porotos', 'white beans'],
  ['p-lentejas', 'lentils'],
  ['p-nueces', 'walnuts white background'],
  ['p-miel', 'honey jar'],
  ['p-mote', 'wheat grain closeup'],
];

/** Solo licencias que permiten usar la foto en una app comercial. */
const licenciaSirve = (l) => /^(CC BY(-SA)?( \d|$)|CC0|Public domain|PDM)/i.test(l) && !/NC|ND/i.test(l);

const limpiar = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Descarta escaneos de libros viejos.
 *
 * Buscar «hake» o «carrots» en Commons trae antes un grabado de una
 * enciclopedia agrícola de 1908 que una foto. Son imágenes de libros
 * digitalizados, y se reconocen por el título: llevan el año entre
 * paréntesis y el identificador del escaneo de Flickr Commons.
 */
const esEscaneoDeLibro = (titulo) =>
  /\(1[6-9]\d\d\)|\(20[01]\d\)/.test(titulo)
  || /cyclopedia|encyclop|herbarium|\bplate\b|lithograph|engraving|woodcut|botanical illustration/i
      .test(titulo);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(DESTINO, { recursive: true });
const ARCHIVO_CREDITOS = join(DESTINO, 'creditos.json');
const creditos = existsSync(ARCHIVO_CREDITOS)
  ? JSON.parse(readFileSync(ARCHIVO_CREDITOS, 'utf8')) : {};
const pedidos = process.argv.slice(2);

for (const [id, termino] of BUSCAR) {
  if (pedidos.length ? !pedidos.includes(id) : !!creditos[id]) continue;

  const api = new URL('https://commons.wikimedia.org/w/api.php');
  api.search = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: `filetype:bitmap ${termino}`, gsrnamespace: '6', gsrlimit: '8',
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '800',
  }).toString();

  const d = await (await fetch(api, { headers: { 'user-agent': UA } })).json();
  // La API no respeta el orden de relevancia en el objeto: hay que
  // reordenar por `index` o la primera foto es cualquiera de las ocho.
  const paginas = Object.values(d?.query?.pages ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let listo = false;
  for (const p of paginas) {
    const i = p.imageinfo?.[0];
    if (!i || !/^image\/(jpeg|png)$/.test(i.mime) || !i.thumburl) continue;
    if (esEscaneoDeLibro(p.title)) continue;
    if (!licenciaSirve(limpiar(i.extmetadata?.LicenseShortName?.value))) continue;
    const img = await fetch(i.thumburl, { headers: { 'user-agent': UA } });
    if (!img.ok) continue;

    const ext = i.mime === 'image/png' ? 'png' : 'jpg';
    writeFileSync(join(DESTINO, `${id}.${ext}`), Buffer.from(await img.arrayBuffer()));
    creditos[id] = {
      archivo: `${id}.${ext}`,
      titulo: p.title.replace(/^File:/, ''),
      autor: limpiar(i.extmetadata?.Artist?.value) || 'desconocido',
      licencia: limpiar(i.extmetadata?.LicenseShortName?.value) || 'ver página',
      pagina: i.descriptionurl,
    };
    console.log(
      `${id.padEnd(13)} ${creditos[id].licencia.padEnd(15)} ${creditos[id].titulo.slice(0, 48)}`);
    listo = true;
    break;
  }
  if (!listo) console.log(`${id.padEnd(13)} SIN RESULTADO`);
  await dormir(1100);
}

writeFileSync(ARCHIVO_CREDITOS, JSON.stringify(creditos, null, 2) + '\n');
console.log(`\n${Object.keys(creditos).length} fotos en ${DESTINO}`);
