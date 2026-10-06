// Respaldo diario DENTRO de la base: una copia de cada tabla en el
// esquema `respaldo`, con la fecha en el nombre, por 7 días.
//
//   node --env-file=.env herramientas/programar-respaldo.mjs
//
// Protege de borrar o dañar datos por error (se recupera con un
// INSERT ... SELECT desde la copia). NO protege de perder el proyecto
// entero: para eso está ./respaldar.sh, que baja todo al computador.
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

await db.query('CREATE EXTENSION IF NOT EXISTS pg_cron');
await db.query('CREATE SCHEMA IF NOT EXISTS respaldo');
await db.query('REVOKE ALL ON SCHEMA respaldo FROM PUBLIC');
for (const rol of ['anon', 'authenticated']) {
  await db.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA respaldo FROM ${rol}';
    END IF; END $$`);
}
await db.query(`
CREATE OR REPLACE FUNCTION respaldo.tomar() RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
  t record;
  hoy text := to_char(now(), 'YYYYMMDD');
  n integer := 0;
BEGIN
  -- Las fotos no: pesan, no cambian y están en el código.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'archivos' LOOP
    EXECUTE format('DROP TABLE IF EXISTS respaldo.%I', t.tablename || '_' || hoy);
    EXECUTE format('CREATE TABLE respaldo.%I AS TABLE public.%I', t.tablename || '_' || hoy, t.tablename);
    n := n + 1;
  END LOOP;
  -- Se guardan 7 días.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'respaldo'
            AND right(tablename, 8) ~ '^[0-9]{8}$'
            AND right(tablename, 8) < to_char(now() - interval '7 days', 'YYYYMMDD') LOOP
    EXECUTE format('DROP TABLE respaldo.%I', t.tablename);
  END LOOP;
  RETURN n;
END $f$`);
// 07:15 UTC: de madrugada en Chile, con la feria cerrada.
await db.query(`SELECT cron.schedule('feria-respaldo', '15 7 * * *', 'SELECT respaldo.tomar()')`);
const r = await db.query('SELECT respaldo.tomar() AS n');
const hay = await db.query(`SELECT count(*)::int AS n, pg_size_pretty(sum(pg_total_relation_size(format('respaldo.%I', tablename)::regclass))) AS peso
                             FROM pg_tables WHERE schemaname = 'respaldo'`);
console.log(`respaldo de hoy: ${r.rows[0].n} tablas · en total ${hay.rows[0].n} copias, ${hay.rows[0].peso}`);
await db.end();
