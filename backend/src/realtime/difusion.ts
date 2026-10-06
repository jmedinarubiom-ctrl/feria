import { createHmac } from 'node:crypto';
import { bus, type Mensaje } from './bus.ts';

/**
 * Avisos en vivo por Supabase Realtime.
 *
 * Cuando el servidor corre como función no hay WebSocket propio: las
 * copias no comparten memoria ni viven lo suficiente. El aviso sale
 * por el canal en vivo de Supabase y la app, al recibirlo, vuelve a
 * preguntar la verdad por la API — igual que con el WebSocket.
 *
 * El aviso no lleva datos, solo «algo cambió». Y el nombre de cada
 * canal sale de un HMAC: quien no pasó por `/vivo` no lo adivina,
 * así que escuchar el canal de otro no sirve ni para saber cuándo
 * se mueve.
 */
const URL_SUPABASE = process.env.SUPABASE_URL;
const LLAVE_SERVIDOR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLAVE_PUBLICA = process.env.SUPABASE_ANON_KEY;

export const hayDifusion = (): boolean => !!(URL_SUPABASE && LLAVE_SERVIDOR && LLAVE_PUBLICA);

const canal = (tema: string): string =>
  'feria-' + createHmac('sha256', process.env.FERIA_SECRETO ?? 'secreto-de-desarrollo')
    .update('canal:' + tema).digest('hex').slice(0, 32);

/** A qué temas le interesa un mensaje. El espejo de `leRegistra`. */
export function temasDe(m: Mensaje): string[] {
  switch (m.tipo) {
    case 'oferta:nueva':
    case 'oferta:cerrada':
      return [`f:${m.ferianteId}`];
    case 'autogestion:nueva':
      return ['op'];
    case 'viaje:nuevo':
      return ['rs', 'op'];
    case 'viaje:cambio':
      return ['op', m.repartidorId ? `r:${m.repartidorId}` : 'rs'];
    case 'subpedido:cambio':
      return ['op', `p:${m.pedidoId}`, ...(m.ferianteId ? [`f:${m.ferianteId}`] : [])];
    case 'pedido:cambio':
    case 'pedido:cancelado':
    case 'ubicacion':
      return ['op', `p:${m.pedidoId}`];
    default:
      return [];
  }
}

/** Lo que la app necesita para escuchar: dónde, con qué llave y qué canales. */
export function comoEscuchar(quien: { rol: string; id: string }) {
  if (!hayDifusion()) return { disponible: false as const };
  const temas = quien.rol === 'operador' ? ['op']
    : quien.rol === 'feriante' ? [`f:${quien.id}`]
    : quien.rol === 'repartidor' ? [`r:${quien.id}`, 'rs']
    : [`p:${quien.id}`];
  return {
    disponible: true as const,
    url: URL_SUPABASE!.replace(/^http/, 'ws') + '/realtime/v1/websocket',
    llave: LLAVE_PUBLICA!,
    canales: temas.map(canal),
  };
}

let enganchada = false;

export function iniciarDifusion(): void {
  if (enganchada || !hayDifusion()) return;
  enganchada = true;
  bus.on('mensaje', (m) => {
    const temas = temasDe(m);
    if (!temas.length) return;
    const envio = fetch(`${URL_SUPABASE}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: LLAVE_SERVIDOR!,
        authorization: `Bearer ${LLAVE_SERVIDOR}`,
      },
      body: JSON.stringify({
        messages: temas.map((t) => ({ topic: canal(t), event: 'cambio', payload: { t: m.tipo } })),
      }),
    }).then(async (r) => {
      if (!r.ok) console.error('[vivo] aviso rechazado', r.status, (await r.text()).slice(0, 200));
    }).catch((e) => console.error('[vivo]', e?.message ?? e));
    // En una función, lo que queda suelto se corta al responder.
    (globalThis as any).EdgeRuntime?.waitUntil?.(envio);
  });
}
