// Deja el logo limpio en assets/ a partir de los originales:
//
//   node herramientas/armar-logo.mjs && node herramientas/generar-iconos.ts
//
// La manzana se limpia una vez (pulir-logo.mjs) y se usa igual en
// los dos archivos: sola (logo-marca.png) y con el nombre (logo.png).
import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const assets = join(aqui, '../assets');
const tmp = mkdtempSync(join(tmpdir(), 'logo-'));
const pulir = (de, a) => execFileSync('node', [join(aqui, 'pulir-logo.mjs'), de, a, '16'], { stdio: 'ignore' });

pulir(join(aqui, 'logo-marca-original.png'), join(assets, 'logo-marca.png'));
pulir(join(aqui, 'logo-con-texto-original.png'), join(tmp, 'texto.png'));

const marca = PNG.sync.read(readFileSync(join(assets, 'logo-marca.png')));
const conTexto = PNG.sync.read(readFileSync(join(tmp, 'texto.png')));
const { width: W, height: H } = conTexto;

// Dónde termina la manzana y empieza el nombre: la primera franja
// vacía de lado a lado, mirando desde la mitad hacia abajo.
let corte = Math.round(H / 2);
for (let y = corte; y < H; y++) {
  let vacia = true;
  for (let x = 0; x < W; x++) if (conTexto.data[(y * W + x) * 4 + 3] > 8) { vacia = false; break; }
  if (vacia) { corte = y; break; }
}

const out = new PNG({ width: W, height: H });
// El nombre, tal cual quedó limpio.
for (let y = corte; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  out.data.set(conTexto.data.subarray(i, i + 4), i);
}
// La manzana, la misma del otro archivo, ajustada al alto disponible.
const alto = Math.min(marca.height, corte - 4), ancho = Math.round(marca.width * alto / marca.height);
const x0 = Math.round((W - ancho) / 2), y0 = corte - 4 - alto;
for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
  const sx = Math.min(marca.width - 1, Math.round(x * marca.width / ancho));
  const sy = Math.min(marca.height - 1, Math.round(y * marca.height / alto));
  const s = (sy * marca.width + sx) * 4, d = ((y0 + y) * W + x0 + x) * 4;
  out.data.set(marca.data.subarray(s, s + 4), d);
}
writeFileSync(join(assets, 'logo.png'), PNG.sync.write(out));
console.log(`logo-marca.png ${marca.width}×${marca.height} · logo.png ${W}×${H} (nombre desde la fila ${corte})`);
