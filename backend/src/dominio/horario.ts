import { CONFIG } from '../config.ts';

/**
 * Horario de la feria.
 *
 * Sin esto entra un pedido a las tres de la mañana de un martes y
 * cae derecho en la cola de autogestión, porque no hay ni un puesto
 * abierto al que ofrecérselo.
 */

export class FeriaCerrada extends Error {
  codigo = 422;
  constructor(msg: string) {
    super(msg);
    this.name = 'FeriaCerrada';
  }
}

type Horario = {
  dias: readonly number[];
  abre: string;
  ultimoPedido: string;
  cierra: string;
};

let horario: Horario = CONFIG.horario;

/**
 * Interruptor de desarrollo: abre la feria todos los días.
 *
 * Sin esto, un martes no se puede probar absolutamente nada del
 * sistema. Se ignora en producción a propósito — dejar la feria
 * abierta de verdad un martes significa pedidos que nadie puede
 * cumplir.
 */
if (process.env.FERIA_SIEMPRE_ABIERTA === '1' && process.env.NODE_ENV !== 'production') {
  horario = { dias: [0, 1, 2, 3, 4, 5, 6], abre: '00:00', ultimoPedido: '23:59', cierra: '23:59' };
  console.log('[horario] FERIA_SIEMPRE_ABIERTA: la feria acepta pedidos a cualquier hora.');
}

/** Permite abrir la feria en los tests sin apagar la verificación. */
export const fijarHorario = (h: Partial<Horario>): void => {
  horario = { ...horario, ...h };
};
export const horarioActual = (): Horario => horario;

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const CODIGOS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const enMinutos = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Qué día y hora es en la feria, no en el servidor.
 *
 * El servidor puede estar en cualquier parte; la feria abre a la
 * hora de Valparaíso.
 */
export function momentoLocal(cuando = new Date()): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.zonaHoraria,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(cuando);

  const buscar = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  const dia = CODIGOS.indexOf(buscar('weekday'));
  // Intl puede devolver "24" a medianoche en formato de 24 horas.
  const hora = Number(buscar('hour')) % 24;
  return { dia, minutos: hora * 60 + Number(buscar('minute')) };
}

export type EstadoFeria = {
  abierta: boolean;
  aceptandoPedidos: boolean;
  /** Minutos que quedan para pedir, si está abierta. */
  minutosParaCerrar: number | null;
  mensaje: string;
  proxima: { dia: string; hora: string } | null;
};

export function estadoFeria(cuando = new Date()): EstadoFeria {
  const { dia, minutos } = momentoLocal(cuando);
  const abre = enMinutos(horario.abre);
  const ultimo = enMinutos(horario.ultimoPedido);
  const cierra = enMinutos(horario.cierra);
  const esDiaDeFeria = horario.dias.includes(dia);

  const abierta = esDiaDeFeria && minutos >= abre && minutos < cierra;
  const aceptandoPedidos = esDiaDeFeria && minutos >= abre && minutos < ultimo;

  if (aceptandoPedidos) {
    return {
      abierta: true,
      aceptandoPedidos: true,
      minutosParaCerrar: ultimo - minutos,
      mensaje: `Pedidos hasta las ${horario.ultimoPedido}.`,
      proxima: null,
    };
  }

  const proxima = proximaApertura(dia, minutos, abre);
  const mensaje = abierta
    // Todavía hay feria pero ya no da el tiempo para entregar.
    ? `Ya no alcanzamos a repartir hoy. ${textoProxima(proxima)}`
    : `La feria está cerrada. ${textoProxima(proxima)}`;

  return { abierta, aceptandoPedidos: false, minutosParaCerrar: null, mensaje, proxima };
}

function proximaApertura(dia: number, minutos: number, abre: number) {
  for (let adelanto = 0; adelanto <= 7; adelanto++) {
    const d = (dia + adelanto) % 7;
    if (!horario.dias.includes(d)) continue;
    // Hoy solo cuenta si todavía no abrió.
    if (adelanto === 0 && minutos >= abre) continue;
    return { dia: adelanto === 0 ? 'hoy' : DIAS[d], hora: horario.abre };
  }
  return null;
}

const textoProxima = (p: { dia: string; hora: string } | null): string =>
  p ? `Abrimos ${p.dia === 'hoy' ? 'hoy' : 'el ' + p.dia} a las ${p.hora}.` : '';

/** Lanza si la feria no está tomando pedidos. */
export function verificarHorario(cuando = new Date()): void {
  const e = estadoFeria(cuando);
  if (!e.aceptandoPedidos) throw new FeriaCerrada(e.mensaje);
}
