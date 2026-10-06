// Programa en la base (pg_cron + pg_net) la llamada que hace latir
// el motor de la función cada minuto.
//
//   node --env-file=.env herramientas/programar-latido.mjs
//
// Se puede correr de nuevo: reemplaza la programación anterior.
import pg from 'pg';

const { DATABASE_URL, FERIA_MOTOR_SECRETO } = process.env;
if (!DATABASE_URL || !FERIA_MOTOR_SECRETO) throw new Error('Faltan DATABASE_URL o FERIA_MOTOR_SECRETO');
const ref = new URL(DATABASE_URL).username.split('.')[1];
const url = `https://${ref}.supabase.co/functions/v1/api/interno/latir`;

const db = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await db.query('CREATE EXTENSION IF NOT EXISTS pg_cron');
await db.query('CREATE EXTENSION IF NOT EXISTS pg_net');
const sql = `SELECT net.http_post(
  url := ${db.escapeLiteral(url)},
  headers := jsonb_build_object('content-type', 'application/json', 'x-feria-motor', ${db.escapeLiteral(FERIA_MOTOR_SECRETO)}),
  body := '{}'::jsonb,
  timeout_milliseconds := 8000)`;
await db.query(`SELECT cron.schedule('feria-latido', '* * * * *', $1)`, [sql]);
// El registro de pg_cron crece una fila por minuto: se limpia solo.
await db.query(`SELECT cron.schedule('feria-latido-limpieza', '17 5 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '2 days'$$)`);
const r = await db.query(`SELECT jobname, schedule, active FROM cron.job ORDER BY jobname`);
console.log(r.rows);
await db.end();
