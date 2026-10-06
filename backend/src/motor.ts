import { randomUUID } from 'node:crypto';
import { ejecutar, nombreMotor } from './db/index.ts';
import { tick } from './dominio/despacho.ts';
import { revisarCobrosAbiertos } from './dominio/pagos.ts';
import { CONFIG } from './config.ts';

/**
 * El turno del motor.
 *
 * El despacho supone un solo reloj. Con PGlite hay un solo proceso y
 * no hay nada que coordinar. Con Postgres puede haber varios mirando
 * la misma base —dos copias de la función, o la función y el
 * computador del operador—: late solo quien tiene el turno.
 */
const YO = randomUUID();
const SEGUNDOS_SIN_MARCAR = 6;

export async function tengoElTurno(): Promise<boolean> {
  if (!nombreMotor().startsWith('postgres')) return true;
  const r = await ejecutar(
    `INSERT INTO motor (id, dueno, visto) VALUES (1, ?, now())
     ON CONFLICT (id) DO UPDATE SET dueno = EXCLUDED.dueno, visto = now()
      WHERE motor.dueno = EXCLUDED.dueno
         OR motor.visto < now() - interval '${SEGUNDOS_SIN_MARCAR} seconds'`, YO);
  return r.afectadas === 1;
}

const dormir = (ms: number) => new Promise<void>((r) => {
  (setTimeout(r, ms) as any).unref?.();
});

/**
 * Hace latir el motor mientras `seguir()` diga que sí.
 *
 * El latido se encadena en vez de usar setInterval para que dos no
 * se solapen si uno tarda más de un segundo. Los cobros abiertos se
 * revisan contra la pasarela cada 8 segundos: el webhook es el
 * camino rápido, esto es la red que lo atrapa cuando se pierde.
 */
export async function latir(seguir: () => boolean): Promise<void> {
  let ultimaRevision = Date.now();
  while (seguir()) {
    try {
      if (await tengoElTurno()) {
        await tick();
        if (Date.now() - ultimaRevision >= 8000) {
          ultimaRevision = Date.now();
          const r = await revisarCobrosAbiertos();
          if (r.confirmados > 0) console.log(`[pagos] ${r.confirmados} cobro(s) confirmados al revisar`);
        }
      }
    } catch (e) {
      console.error('[tick]', e);
    }
    await dormir(CONFIG.intervaloTickMs);
  }
}
