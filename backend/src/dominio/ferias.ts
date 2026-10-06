import { consultar, consultarUno, ejecutar, registrarEvento, type Fila } from '../db/index.ts';
import { ErrorNegocio } from './estados.ts';
import { estadoFeria, horarioDeFeria } from './horario.ts';
import { geocodificar } from './geocodificar.ts';

/**
 * Las ferias desde las que se reparte, o se podría repartir.
 *
 * Una feria «activa» recibe pedidos. Las demás están en la lista
 * —el cliente las ve como «próximamente»— hasta que el operador
 * tiene feriantes cargados ahí y la enciende.
 */

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** El centro de cada comuna, para abrir el mapa cuando no hay nada mejor. */
const CENTROS: Record<string, { lat: number; lng: number }> = {
  'Valparaíso': { lat: -33.0472, lng: -71.6127 },
  'Viña del Mar': { lat: -33.0245, lng: -71.5518 },
  'Quilpué': { lat: -33.0475, lng: -71.4425 },
  'Villa Alemana': { lat: -33.0422, lng: -71.3733 },
};

/**
 * Dónde abrir el mapa para que el cliente elija su punto.
 *
 * Si la dirección que escribió se encuentra, ahí: le queda mover el
 * pin unos metros en vez de buscar su calle desde el centro de la
 * ciudad. Si no, el centro de la comuna de su feria. Es solo el
 * punto de partida del mapa: el que vale es el que él confirme.
 */
export async function dondeAbrirElMapa(direccion: unknown, feriaId: unknown) {
  const feria = await feriaPorId(feriaId);
  const comuna = feria?.comuna ?? 'Valparaíso';
  const texto = typeof direccion === 'string' ? direccion.trim().slice(0, 200) : '';
  const hallado = texto ? await geocodificar(texto, { ciudad: `${comuna}, Chile` }) : null;
  if (hallado) return { lat: hallado.lat, lng: hallado.lng, encontrada: true };
  return { ...(CENTROS[comuna] ?? CENTROS['Valparaíso']), encontrada: false };
}

/** La feria tal como la ve la app, con si está tomando pedidos ahora. */
const paraLaApp = (f: Fila) => ({
  id: f.id,
  nombre: f.nombre,
  comuna: f.comuna,
  calle: f.calle,
  activa: f.activa,
  horario: { dias: f.dias, abre: f.abre, ultimoPedido: f.ultimo_pedido, cierra: f.cierra },
  ...estadoFeria(new Date(), horarioDeFeria(f)),
});

export async function listarFerias() {
  const filas = await consultar<Fila>('SELECT * FROM ferias ORDER BY activa DESC, comuna, nombre');
  return filas.map(paraLaApp);
}

export async function feriaPorId(id: unknown): Promise<Fila | undefined> {
  if (typeof id !== 'string' || !id) return undefined;
  return consultarUno<Fila>('SELECT * FROM ferias WHERE id = ?', id);
}

export async function vistaDeFeria(id: unknown) {
  const f = await feriaPorId(id);
  if (!f) throw new ErrorNegocio(404, 'No conocemos esa feria.');
  return paraLaApp(f);
}

/** Para el panel: cada feria con cuánta gente tiene cargada. */
export async function feriasConGente() {
  const filas = await consultar<Fila>(
    `SELECT fe.*,
            (SELECT COUNT(*)::int FROM feriantes f
              WHERE f.feria_id = fe.id AND f.activo) AS feriantes
       FROM ferias fe ORDER BY fe.activa DESC, fe.comuna, fe.nombre`);
  return filas.map((f) => ({ ...paraLaApp(f), feriantes: f.feriantes, fuente: f.fuente }));
}

export type CambioFeria = {
  activa?: boolean; dias?: number[]; abre?: string; ultimoPedido?: string; cierra?: string;
};

export async function actualizarFeria(id: string, cambio: CambioFeria) {
  const actual = await feriaPorId(id);
  if (!actual) throw new ErrorNegocio(404, 'No conocemos esa feria.');

  const hora = (v: unknown, previa: string, campo: string): string => {
    if (v === undefined) return previa;
    if (typeof v !== 'string' || !HORA.test(v)) {
      throw new ErrorNegocio(422, `${campo} tiene que ser una hora como 07:30.`);
    }
    return v;
  };
  const abre = hora(cambio.abre, actual.abre, 'La apertura');
  const ultimo = hora(cambio.ultimoPedido, actual.ultimo_pedido, 'El último pedido');
  const cierra = hora(cambio.cierra, actual.cierra, 'El cierre');
  // Las horas son texto 'HH:MM': se comparan bien como texto.
  if (!(abre < ultimo && ultimo <= cierra)) {
    throw new ErrorNegocio(422,
      'El último pedido tiene que ser después de abrir y no después de cerrar.');
  }

  let dias: number[] = actual.dias;
  if (cambio.dias !== undefined) {
    dias = Array.isArray(cambio.dias) ? [...new Set(cambio.dias.map(Number))].sort() : [];
    if (dias.length === 0 || dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new ErrorNegocio(422, 'Elige al menos un día de feria.');
    }
  }

  const activa = cambio.activa ?? actual.activa;
  if (activa && !actual.activa) {
    // Encender una feria sin nadie que venda en ella manda cada
    // pedido derecho a la cola del operador.
    const n = await consultarUno<Fila>(
      'SELECT COUNT(*)::int AS n FROM feriantes WHERE feria_id = ? AND activo', id);
    if ((n?.n ?? 0) === 0) {
      throw new ErrorNegocio(409,
        'Esa feria no tiene feriantes cargados. Agrega al menos uno antes de abrirla.');
    }
  }

  await ejecutar(
    `UPDATE ferias SET activa = ?, dias = ?, abre = ?, ultimo_pedido = ?, cierra = ? WHERE id = ?`,
    activa, dias, abre, ultimo, cierra, id);
  if (activa !== actual.activa) {
    await registrarEvento('feria', id, activa ? 'abierta a pedidos' : 'cerrada a pedidos');
  }
  return paraLaApp((await feriaPorId(id))!);
}
