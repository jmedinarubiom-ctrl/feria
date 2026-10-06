// El servidor de la feria corriendo como función de Supabase.
//
// Es el mismo código de backend/src (se copia a ./src al desplegar):
// acá solo se traduce la petición de Deno a lo que `atender` espera.
// El reloj del despacho lo pone la base: pg_cron llama a
// /interno/latir cada minuto.
import process from 'node:process';
import { Buffer } from 'node:buffer';

const g = globalThis as any;
g.process ??= process;
g.Buffer ??= Buffer;

// La conexión de la función pasa por el pooler en modo transacción
// (puerto 6543): cada copia de la función abre las suyas y el modo
// sesión se queda sin cupos.
const base = (() => {
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) throw new Error('Falta DATABASE_URL.');
  return url.includes('pooler.supabase.com:5432') ? url.replace(':5432/', ':6543/') : url;
})();

const { atender, preparar, ErrorHttp } = await import('./src/http/servidor.ts');
const listo: Promise<void> = preparar(base);

Deno.serve(async (peticion: Request) => {
  await listo;
  const u = new URL(peticion.url);
  // Llega como /api/... (o /functions/v1/api/...): el servidor
  // conoce las rutas sin ese prefijo.
  const camino = u.pathname.replace(/^\/(functions\/v1\/)?api(?=\/|$)/, '') || '/';
  const headers: Record<string, string> = {};
  peticion.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const ip = (headers['x-forwarded-for'] ?? '').split(',')[0].trim();

  const r = await atender(
    { method: peticion.method, url: camino + u.search, headers, socket: { remoteAddress: ip } },
    async (max: number) => {
      const cuerpo = Buffer.from(await peticion.arrayBuffer());
      if (cuerpo.length > max) throw new ErrorHttp(413, 'Cuerpo demasiado grande.');
      return cuerpo;
    },
  );
  return new Response(r.cuerpo, { status: r.estado, headers: r.cabeceras });
});
