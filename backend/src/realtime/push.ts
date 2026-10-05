import { consultarUno, consultar, ejecutar, type Fila } from '../db/index.ts';
import { bus, type Mensaje } from './bus.ts';

/**
 * Notificaciones push por la API de Expo.
 *
 * Expo habla con APNs y FCM por nosotros, así que no hace falta
 * configurar Firebase ni certificados de Apple para empezar. Cuando
 * el proyecto salga de Expo, se cambia este archivo y nada más.
 */

const URL_EXPO = 'https://exp.host/--/api/v2/push/send';

export type MensajePush = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
  /** Segundos que el mensaje sigue siendo útil. */
  ttl?: number;
  interruptionLevel?: 'active' | 'timeSensitive' | 'critical' | 'passive';
};

type RespuestaExpo = {
  data?: Array<{ status: string; id?: string; details?: { error?: string } }>;
};

/** Transporte reemplazable: los tests no salen a internet. */
type Transporte = (lote: MensajePush[]) => Promise<RespuestaExpo>;

const porExpo: Transporte = async (lote) => {
  const r = await fetch(URL_EXPO, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(lote),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Expo respondió ${r.status}`);
  return r.json() as Promise<RespuestaExpo>;
};

let transporte: Transporte = porExpo;
export const fijarTransporte = (t: Transporte): void => { transporte = t; };
export const restaurarTransporte = (): void => { transporte = porExpo; };

/** Expo acepta hasta 100 mensajes por petición. */
const TAMANO_LOTE = 100;

/**
 * Envía y limpia los tokens muertos.
 *
 * Un teléfono que desinstaló la app sigue con su token en la base;
 * si no se borra, cada oferta futura gasta un envío inútil y ensucia
 * las métricas de entrega.
 */
export async function enviarPush(mensajes: MensajePush[]): Promise<{ enviados: number; fallidos: number }> {
  const validos = mensajes.filter((m) => m.to);
  let enviados = 0;
  let fallidos = 0;

  for (let i = 0; i < validos.length; i += TAMANO_LOTE) {
    const lote = validos.slice(i, i + TAMANO_LOTE);
    try {
      const r = await transporte(lote);
      const resultados = r.data ?? [];
      for (let j = 0; j < lote.length; j++) {
        const res = resultados[j];
        if (res?.status === 'ok') {
          enviados++;
          continue;
        }
        fallidos++;
        if (res?.details?.error === 'DeviceNotRegistered') {
          await borrarToken(lote[j].to);
        }
      }
    } catch (e) {
      // Que falle el push no puede tumbar un despacho: el aviso por
      // WebSocket ya salió y la app lo va a ver igual al abrirla.
      fallidos += lote.length;
      console.error('[push] no se pudo enviar el lote:', e);
    }
  }
  return { enviados, fallidos };
}

async function borrarToken(token: string): Promise<void> {
  for (const tabla of ['feriantes', 'repartidores', 'operadores']) {
    await ejecutar(`UPDATE ${tabla} SET push_token = NULL WHERE push_token = ?`, token);
  }
}

// ============================================================
// Contenido de cada aviso
// ============================================================

const clp = (n: number): string => '$' + Math.round(n).toLocaleString('es-CL');

const resumirItems = (items: Fila[]): string =>
  items.map((i) => `${i.cantidad}× ${i.nombre}`).join(', ');

/**
 * La oferta que le llega al feriante.
 *
 * El monto va en el título porque es lo único que se lee en la
 * pantalla bloqueada, y es lo que decide si vale la pena mirar.
 */
async function avisoDeOferta(m: Extract<Mensaje, { tipo: 'oferta:nueva' }>): Promise<MensajePush | null> {
  const f = await consultarUno<Fila>(
    'SELECT push_token FROM feriantes WHERE id = ?', m.ferianteId);
  if (!f?.push_token) return null;

  const sub = await consultarUno<Fila>(
    `SELECT s.monto_feriante, r.nombre AS rubro, p.numero
       FROM sub_pedidos s
       JOIN rubros r ON r.id = s.rubro_id
       JOIN pedidos p ON p.id = s.pedido_id
      WHERE s.id = ?`,
    m.subPedidoId);
  if (!sub) return null;

  const items = await consultar<Fila>(
    'SELECT nombre, cantidad FROM items WHERE sub_pedido_id = ?', m.subPedidoId);

  // La oferta vence sola: un aviso que llega después no sirve de
  // nada, y peor, manda al feriante a una pantalla vacía.
  const restante = Math.max(0, Math.round((new Date(m.expiraAt).getTime() - Date.now()) / 1000));
  if (restante < 5) return null;

  return {
    to: f.push_token,
    title: `${clp(sub.monto_feriante)} · ${sub.rubro}`,
    body: resumirItems(items),
    sound: 'default',
    priority: 'high',
    channelId: 'ofertas',
    ttl: restante,
    // Lo más cerca de una llamada entrante que permite iOS sin ser
    // una app de VoIP: atraviesa los modos de concentración.
    interruptionLevel: 'timeSensitive',
    data: { tipo: 'oferta', subPedidoId: m.subPedidoId, pedido: sub.numero },
  };
}

/** El viaje que se ofrece a todos los repartidores conectados. */
async function avisosDeViaje(m: Extract<Mensaje, { tipo: 'viaje:nuevo' }>): Promise<MensajePush[]> {
  const viaje = await consultarUno<Fila>(
    `SELECT v.tarifa, p.numero, p.direccion,
            (SELECT COUNT(*)::int FROM paradas
              WHERE viaje_id = v.id AND tipo = 'RETIRO') AS retiros
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.id = ?`,
    m.viajeId);
  if (!viaje) return [];

  const repartidores = await consultar<Fila>(
    'SELECT push_token FROM repartidores WHERE conectado AND activo AND push_token IS NOT NULL');

  return repartidores.map((r) => ({
    to: r.push_token,
    title: `Viaje ${clp(viaje.tarifa)}`,
    body: `${viaje.retiros} ${viaje.retiros === 1 ? 'puesto' : 'puestos'} · ${viaje.direccion}`,
    sound: 'default' as const,
    priority: 'high' as const,
    channelId: 'viajes',
    ttl: 300,
    interruptionLevel: 'timeSensitive' as const,
    data: { tipo: 'viaje', viajeId: m.viajeId, pedido: viaje.numero },
  }));
}

/** Nadie tomó el pedido: le toca al operador ir a comprarlo. */
async function avisosDeAutogestion(
  m: Extract<Mensaje, { tipo: 'autogestion:nueva' }>,
): Promise<MensajePush[]> {
  const sub = await consultarUno<Fila>(
    `SELECT r.nombre AS rubro, p.numero
       FROM sub_pedidos s
       JOIN rubros r ON r.id = s.rubro_id
       JOIN pedidos p ON p.id = s.pedido_id
      WHERE s.id = ?`,
    m.subPedidoId);
  if (!sub) return [];

  const operadores = await consultar<Fila>(
    'SELECT push_token FROM operadores WHERE push_token IS NOT NULL');

  return operadores.map((o) => ({
    to: o.push_token,
    title: `Nadie tomó el pedido #${sub.numero}`,
    body: `${sub.rubro} — lo tienes que comprar tú`,
    sound: 'default' as const,
    priority: 'high' as const,
    channelId: 'autogestion',
    ttl: 3600,
    interruptionLevel: 'timeSensitive' as const,
    data: { tipo: 'autogestion', subPedidoId: m.subPedidoId, pedido: sub.numero },
  }));
}

// ============================================================
// Enganche al bus
// ============================================================

let enganchado = false;

/**
 * Empieza a mandar push a partir de los avisos del bus.
 *
 * El bus emite después del COMMIT, así que acá los datos ya son
 * visibles y se pueden consultar sin carreras.
 */
export function iniciarNotificaciones(): void {
  if (enganchado) return;
  enganchado = true;

  bus.on('mensaje', (m) => {
    void (async () => {
      try {
        if (m.tipo === 'oferta:nueva') {
          const aviso = await avisoDeOferta(m);
          if (aviso) await enviarPush([aviso]);
        } else if (m.tipo === 'viaje:nuevo') {
          await enviarPush(await avisosDeViaje(m));
        } else if (m.tipo === 'autogestion:nueva') {
          await enviarPush(await avisosDeAutogestion(m));
        }
      } catch (e) {
        console.error('[push]', e);
      }
    })();
  });
}
