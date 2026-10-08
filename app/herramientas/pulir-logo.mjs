// Limpia el logo: bordes nítidos, colores planos y la hoja sin
// relleno blanco.
//
//   node herramientas/pulir-logo.mjs <entrada.png> <salida.png> [colores]
//
// El original es un dibujo chico (266 px) con bordes borrosos y un
// halo claro alrededor. Acá se agranda, cada punto se lleva al color
// plano más cercano de la paleta del propio dibujo, se quitan las
// hilachas que deja el borde y se vuelve a achicar con suavizado.
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';

const [entrada, salida, kArg] = process.argv.slice(2);
const K = Number(kArg ?? 14);
const SUBE = 6;      // se trabaja a 6×…
const BAJA = 3;      // …y se entrega a 2×
const src = PNG.sync.read(readFileSync(entrada));
const { width: w, height: h, data: d } = src;

// ---------- paleta: k-medias sobre los puntos opacos ----------
const pts = [];
for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] > 230) pts.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
let centros = [pts[0]];
while (centros.length < K) {           // el más lejano a los que ya hay
  let mejor = pts[0], md = -1;
  for (let i = 0; i < pts.length; i += 3) {
    const m = Math.min(...centros.map((c) => dist(c, pts[i])));
    if (m > md) { md = m; mejor = pts[i]; }
  }
  centros.push(mejor);
}
for (let vuelta = 0; vuelta < 12; vuelta++) {
  const suma = centros.map(() => [0, 0, 0, 0]);
  for (const p of pts) {
    let bi = 0, bd = Infinity;
    centros.forEach((c, i) => { const x = dist(c, p); if (x < bd) { bd = x; bi = i; } });
    suma[bi][0] += p[0]; suma[bi][1] += p[1]; suma[bi][2] += p[2]; suma[bi][3]++;
  }
  centros = suma.map((s, i) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centros[i]));
}
// Dos tonos casi iguales son el mismo color visto a través del
// borroso del original: se funden en uno.
for (let i = 0; i < centros.length; i++) for (let j = centros.length - 1; j > i; j--) {
  if (dist(centros[i], centros[j]) < 42 ** 2) {
    centros[i] = centros[i].map((v, k) => (v + centros[j][k]) / 2);
    centros.splice(j, 1);
  }
}
// Los blancos, blancos de verdad.
centros = centros.map((c) => (Math.min(...c) > 232 ? [255, 255, 255] : c.map(Math.round)));
// El contorno es el burdeo de la marca; fundir tonos no puede moverlo.
const MARCA = [139, 40, 56];
{
  let bi = -1, bd = 70 ** 2;
  centros.forEach((c, i) => { const x = dist(c, MARCA); if (x < bd) { bd = x; bi = i; } });
  if (bi >= 0) centros[bi] = MARCA;
}
console.log('paleta:', centros.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')).join(' '));

// ---------- agrandar (bicúbica, con el color premultiplicado) ----------
const W = w * SUBE, H = h * SUBE;
const cub = (t) => { t = Math.abs(t); return t <= 1 ? 1.5 * t ** 3 - 2.5 * t ** 2 + 1 : t < 2 ? -0.5 * t ** 3 + 2.5 * t ** 2 - 4 * t + 2 : 0; };
const pre = new Float32Array(w * h * 4);
for (let i = 0; i < w * h; i++) {
  const a = d[i * 4 + 3] / 255;
  pre[i * 4] = d[i * 4] * a; pre[i * 4 + 1] = d[i * 4 + 1] * a; pre[i * 4 + 2] = d[i * 4 + 2] * a; pre[i * 4 + 3] = a;
}
const tmp = new Float32Array(W * h * 4);
for (let y = 0; y < h; y++) for (let X = 0; X < W; X++) {
  const fx = (X + 0.5) / SUBE - 0.5, x0 = Math.floor(fx);
  const o = (y * W + X) * 4;
  for (let k = -1; k <= 2; k++) {
    const xx = Math.min(w - 1, Math.max(0, x0 + k)), p = cub(fx - (x0 + k)), s = (y * w + xx) * 4;
    tmp[o] += pre[s] * p; tmp[o + 1] += pre[s + 1] * p; tmp[o + 2] += pre[s + 2] * p; tmp[o + 3] += pre[s + 3] * p;
  }
}
const etiqueta = new Int8Array(W * H).fill(-1);
for (let Y = 0; Y < H; Y++) {
  const fy = (Y + 0.5) / SUBE - 0.5, y0 = Math.floor(fy);
  for (let X = 0; X < W; X++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = -1; k <= 2; k++) {
      const yy = Math.min(h - 1, Math.max(0, y0 + k)), p = cub(fy - (y0 + k)), s = (yy * W + X) * 4;
      r += tmp[s] * p; g += tmp[s + 1] * p; b += tmp[s + 2] * p; a += tmp[s + 3] * p;
    }
    if (a < 0.5) continue;
    const c = [r / a, g / a, b / a];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < centros.length; i++) { const x = dist(centros[i], c); if (x < bd) { bd = x; bi = i; } }
    etiqueta[Y * W + X] = bi;
  }
}

