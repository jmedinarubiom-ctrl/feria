import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fotos de referencia del catálogo.
 *
 * No son fotos del puesto: son una imagen genérica del producto
 * para que el cliente reconozca lo que está comprando de un vistazo.
 * Viven en el repositorio, no en disco de datos — viajan dentro de
 * la imagen de Docker, así que un despliegue nuevo no se las lleva
 * y no hace falta montar un volumen para que el catálogo se vea.
 *
 * Se bajan con `node herramientas/bajar-fotos.mjs`, y `creditos.json`
 * guarda de quién es cada una: casi todas son CC y la atribución es
 * obligatoria.
 */

const CARPETA = join(dirname(fileURLToPath(import.meta.url)), '../fotos');

type Credito = {
  archivo: string;
  titulo: string;
  autor: string;
  licencia: string;
  pagina: string;
};

/** Se lee una vez al arrancar: son unas decenas de archivos que no cambian. */
const indice: Map<string, { archivo: string; mime: string }> = (() => {
  const m = new Map<string, { archivo: string; mime: string }>();
  if (!existsSync(CARPETA)) return m;
  for (const archivo of readdirSync(CARPETA)) {
    const r = /^([a-z0-9-]+)\.(jpg|png)$/.exec(archivo);
    if (!r) continue;
    m.set(r[1], { archivo, mime: r[2] === 'png' ? 'image/png' : 'image/jpeg' });
  }
  return m;
})();

export const creditos: Record<string, Credito> = existsSync(join(CARPETA, 'creditos.json'))
  ? JSON.parse(readFileSync(join(CARPETA, 'creditos.json'), 'utf8'))
  : {};

export const hayReferencia = (productoId: string): boolean => indice.has(productoId);

/**
 * Lee la foto de referencia de un producto.
 *
 * El id viene de la URL, así que se busca en el índice en vez de
 * armar un camino con él: así no hay forma de pedir `../../algo`.
 */
export function leerReferencia(productoId: string): { datos: Buffer; mime: string } | null {
  const entrada = indice.get(productoId);
  if (!entrada) return null;
  return { datos: readFileSync(join(CARPETA, entrada.archivo)), mime: entrada.mime };
}
