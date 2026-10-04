/**
 * Genera los íconos de la app a partir del logotipo.
 *
 * La manzana lleva frutas y verduras adentro, así que se usa el
 * archivo de la marca en vez de redibujarla: una versión hecha a
 * mano quedaría parecida pero distinta, y tener dos manzanas que no
 * coinciden es peor que tener una sola un poco más blanda.
 *
 *   node herramientas/preparar-logo.ts    (deja assets/logo-marca.png)
 *   node herramientas/generar-iconos.ts
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Color, type Imagen, componer, escalar, escribirPng, leerPng, lienzo, tenir,
} from './png.ts';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '../assets');

const PAPEL: Color = [0xfa, 0xfb, 0xfc, 255];
const GRANATE: Color = [0x8b, 0x28, 0x38, 255];
const TRANSPARENTE: Color = [0, 0, 0, 0];

const marca = leerPng(join(ASSETS, 'logo-marca.png'));

/** Centra la marca en un lienzo cuadrado, ocupando `proporcion` del lado. */
function iconoCon(lado: number, proporcion: number, fondo: Color, color?: Color): Imagen {
  const alto = Math.round(lado * proporcion);
  const ancho = Math.round((alto * marca.ancho) / marca.alto);
  const escalada = escalar(color ? tenir(marca, color) : marca, ancho, alto);

  const img = lienzo(lado, lado, fondo);
  componer(img, escalada, Math.round((lado - ancho) / 2), Math.round((lado - alto) / 2));
  return img;
}

const archivos: Array<{ nombre: string; hacer: () => Imagen }> = [
  // Fondo claro como el logotipo. La manzana es multicolor, así que
  // el ícono se distingue por ella y no por el fondo.
  { nombre: 'icon.png', hacer: () => iconoCon(1024, 0.70, PAPEL) },
  { nombre: 'favicon.png', hacer: () => iconoCon(196, 0.74, PAPEL) },

  // Android adaptativo: el sistema recorta en círculo, así que la
  // marca va más chica para no perder los bordes.
  { nombre: 'android-icon-foreground.png', hacer: () => iconoCon(1024, 0.50, TRANSPARENTE) },
  { nombre: 'android-icon-background.png', hacer: () => lienzo(1024, 1024, PAPEL) },
  // Monocromo para el tema dinámico de Android 13+: solo la silueta.
  {
    nombre: 'android-icon-monochrome.png',
    hacer: () => iconoCon(1024, 0.50, TRANSPARENTE, [0, 0, 0, 255]),
  },

  { nombre: 'splash-icon.png', hacer: () => iconoCon(1024, 0.62, TRANSPARENTE) },
];

console.log(`  marca de origen: ${marca.ancho}×${marca.alto}`);
for (const a of archivos) {
  const img = a.hacer();
  escribirPng(join(ASSETS, a.nombre), img);
  console.log(`  ${a.nombre.padEnd(30)} ${img.ancho}×${img.alto}`);
}

const ampliacion = (1024 * 0.7) / marca.alto;
if (ampliacion > 2) {
  console.log(`\n  ⚠ La marca se amplía ${ampliacion.toFixed(1)}× para el ícono de 1024 px.`);
  console.log('    Sirve para probar, pero para publicar conviene exportar el');
  console.log('    logotipo original a 1024 px o más y volver a correr esto.');
}