// ---------- quitar hilachas: cada punto toma el color de la mayoría ----------
function mayoria(et, radio) {
  const sal = new Int8Array(et.length);
  const cuenta = new Int32Array(centros.length + 1);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    cuenta.fill(0);
    for (let dy = -radio; dy <= radio; dy++) {
      const yy = Y + dy; if (yy < 0 || yy >= H) { cuenta[0] += 2 * radio + 1; continue; }
      for (let dx = -radio; dx <= radio; dx++) {
        const xx = X + dx;
        cuenta[xx < 0 || xx >= W ? 0 : et[yy * W + xx] + 1]++;
      }
    }
    let bi = 0; for (let i = 1; i < cuenta.length; i++) if (cuenta[i] > cuenta[bi]) bi = i;
    sal[Y * W + X] = bi - 1;
  }
  return sal;
}
let et = mayoria(mayoria(etiqueta, 4), 3);

// ---------- la hoja: su relleno blanco pasa a transparente ----------
// Se buscan las manchas blancas que no tocan el resto del dibujo
// más que por el contorno verde de la hoja: quedan arriba, fuera
// del cuerpo de la manzana.
const blancos = new Set(centros.map((c, i) => (c[0] === 255 && c[1] === 255 && c[2] === 255 ? i : -1)).filter((i) => i >= 0));
const visto = new Uint8Array(W * H);
const limiteHoja = Math.round(H * (h > 400 ? 0.2 : 0.31));   // el logo con texto es más alto
let quitados = 0;
for (let i0 = 0; i0 < W * H; i0++) {
  if (visto[i0] || !blancos.has(et[i0])) continue;
  const pila = [i0], mancha = []; visto[i0] = 1; let maxY = 0;
  while (pila.length) {
    const i = pila.pop(); mancha.push(i);
    const x = i % W, y = (i / W) | 0; if (y > maxY) maxY = y;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j >= 0 && !visto[j] && blancos.has(et[j])) { visto[j] = 1; pila.push(j); }
    }
  }
  if (maxY < limiteHoja) { for (const i of mancha) et[i] = -1; quitados += mancha.length; }
}

