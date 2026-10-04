/**
 * Baja las fotos de referencia del catálogo desde Wikimedia Commons.
 *
 * Se corre a mano cuando cambia el catálogo, no en cada arranque: la
 * feria no puede depender de que un servicio de afuera esté arriba
 * para mostrar un tomate. Las fotos quedan versionadas en el
 * repositorio y viajan dentro de la imagen de Docker.
 *
 *   node herramientas/bajar-fotos.mjs
 *
 * Guarda `creditos.json` en la misma carpeta. Las licencias CC
 * exigen atribución: bajar la foto sin anotar de quién es no es una
 * opción, así que el archivo se escribe en el mismo paso.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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
];

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
const creditos = {};

for (const [id, termino] of BUSCAR) {
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

writeFileSync(join(DESTINO, 'creditos.json'), JSON.stringify(creditos, null, 2) + '\n');
console.log(`\n${Object.keys(creditos).length} fotos en ${DESTINO}`);
