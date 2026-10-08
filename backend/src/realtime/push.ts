import { consultarUno, consultar, ejecutar, type Fila } from '../db/index.ts';
import { bus, type Mensaje } from './bus.ts';
import { CONFIG } from '../config.ts';

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
  for (const tabla of ['feriantes', 'repartidores', 'operadores', 'clientes']) {
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
    `SELECT v.tarifa, p.numero, p.direccion, p.feria_id,
            (SELECT COUNT(*)::int FROM paradas
              WHERE viaje_id = v.id AND tipo = 'RETIRO') AS retiros
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.id = ?`,
    m.viajeId);
  if (!viaje) return [];

  const repartidores = await consultar<Fila>(
    `SELECT push_token FROM repartidores
      WHERE conectado AND activo AND push_token IS NOT NULL
        AND (feria_id IS NULL OR feria_id = ?)`, viaje.feria_id);

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
/**
 * Lo que le importa a quien compró: que su pedido se recibió, que va
 * en camino, que llegó, o que se canceló. Los pasos internos de la
 * feria no se le avisan: serían cinco notificaciones por pedido.
 */
const PARA_EL_CLIENTE: Record<string, (numero: number) => { title: string; body: string }> = {
  PAGADO: (n) => ({ title: `Recibimos tu pedido #${n}`, body: 'Ya lo estamos preparando en la feria.' }),
  EN_RUTA: (n) => ({ title: `Tu pedido #${n} va en camino`, body: 'El repartidor ya salió de la feria.' }),
  ENTREGADO: (n) => ({ title: `Pedido #${n} entregado`, body: '¡Que lo disfrutes! Gracias por comprar en la feria.' }),
  CANCELADO: (n) => ({ title: `Tu pedido #${n} se canceló`, body: 'Si ya habías pagado, te devolvemos el dinero.' }),
  EXPIRADO: (n) => ({ title: `Tu pedido #${n} venció`, body: 'No alcanzamos a recibir el pago. Puedes armarlo de nuevo cuando quieras.' }),
};

// ============================================================
// Avisos de los puntos críticos, para quien vende y quien reparte
// ============================================================

/**
 * El pedido se canceló: que nadie siga trabajando en él.
 *
 * Es el aviso más caro de perder: un feriante que no se entera sigue
 * apartando mercadería, y un repartidor sigue camino a una casa
 * donde ya no esperan nada.
 */
export async function avisosDeCancelacion(
  m: Extract<Mensaje, { tipo: 'pedido:cancelado' }>,
): Promise<MensajePush[]> {
  const avisos: MensajePush[] = [];
  for (const ferianteId of m.ferianteIds ?? []) {
    const f = await consultarUno<Fila>('SELECT push_token FROM feriantes WHERE id = ?', ferianteId);
    if (!f?.push_token) continue;
    avisos.push({
      to: f.push_token,
      title: `Pedido #${m.numero} cancelado`,
      body: 'No lo sigas preparando. Lo que ya apartaste se te paga igual.',
      sound: 'default', priority: 'high', channelId: 'ofertas',
      data: { tipo: 'cancelado', pedidoId: m.pedidoId },
    });
  }
  const r = await consultarUno<Fila>(
    `SELECT r.push_token FROM viajes v JOIN repartidores r ON r.id = v.repartidor_id
      WHERE v.pedido_id = ? ORDER BY v.creado_at DESC LIMIT 1`, m.pedidoId);
  if (r?.push_token) {
    avisos.push({
      to: r.push_token,
      title: `Pedido #${m.numero} cancelado`,
      body: 'No sigas la ruta. El viaje se te paga según lo que alcanzaste a hacer; habla con la operación.',
      sound: 'default', priority: 'high', channelId: 'viajes',
      data: { tipo: 'cancelado', pedidoId: m.pedidoId },
    });
  }
  return avisos;
}