// ---------- el resto del blanco ----------
// Sobre un fondo de color, lo blanco se ve como un parche. Cada
// mancha blanca que queda se resuelve mirando qué la rodea:
//  · encerrada por la letra (el hueco de la «a», la «e», la «p»):
//    pasa a transparente, como la hoja;
//  · dentro del dibujo (el brillo del limón, la punta del rábano):
//    toma un tono claro del color que tiene al lado.
{
  const esMarca = (i) => i >= 0 && centros[i][0] === MARCA[0] && centros[i][1] === MARCA[1] && centros[i][2] === MARCA[2];
  const luzDe = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const v = new Uint8Array(W * H);
  let huecos = 0, tenidas = 0;
  for (let i0 = 0; i0 < W * H; i0++) {
    if (v[i0] || !blancos.has(et[i0])) continue;
    const pila = [i0], mancha = [], vecinos = new Map(); v[i0] = 1;
    let afuera = false;
    while (pila.length) {
      const i = pila.pop(); mancha.push(i);
      const x = i % W, y = (i / W) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0) { afuera = true; continue; }
        const e = et[j];
        if (blancos.has(e)) { if (!v[j]) { v[j] = 1; pila.push(j); } }
        else if (e < 0) afuera = true;
        else vecinos.set(e, (vecinos.get(e) ?? 0) + 1);
      }
    }
    // El contorno burdeo rodea casi todo: no dice de qué color es la zona.
    const orden = [...vecinos.entries()].filter(([e]) => !esMarca(e)).sort((a, b) => b[1] - a[1]);
    const vecino = orden[0]?.[0];
    if (afuera || vecino === undefined || luzDe(centros[vecino]) < 70) {
      for (const i of mancha) et[i] = -1;
      huecos++;
      continue;
    }
    const base = centros[vecino];
    const claro = base.map((c) => Math.round(c * 0.38 + 255 * 0.62));
    let idx = centros.findIndex((c) => c[0] === claro[0] && c[1] === claro[1] && c[2] === claro[2]);
    if (idx < 0) { centros.push(claro); idx = centros.length - 1; }
    for (const i of mancha) et[i] = idx;
    tenidas++;
  }
  console.log(`blanco restante: ${huecos} huecos transparentes, ${tenidas} zonas con color`);
}

// ---------- bordes contra el vacío ----------
// Donde un color toca el blanco o lo transparente, el suavizado del
// original dejó una franja de un tono más claro. Esos puntos toman
// el color que domina a su alrededor, sin contar blanco ni vacío.
{
  const R = 5, sal = Int8Array.from(et), cuenta = new Int32Array(centros.length);
  const hueco = (e) => e < 0 || blancos.has(e);
  const luz = (e) => 0.3 * centros[e][0] + 0.59 * centros[e][1] + 0.11 * centros[e][2];
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    const e = et[Y * W + X];
    if (hueco(e)) continue;
    cuenta.fill(0); let cerca = false, total = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const yy = Y + dy, xx = X + dx;
      const v = yy < 0 || yy >= H || xx < 0 || xx >= W ? -1 : et[yy * W + xx];
      if (hueco(v)) { cerca = true; continue; }
      cuenta[v]++; total++;
    }
    if (!cerca) continue;
    let bi = e; for (let i = 0; i < cuenta.length; i++) if (cuenta[i] > cuenta[bi]) bi = i;
    if (bi !== e && (cuenta[e] < total * 0.45 || luz(e) > luz(bi) + 10)) sal[Y * W + X] = bi;
  }
  et = sal;
}

// ---------- motas sueltas ----------
// Puntitos que quedaron flotando fuera del dibujo.
{
  const v = new Uint8Array(W * H);
  for (let i0 = 0; i0 < W * H; i0++) {
    if (v[i0] || et[i0] < 0) continue;
    const pila = [i0], isla = []; v[i0] = 1;
    while (pila.length) {
      const i = pila.pop(); isla.push(i);
      const x = i % W, y = (i / W) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j >= 0 && !v[j] && et[j] >= 0) { v[j] = 1; pila.push(j); }
      }
    }
    if (isla.length < 1500) for (const i of isla) et[i] = -1;
  }
}

// ---------- achicar con suavizado ----------
const ow = W / BAJA, oh = H / BAJA;
const out = new PNG({ width: ow, height: oh });
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = 0; dy < BAJA; dy++) for (let dx = 0; dx < BAJA; dx++) {
    const e = et[(y * BAJA + dy) * W + x * BAJA + dx];
    if (e >= 0) { r += centros[e][0]; g += centros[e][1]; b += centros[e][2]; n++; }
  }
  const o = (y * ow + x) * 4;
  if (n) { out.data[o] = Math.round(r / n); out.data[o + 1] = Math.round(g / n); out.data[o + 2] = Math.round(b / n); }
  out.data[o + 3] = Math.round(255 * n / (BAJA * BAJA));
}
writeFileSync(salida, PNG.sync.write(out));
console.log(`${salida}: ${ow}×${oh}, ${centros.length} colores, hoja: ${quitados} puntos transparentes`);
