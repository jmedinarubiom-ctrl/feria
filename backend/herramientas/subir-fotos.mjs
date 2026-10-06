// Sube las fotos de referencia (src/fotos) a la tabla `archivos` de
// la base de DATABASE_URL, para el servidor que corre como función.
//
//   node --env-file=.env herramientas/subir-fotos.mjs
//
// No borra nada: agrega las que faltan y actualiza las que cambiaron.
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const carpeta = join(dirname(fileURLToPath(import.meta.url)), '../src/fotos');
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

let n = 0;
for (const archivo of readdirSync(carpeta)) {
  const r = /^([a-z0-9-]+)\.(jpg|png)$/.exec(archivo);
  if (!r) continue;
  await db.query(
    `INSERT INTO archivos (nombre, mime, datos) VALUES ($1, $2, $3)
     ON CONFLICT (nombre) DO UPDATE SET mime = EXCLUDED.mime, datos = EXCLUDED.datos`,
    [`ref/${r[1]}`, r[2] === 'png' ? 'image/png' : 'image/jpeg', readFileSync(join(carpeta, archivo))]);
  n++;
}
console.log(`${n} fotos de referencia en la base`);
await db.end();