/** Un repartidor tomó el viaje: los puestos saben quién va a retirar. */
export async function avisosDeRetiro(
  m: Extract<Mensaje, { tipo: 'viaje:cambio' }>,
): Promise<MensajePush[]> {
  if (m.estado !== 'ASIGNADO' || !m.repartidorId) return [];
  const viaje = await consultarUno<Fila>(
    `SELECT p.id AS pedido_id, p.numero, r.nombre AS repartidor
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
       JOIN repartidores r ON r.id = v.repartidor_id
      WHERE v.id = ?`, m.viajeId);
  if (!viaje) return [];
  const puestos = await consultar<Fila>(
    `SELECT DISTINCT f.push_token FROM sub_pedidos s JOIN feriantes f ON f.id = s.feriante_id
      WHERE s.pedido_id = ? AND s.estado IN ('ACEPTADO', 'LISTO') AND f.push_token IS NOT NULL`,
    viaje.pedido_id);
  const nombre = String(viaje.repartidor).split(' ')[0];
  return puestos.map((f) => ({
    to: f.push_token,
    title: `${nombre} va a retirar el pedido #${viaje.numero}`,
    body: 'Tenlo a mano para entregárselo.',
    sound: 'default' as const, priority: 'high' as const, channelId: 'ofertas',
    data: { tipo: 'retiro', pedidoId: viaje.pedido_id },
  }));
}

/** El operador registró el pago del día: el feriante lo confirma en su app. */
export async function avisarPagoAlFeriante(ferianteId: string, monto: number): Promise<void> {
  const f = await consultarUno<Fila>('SELECT push_token FROM feriantes WHERE id = ?', ferianteId);
  if (!f?.push_token || !(monto > 0)) return;
  await enviarPush([{
    to: f.push_token,
    title: `Te pagaron ${clp(monto)}`,
    body: 'Es lo de hoy. Confírmalo en la app cuando lo tengas en la mano.',
    sound: 'default', priority: 'high', channelId: 'ofertas',
    data: { tipo: 'pago' },
  }]);
}

/**
 * Recordatorios que dependen del reloj, no de un evento.
 *
 * Se revisan una vez por minuto, colgados del latido del motor. Cada
 * uno sale UNA vez (tabla `alertas`): un recordatorio que insiste es
 * la forma más rápida de que alguien apague las notificaciones.
 */
