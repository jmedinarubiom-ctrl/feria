/**
 * Texto del horario de la feria.
 *
 * El servidor manda el horario como datos (`{ dias, abre, cierra }`)
 * y no como frase hecha, así que armarla es trabajo de la app.
 */

export type Horario = {
  dias: number[];
  abre: string;
  ultimoPedido: string;
  cierra: string;
};

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function diasTexto(dias: number[] | undefined): string {
  if (!dias || dias.length === 0) return '—';
  if (dias.length === 7) return 'Todos los días';
  const nombres = [...dias].sort((a, b) => a - b).map((d) => DIAS[d] ?? '?');
  if (nombres.length === 1) return mayus(nombres[0]);
  return mayus(nombres.slice(0, -1).join(', ')) + ' y ' + nombres[nombres.length - 1];
}

export function textoHorario(h: Horario | undefined): string {
  if (!h) return '—';
  return `${diasTexto(h.dias)}, ${h.abre} a ${h.cierra}`;
}

export const textoUltimoPedido = (h: Horario | undefined): string =>
  h ? `Último pedido del día: ${h.ultimoPedido}` : '—';

const mayus = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
