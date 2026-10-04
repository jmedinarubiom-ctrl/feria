/**
 * Lectura, escritura y escalado de PNG, a mano.
 *
 * No hay librería de imágenes en el equipo y no vale la pena sumar
 * una dependencia nativa para preparar seis archivos. El formato es
 * simple: cabecera, píxeles comprimidos con zlib y sumas de control.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

export type Imagen = { ancho: number; alto: number; px: Uint8Array };
export type Color = [number, number, number, number];

const tablaCrc = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (d: Buffer) => {
  let c = 0xffffffff;
  for (const b of d) c = tablaCrc[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function trozo(tipo: string, datos: Buffer): Buffer {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const suma = Buffer.alloc(4);
  suma.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, suma]);
}

/** Lee un PNG de 8 bits deshaciendo los filtros por línea. */
export function leerPng(ruta: string): Imagen {
  const b = readFileSync(ruta);
  let off = 8;
  let ancho = 0;
  let alto = 0;
  let canales = 4;
  const idat: Buffer[] = [];

  while (off < b.length) {
    const largo = b.readUInt32BE(off);
    const tipo = b.toString('ascii', off + 4, off + 8);
    if (tipo === 'IHDR') {
      ancho = b.readUInt32BE(off + 8);
      alto = b.readUInt32BE(off + 12);
      if (b[off + 16] !== 8) throw new Error('Solo se admiten 8 bits por canal.');
      const tipoColor = b[off + 17];
      if (tipoColor !== 6 && tipoColor !== 2) {
        throw new Error(`Tipo de color ${tipoColor} no admitido (se esperaba RGB o RGBA).`);
      }
      canales = tipoColor === 6 ? 4 : 3;
    }
    if (tipo === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + largo));
    off += 12 + largo;
  }

  const crudo = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(ancho * alto * 4);
  const porLinea = ancho * canales;
  const anterior = new Uint8Array(porLinea);
  const actual = new Uint8Array(porLinea);

  for (let y = 0; y < alto; y++) {
    const filtro = crudo[y * (porLinea + 1)];
    const linea = crudo.subarray(y * (porLinea + 1) + 1, (y + 1) * (porLinea + 1));
    for (let i = 0; i < porLinea; i++) {
      const a = i >= canales ? actual[i - canales] : 0;
      const arriba = anterior[i];
      const diagonal = i >= canales ? anterior[i - canales] : 0;
      let v = linea[i];
      if (filtro === 1) v += a;
      else if (filtro === 2) v += arriba;
      else if (filtro === 3) v += (a + arriba) >> 1;
      else if (filtro === 4) {
        const p = a + arriba - diagonal;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - arriba);
        const pc = Math.abs(p - diagonal);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? arriba : diagonal;
      }
      actual[i] = v & 0xff;
    }
    for (let x = 0; x < ancho; x++) {
      const o = (y * ancho + x) * 4;
      px[o] = actual[x * canales];
      px[o + 1] = actual[x * canales + 1];
      px[o + 2] = actual[x * canales + 2];
      px[o + 3] = canales === 4 ? actual[x * canales + 3] : 255;
    }
    anterior.set(actual);
  }
  return { ancho, alto, px };
}

export function escribirPng(ruta: string, img: Imagen): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.ancho, 0);
  ihdr.writeUInt32BE(img.alto, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const conFiltro = Buffer.alloc(img.alto * (img.ancho * 4 + 1));
  for (let y = 0; y < img.alto; y++) {
    conFiltro[y * (img.ancho * 4 + 1)] = 0;
    Buffer.from(img.px.buffer, y * img.ancho * 4, img.ancho * 4)
      .copy(conFiltro, y * (img.ancho * 4 + 1) + 1);
  }
  writeFileSync(ruta, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(conFiltro, { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]));
}

export function lienzo(ancho: number, alto: number, fondo: Color): Imagen {
  const px = new Uint8Array(ancho * alto * 4);
  for (let i = 0; i < ancho * alto; i++) {
    px[i * 4] = fondo[0];
    px[i * 4 + 1] = fondo[1];
    px[i * 4 + 2] = fondo[2];
    px[i * 4 + 3] = fondo[3];
  }
  return { ancho, alto, px };
}

/**
 * Escala con interpolación bilineal.
 *
 * Al agrandar queda más blando que el original —no hay información
 * que inventar—, pero mucho mejor que repetir píxeles, que deja
 * bordes en escalera.
 */
export function escalar(img: Imagen, ancho: number, alto: number): Imagen {
  const px = new Uint8Array(ancho * alto * 4);
  const ex = img.ancho / ancho;
  const ey = img.alto / alto;

  for (let y = 0; y < alto; y++) {
    const fy = Math.min(img.alto - 1, (y + 0.5) * ey - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(img.alto - 1, y0 + 1);
    const ty = fy - y0;

    for (let x = 0; x < ancho; x++) {
      const fx = Math.min(img.ancho - 1, (x + 0.5) * ex - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(img.ancho - 1, x0 + 1);
      const tx = fx - x0;

      for (let c = 0; c < 4; c++) {
        const a = img.px[(y0 * img.ancho + x0) * 4 + c];
        const b = img.px[(y0 * img.ancho + x1) * 4 + c];
        const d = img.px[(y1 * img.ancho + x0) * 4 + c];
        const e = img.px[(y1 * img.ancho + x1) * 4 + c];
        px[(y * ancho + x) * 4 + c] = Math.round(
          a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + d * (1 - tx) * ty + e * tx * ty,
        );
      }
    }
  }
  return { ancho, alto, px };
}

/** Pega `fuente` sobre `destino` respetando la transparencia. */
export function componer(destino: Imagen, fuente: Imagen, x0: number, y0: number): void {
  for (let y = 0; y < fuente.alto; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= destino.alto) continue;
    for (let x = 0; x < fuente.ancho; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= destino.ancho) continue;
      const f = (y * fuente.ancho + x) * 4;
      const alfa = fuente.px[f + 3] / 255;
      if (alfa === 0) continue;
      const d = (dy * destino.ancho + dx) * 4;
      for (let c = 0; c < 3; c++) {
        destino.px[d + c] = Math.round(fuente.px[f + c] * alfa + destino.px[d + c] * (1 - alfa));
      }
      destino.px[d + 3] = Math.round(255 * alfa + destino.px[d + 3] * (1 - alfa));
    }
  }
}

/** Reemplaza el color de todo lo opaco, conservando la silueta. */
export function tenir(img: Imagen, color: Color): Imagen {
  const px = new Uint8Array(img.px);
  for (let i = 0; i < img.ancho * img.alto; i++) {
    if (px[i * 4 + 3] === 0) continue;
    px[i * 4] = color[0];
    px[i * 4 + 1] = color[1];
    px[i * 4 + 2] = color[2];
  }
  return { ancho: img.ancho, alto: img.alto, px };
}