export async function enviarRecordatorios(): Promise<number> {
  const pendientes: Array<{ clave: string; aviso: MensajePush }> = [];

  // El comprador armó el pedido y no pagó: a mitad del plazo.
  const mitad = Math.max(2, Math.round(CONFIG.minutosParaPagar * 0.4));
  const sinPagar = await consultar<Fila>(
    `SELECT p.id, p.numero, c.push_token,
            GREATEST(1, ?::int - (extract(epoch FROM now() - p.creado_at) / 60)::int) AS quedan
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
      WHERE p.estado = 'PENDIENTE_PAGO' AND c.push_token IS NOT NULL
        AND p.creado_at < now() - make_interval(mins => ?)
        AND p.creado_at > now() - make_interval(mins => ?)`,
    CONFIG.minutosParaPagar, mitad, CONFIG.minutosParaPagar);
  for (const p of sinPagar) {
    pendientes.push({
      clave: `recordatorio:pago:${p.id}`,
      aviso: {
        to: p.push_token,
        title: `Tu pedido #${p.numero} espera el pago`,
        body: `Te lo guardamos ${p.quedan} ${p.quedan === 1 ? 'minuto' : 'minutos'} más. Entra y termina de pagar.`,
        sound: 'default', priority: 'high', channelId: 'pedidos',
        data: { tipo: 'pedido', pedidoId: p.id },
      },
    });
  }

  // El feriante aceptó hace rato y no marcó listo: el repartidor no
  // sale hasta que todos los puestos avisan.
  const demorados = await consultar<Fila>(
    `SELECT s.id, p.numero, f.push_token
       FROM sub_pedidos s JOIN pedidos p ON p.id = s.pedido_id
       JOIN feriantes f ON f.id = s.feriante_id
      WHERE s.estado = 'ACEPTADO' AND f.push_token IS NOT NULL
        AND s.aceptado_at < now() - make_interval(mins => ?)
        AND s.aceptado_at > now() - interval '3 hours'`,
    Number(process.env.RECORDATORIO_LISTO_MINUTOS ?? 15));
  for (const s of demorados) {
    pendientes.push({
      clave: `recordatorio:listo:${s.id}`,
      aviso: {
        to: s.push_token,
        title: `¿Está listo el pedido #${s.numero}?`,
        body: 'Márcalo listo en la app para que salga el repartidor.',
        sound: 'default', priority: 'high', channelId: 'ofertas',
        data: { tipo: 'recordatorio' },
      },
    });
  }

  // Un viaje tomado que no avanza: el repartidor aceptó y no retiró.
  const quietos = await consultar<Fila>(
    `SELECT v.id, p.numero, r.push_token
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
       JOIN repartidores r ON r.id = v.repartidor_id
      WHERE v.estado = 'ASIGNADO' AND r.push_token IS NOT NULL
        AND COALESCE(v.asignado_at, v.creado_at) < now() - make_interval(mins => ?)
        AND COALESCE(v.asignado_at, v.creado_at) > now() - interval '3 hours'`,
    Number(process.env.RECORDATORIO_RETIRO_MINUTOS ?? 20));
  for (const v of quietos) {
    pendientes.push({
      clave: `recordatorio:retiro:${v.id}`,
      aviso: {
        to: v.push_token,
        title: `El pedido #${v.numero} te espera en la feria`,
        body: 'Los puestos ya lo tienen listo para retirar.',
        sound: 'default', priority: 'high', channelId: 'viajes',
        data: { tipo: 'recordatorio' },
      },
    });
  }

  const nuevos: MensajePush[] = [];
  for (const r of pendientes) {
    const puesto = await ejecutar(
      'INSERT INTO alertas (clave, texto) VALUES (?, ?) ON CONFLICT (clave) DO NOTHING', r.clave, r.aviso.title);
    if (puesto.afectadas === 1) nuevos.push(r.aviso);
  }
  if (nuevos.length) await enviarPush(nuevos);
  return nuevos.length;
}

export async function avisoAlCliente(pedidoId: string, estado: string): Promise<MensajePush | null> {
  const texto = PARA_EL_CLIENTE[estado];
  if (!texto) return null;
  const p = await consultarUno<Fila>(
    `SELECT p.numero, c.push_token FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
      WHERE p.id = ?`, pedidoId);
  if (!p?.push_token) return null;
  return {
    to: p.push_token,
    ...texto(p.numero),
    sound: 'default',
    priority: 'high',
    channelId: 'pedidos',
    data: { tipo: 'pedido', pedidoId },
  };
}

export function iniciarNotificaciones(): void {
  if (enganchado) return;
  enganchado = true;

  bus.on('mensaje', (m) => {
    const envio = (async () => {
      try {
        if (m.tipo === 'oferta:nueva') {
          const aviso = await avisoDeOferta(m);
          if (aviso) await enviarPush([aviso]);
        } else if (m.tipo === 'viaje:nuevo') {
          await enviarPush(await avisosDeViaje(m));
        } else if (m.tipo === 'autogestion:nueva') {
          await enviarPush(await avisosDeAutogestion(m));
        } else if (m.tipo === 'pedido:cancelado') {
          await enviarPush(await avisosDeCancelacion(m));
        } else if (m.tipo === 'viaje:cambio') {
          await enviarPush(await avisosDeRetiro(m));
        } else if (m.tipo === 'pedido:cambio') {
          // La cancelación también llega como `pedido:cambio`: mirar
          // además `pedido:cancelado` mandaría el aviso dos veces.
          const aviso = await avisoAlCliente(m.pedidoId, m.estado);
          if (aviso) await enviarPush([aviso]);
        }
      } catch (e) {
        console.error('[push]', e);
      }
    })();
    // En una función sin servidor el trabajo que queda suelto se
    // corta al responder: hay que avisar que sigue pendiente.
    (globalThis as any).EdgeRuntime?.waitUntil?.(envio);
  });
}
