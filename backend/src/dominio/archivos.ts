import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG } from '../config.ts';

/**
 * Fotos de producto guardadas en disco.
 *
 * El operador saca la foto en el puesto, con el teléfono, y la app
 * la manda. No hay bucket ni CDN: es una carpeta al lado de la base
 * de datos, que es lo que hace falta para una feria y se respalda
 * con el mismo `cp -r` que todo lo demás.
 *
 * Lo que sí hay es desconfianza del cliente: el tipo de archivo se
 * decide mirando los primeros bytes, no la extensión ni lo que diga
 * el encabezado, y el nombre lo pone el servidor. Si el nombre lo
 * eligiera quien sube, el primer `../../` escribe donde quiera.
 */

export class ErrorArchivo extends Error {
  codigo: number;
  constructor(codigo: number, mensaje: string) {
    super(mensaje);
    this.codigo = codigo;
    this.name = 'ErrorArchivo';
  }
}

/** 4 MB ya es una foto de teléfono con holgura. */
export const MAX_FOTO = 4 * 1024 * 1024;

const CARPETA = join(CONFIG.carpetaDatos, 'fotos');

/**
 * Qué es el archivo, según sus primeros bytes.
 *
 * Una foto con extensión .jpg puede ser cualquier cosa. Mirar la
 * firma es la única forma de saber que lo que se guarda y se va a
 * servir como imagen, es una imagen.
 */
export function tipoDeImagen(datos: Buffer): { mime: string; ext: string } | null {
  if (datos.length < 12) return null;
  if (datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (datos.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (datos.subarray(0, 4).toString('ascii') === 'RIFF'
      && datos.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/**
 * Guarda la foto y devuelve el camino público.
 *
 * El nombre es el hash del contenido: subir dos veces la misma foto
 * no deja dos copias, y volver a subirla después de un respaldo da
 * el mismo nombre.
 */
export function guardarFoto(datos: Buffer): { camino: string; bytes: number; mime: string } {
  if (datos.length === 0) throw new ErrorArchivo(422, 'La foto llegó vacía.');
  if (datos.length > MAX_FOTO) {
    throw new ErrorArchivo(413,
      `La foto pesa ${(datos.length / 1024 / 1024).toFixed(1)} MB y el máximo son 4 MB.`);
  }

  const tipo = tipoDeImagen(datos);
  if (!tipo) throw new ErrorArchivo(422, 'El archivo no es una imagen JPEG, PNG ni WebP.');

  const nombre = createHash('sha256').update(datos).digest('hex').slice(0, 32) + '.' + tipo.ext;
  mkdirSync(CARPETA, { recursive: true });
  const destino = join(CARPETA, nombre);
  if (!existsSync(destino)) writeFileSync(destino, datos);

  return { camino: `/fotos/${nombre}`, bytes: datos.length, mime: tipo.mime };
}

/**
 * Lee una foto para servirla.
 *
 * Solo acepta los nombres que este módulo genera. Cualquier otra
 * cosa —una barra, un punto de más, un `..`— se rechaza antes de
 * tocar el disco, así que no hay forma de salir de la carpeta.
 */
export function leerFoto(nombre: string): { datos: Buffer; mime: string } | null {
  const m = /^([0-9a-f]{32})\.(jpg|png|webp)$/.exec(nombre);
  if (!m) return null;

  const destino = join(CARPETA, nombre);
  if (!existsSync(destino) || !statSync(destino).isFile()) return null;

  const mime = m[2] === 'jpg' ? 'image/jpeg' : m[2] === 'png' ? 'image/png' : 'image/webp';
  return { datos: readFileSync(destino), mime };
}

/** Decodifica lo que manda la app: base64, con o sin el prefijo `data:`. */
export function desdeBase64(valor: unknown): Buffer {
  const texto = String(valor ?? '');
  if (!texto) throw new ErrorArchivo(422, 'Falta la foto.');
  const limpio = texto.startsWith('data:') ? texto.slice(texto.indexOf(',') + 1) : texto;
  const datos = Buffer.from(limpio, 'base64');
  if (datos.length === 0) throw new ErrorArchivo(422, 'La foto no se pudo leer.');
  return datos;
}
