/**
 * Prepara el logotipo a partir del archivo original.
 *
 * Recorta el fondo, lo vuelve transparente y escribe los recortes
 * que usa la app. El fondo se detecta con relleno por inundación
 * desde los bordes, no con un umbral de brillo: un umbral también
 * se comería los brillos blancos del limón y del rabanito.
 *
 *   sips -s format png herramientas/logo-original.jpg --out /tmp/logo.png
 *   node herramientas/preparar-logo.ts
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Imagen, escribirPng, leerPng } from './png.ts';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '../assets');

// ---------- Fondo ----------

/**
 * Marca el fondo con relleno por inundación desde los bordes.
 *
 * Solo se vuelve transparente lo que está conectado al borde, así
 * que los blancos de adentro del dibujo —el brillo del limón, el
 * cuerpo del rabanito— se quedan donde están.
 */
function marcarFondo(img: Imagen, tolerancia = 26): Uint8Array {
  const { ancho, alto, px } = img;
  const esFondo = new Uint8Array(ancho * alto);
  const cola: number[] = [];

  const parecido = (i: number) => {
    const r = px[i * 4];
    const g = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    // El fondo del original es casi blanco con un degradé suave.
    return r > 255 - tolerancia * 3 && g > 255 - tolerancia * 3 && b > 255 - tolerancia * 3;
  };

  for (let x = 0; x < ancho; x++) {
    cola.push(x, (alto - 1) * ancho + x);
  }
  for (let y = 0; y < alto; y++) {
    cola.push(y * ancho, y * ancho + ancho - 1);
  }

  while (cola.length) {
    const i = cola.pop()!;
    if (esFondo[i] || !parecido(i)) continue;
    esFondo[i] = 1;
    const x = i % ancho;
    const y = (i / ancho) | 0;
    if (x > 0) cola.push(i - 1);
    if (x < ancho - 1) cola.push(i + 1);
    if (y > 0) cola.push(i - ancho);
    if (y < alto - 1) cola.push(i + ancho);
  }
  return esFondo;
}

function recortar(img: Imagen, x0: number, y0: number, x1: number, y1: number): Imagen {
  const ancho = x1 - x0 + 1;
  const alto = y1 - y0 + 1;
  const px = new Uint8Array(ancho * alto * 4);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const o = ((y + y0) * img.ancho + (x + x0)) * 4;
      const d = (y * ancho + x) * 4;
      px[d] = img.px[o];
      px[d + 1] = img.px[o + 1];
      px[d + 2] = img.px[o + 2];
      px[d + 3] = img.px[o + 3];
    }
  }
  return { ancho, alto, px };
}

// ---------- Proceso ----------

const img = leerPng('/tmp/logo.png');
const fondo = marcarFondo(img);

let minX = img.ancho;
let minY = img.alto;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < img.alto; y++) {
  for (let x = 0; x < img.ancho; x++) {
    const i = y * img.ancho + x;
    if (fondo[i]) {
      img.px[i * 4 + 3] = 0;   // fuera el fondo
    } else {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

console.log(`  original      ${img.ancho}×${img.alto}`);
console.log(`  contenido en  x ${minX}–${maxX}, y ${minY}–${maxY}`);

const completo = recortar(img, minX, minY, maxX, maxY);
escribirPng(join(ASSETS, 'logo.png'), completo);
console.log(`  logo.png      ${completo.ancho}×${completo.alto}`);

/**
 * Busca dónde termina la manzana y empieza el texto: la franja
 * horizontal vacía más ancha de la mitad superior.
 */
let corte = completo.alto;
let mejorHueco = 0;
let desde = -1;
for (let y = Math.floor(completo.alto * 0.4); y < completo.alto; y++) {
  let vacia = true;
  for (let x = 0; x < completo.ancho; x++) {
    if (completo.px[(y * completo.ancho + x) * 4 + 3] > 10) { vacia = false; break; }
  }
  if (vacia) {
    if (desde < 0) desde = y;
  } else if (desde >= 0) {
    if (y - desde > mejorHueco) { mejorHueco = y - desde; corte = desde; }
    desde = -1;
  }
}

// Recorte lateral de la marca sola, para que quede centrada.
let mx0 = completo.ancho;
let mx1 = 0;
for (let y = 0; y < corte; y++) {
  for (let x = 0; x < completo.ancho; x++) {
    if (completo.px[(y * completo.ancho + x) * 4 + 3] > 10) {
      if (x < mx0) mx0 = x;
      if (x > mx1) mx1 = x;
    }
  }
}
const marca = recortar(completo, mx0, 0, mx1, corte - 1);
escribirPng(join(ASSETS, 'logo-marca.png'), marca);
console.log(`  logo-marca.png ${marca.ancho}×${marca.alto}  (hueco de ${mejorHueco}px bajo la manzana)`);

// ---------- Colores de la marca ----------

const cuenta = new Map<string, number>();
for (let i = 0; i < completo.ancho * completo.alto; i++) {
  if (completo.px[i * 4 + 3] < 200) continue;
  const r = completo.px[i * 4];
  const g = completo.px[i * 4 + 1];
  const b = completo.px[i * 4 + 2];
  if (r > 235 && g > 235 && b > 235) continue;   // blancos del dibujo
  const clave = `${r >> 4},${g >> 4},${b >> 4}`;
  cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
}
const hex = (n: number) => n.toString(16).padStart(2, '0');
console.log('\n  colores dominantes:');
[...cuenta.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6)
  .forEach(([k, n]) => {
    const [r, g, b] = k.split(',').map((v) => (Number(v) << 4) + 8);
    console.log(`    #${hex(r)}${hex(g)}${hex(b)}   ${n.toLocaleString('es-CL')} px`);
  });
