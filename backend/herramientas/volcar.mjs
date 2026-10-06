// Baja toda la base de DATABASE_URL a un archivo JSON comprimido.
//
//   node --env-file=.env herramientas/volcar.mjs [destino.json.gz]
//
// Es lo que usa ./respaldar.sh cuando no hay pg_dump instalado.
import pg from 'pg';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
const destino = process.argv[2] ?? `base-${new Date().toISOString().slice(0, 10)}.json.gz`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
// Las fechas y los números grandes viajan como texto, tal cual están.
for (const oid of [20, 1082, 1114, 1184, 1700]) pg.types.setTypeParser(oid, (v) => v);

const tablas = (await db.query(
  `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
const volcado = { hecho: new Date().toISOString(), tablas: {} };
let filas = 0;
for (const t of tablas) {
  const r = await db.query(`SELECT * FROM "${t}"`);
  volcado.tablas[t] = r.rows.map((f) => Object.fromEntries(Object.entries(f).map(
    ([k, v]) => [k, Buffer.isBuffer(v) ? { base64: v.toString('base64') } : v])));
  filas += r.rowCount;
}
await db.end();
writeFileSync(destino, gzipSync(JSON.stringify(volcado)), { mode: 0o600 });
console.log(`${tablas.length} tablas, ${filas} filas → ${destino}`);
