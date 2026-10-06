// Copia la base local (PGlite) a la de DATABASE_URL, tabla por tabla.
//
//   node --env-file=.env herramientas/copiar-a-postgres.mjs [carpeta] [--si]
//
// Sin `--si` solo cuenta lo que hay en cada lado. Con `--si` agrega
// al destino las filas locales que le faltan. No borra ni pisa nada:
// una fila que ya existe allá (mismo id) queda como está. El destino
// tiene que tener ya el esquema (arrancar el servidor una vez).
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const deVerdad = args.includes('--si');
const carpeta = args.find((a) => !a.startsWith('--')) ?? join(aqui, '../datos');

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');

const origen = new PGlite(carpeta);
const destino = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await destino.connect();

const TABLAS = `SELECT table_name AS t FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
const COLUMNAS = `SELECT column_name AS c, data_type AS tipo FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`;

const enOrigen = new Set((await origen.query(TABLAS)).rows.map((r) => r.t));
const enDestino = (await destino.query(TABLAS)).rows.map((r) => r.t);
const tablas = enDestino.filter((t) => enOrigen.has(t));

// Orden por llaves foráneas: primero las tablas de las que otras dependen.
const fks = (await destino.query(`
  SELECT c.conrelid::regclass::text AS hija, c.confrelid::regclass::text AS madre
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE c.contype = 'f' AND n.nspname = 'public'`)).rows;
const orden = [];
const visto = new Set();
const visitar = (t) => {
  if (visto.has(t)) return;
  visto.add(t);
  for (const f of fks) if (f.hija === t && f.madre !== t && tablas.includes(f.madre)) visitar(f.madre);
  orden.push(t);
};
tablas.forEach(visitar);

const contar = async (db, t) => Number((await db.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
for (const t of orden) {
  console.log(`${t.padEnd(24)} local ${String(await contar(origen, t)).padStart(5)}   destino ${String(await contar(destino, t)).padStart(5)}`);
}
if (!deVerdad) {
  console.log('\nSolo conté. Con --si se agregan al destino las filas locales que faltan.');
  await destino.end(); await origen.close(); process.exit(0);
}

await destino.query('BEGIN');
try {
  // Las llaves que se apuntan en círculo se revisan recién al final.
  await destino.query('SET CONSTRAINTS ALL DEFERRED');
  for (const t of orden) {
    const colsO = new Set((await origen.query(COLUMNAS, [t])).rows.map((r) => r.c));
    const cols = (await destino.query(COLUMNAS, [t])).rows.filter((r) => colsO.has(r.c));
    const filas = (await origen.query(`SELECT ${cols.map((c) => `"${c.c}"`).join(', ')} FROM "${t}"`)).rows;
    let nuevas = 0;
    const porVez = Math.max(1, Math.floor(2000 / cols.length));
    for (let i = 0; i < filas.length; i += porVez) {
      const lote = filas.slice(i, i + porVez);
      const valores = [];
      const huecos = lote.map((f) => `(${cols.map((c) => {
        const v = f[c.c];
        // `pg` manda los arreglos de JS como arreglos de Postgres:
        // el JSON hay que pasarlo ya escrito.
        valores.push(v !== null && (c.tipo === 'json' || c.tipo === 'jsonb') ? JSON.stringify(v) : v);
        return `$${valores.length}`;
      }).join(', ')})`);
      const r = await destino.query(
        `INSERT INTO "${t}" (${cols.map((c) => `"${c.c}"`).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${huecos.join(', ')}
         ON CONFLICT DO NOTHING`, valores);
      nuevas += r.rowCount;
    }
    console.log(`${t}: ${nuevas} nuevas de ${filas.length}`);
  }
  // Los contadores automáticos siguen desde donde iba la base local.
  const series = (await destino.query(`
    SELECT table_name AS t, column_name AS c, pg_get_serial_sequence(quote_ident(table_name), column_name) AS s
    FROM information_schema.columns WHERE table_schema = 'public'`)).rows.filter((r) => r.s);
  for (const r of series) {
    await destino.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX("${r.c}"), 0) FROM "${r.t}"), 1))`, [r.s]);
  }
  await destino.query('COMMIT');
  console.log('\nListo.');
} catch (e) {
  await destino.query('ROLLBACK');
  console.error('\nNo se copió nada (se deshizo todo):', e.message);
  process.exitCode = 1;
}
await destino.end();
await origen.close();
