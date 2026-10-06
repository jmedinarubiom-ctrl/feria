// Revisa que el servidor publicado esté sano. Solo lee: no crea
// pedidos ni le avisa a nadie.
//
//   node --env-file=.env herramientas/revisar.mjs
import pg from 'pg';

const ref = new URL(process.env.DATABASE_URL).username.split('.')[1];
const u = process.env.FERIA_REVISAR_URL ?? `https://${ref}.supabase.co/functions/v1/api`;
let malas = 0;
const paso = (ok, nombre, detalle = '') => {
  if (!ok) malas++;
  console.log(`${ok ? '✓' : '✗'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
};
const medir = async (camino) => {
  const t = Date.now();
  try {
    const r = await fetch(u + camino, { signal: AbortSignal.timeout(30000) });
    return { r, ms: Date.now() - t, cuerpo: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer() };
  } catch (e) {
    return { r: null, ms: Date.now() - t, error: e.message };
  }
};

const salud = await medir('/salud');
paso(salud.r?.ok && salud.cuerpo.ok, 'el servidor responde', salud.r ? `${salud.ms} ms, base ${salud.cuerpo.motor}, pagos ${salud.cuerpo.pagos}` : salud.error);
const cat = await medir('/catalogo');
const productos = cat.r?.ok ? [cat.cuerpo].flat().flatMap((x) => x.productos ?? []) : [];
paso(cat.r?.ok && productos.length > 0, 'catálogo', cat.r ? `${productos.length} productos, ${cat.ms} ms` : cat.error);
const foto = await medir('/referencia/p-ajo');
paso(foto.r?.ok && foto.r.headers.get('content-type')?.startsWith('image/'), 'fotos de referencia', `${foto.ms} ms`);
const metodos = await medir('/auth/metodos');
paso(metodos.r?.ok, 'formas de entrar', metodos.r?.ok ? Object.entries(metodos.cuerpo).filter(([, v]) => v).map(([k]) => k).join(', ') : '');
const cerrado = await medir('/operador/tablero');
paso(cerrado.r?.status === 401, 'el panel exige sesión', `respondió ${cerrado.r?.status}`);
const dev = await fetch(u + '/dev/vencer-ofertas', { method: 'POST', body: '{}' }).catch(() => null);
paso(dev?.status === 404, 'los atajos de desarrollo están cerrados', `respondió ${dev?.status}`);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const uno = async (sql) => (await db.query(sql)).rows[0];
const motor = await uno(`SELECT extract(epoch FROM now() - visto)::int AS s FROM motor`);
paso(motor && motor.s < 90, 'el motor del despacho late', motor ? `hace ${motor.s} s` : 'nunca latió');
const rls = await uno(`SELECT count(*)::int t, (count(*) FILTER (WHERE rowsecurity))::int r FROM pg_tables WHERE schemaname = 'public'`);
paso(rls.t === rls.r, 'tablas cerradas al acceso directo', `${rls.r} de ${rls.t}`);
const resp = await uno(`SELECT max(right(tablename, 8)) AS dia FROM pg_tables WHERE schemaname = 'respaldo'`).catch(() => ({}));
const ayer = new Date(Date.now() - 36 * 3600e3).toISOString().slice(0, 10).replaceAll('-', '');
paso(!!resp.dia && resp.dia >= ayer, 'respaldo diario', resp.dia ? `último: ${resp.dia}` : 'no hay ninguno');
const err = await uno(`SELECT count(*)::int n FROM errores WHERE cuando > now() - interval '1 day'`);
paso(err.n === 0, 'errores internos en 24 horas', String(err.n));
const cron = await uno(`SELECT count(*)::int n FROM cron.job WHERE active`);
paso(cron.n >= 3, 'tareas programadas', `${cron.n} activas`);
await db.end();

console.log(malas ? `\n${malas} cosa(s) por revisar.` : '\nTodo en orden.');
process.exit(malas ? 1 : 0);
