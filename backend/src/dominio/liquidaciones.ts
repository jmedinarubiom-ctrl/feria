import { ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila } from '../db/index.ts';
import { EstadoSubPedido } from './estados.ts';
import { CONFIG } from '../config.ts';

/**
 * El día de la feria es el día en Chile, no en UTC.
 *
 * Un retiro a las 21:00 en Valparaíso ocurre al día siguiente en
 * UTC. Sin esta conversión, esas bolsas se caen de la liquidación
 * de la tarde y aparecen en la del día siguiente — que es
 * exactamente la discusión que la app tiene que evitar.
 */
const DIA_LOCAL = `(%s AT TIME ZONE '${CONFIG.zonaHoraria}')::date`;
const diaDe = (columna: string) => DIA_LOCAL.replace('%s', columna);

export const hoy = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.zonaHoraria, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

/**
 * Cuánto se le debe a un feriante en una fecha.
 *
 * Se cuenta el sub-pedido desde que el repartidor lo retira, no
 * desde que el feriante lo acepta: si aceptó y no lo entregó, no
 * hay nada que pagar. Es la regla que evita la discusión de las
 * seis de la tarde.
 */
export async function calcularLiquidacion(ferianteId: string, fecha = hoy()) {
  // Se paga lo entregado y también lo que quedó compensado: un
  // pedido cancelado después de que el feriante apartó la mercadería
  // se le paga igual.
  const subs = await consultar<Fila>(
    `SELECT s.id, s.monto_feriante, s.compensado, p.numero,
            COALESCE(s.retirado_at, s.aceptado_at) AS momento
       FROM sub_pedidos s
       JOIN pedidos p ON p.id = s.pedido_id
      WHERE s.feriante_id = ?
        AND (s.estado = ? OR s.compensado)
        AND ${diaDe('COALESCE(s.retirado_at, s.aceptado_at)')} = ?::date
      ORDER BY momento`,
    ferianteId, EstadoSubPedido.RETIRADO, fecha);

  const total = subs.reduce((acc, s) => acc + s.monto_feriante, 0);
  const registro = await consultarUno<Fila>(
    'SELECT * FROM liquidaciones WHERE feriante_id = ? AND fecha = ?::date', ferianteId, fecha);

  // Lo ganado y lo entregado son cosas distintas: si se le paga a
  // media tarde y después toma dos pedidos más, decir que ya cobró
  // todo es una discusión asegurada a la hora de cerrar.
  const pagado = registro?.pagado_at ? registro.monto_total : 0;

  return {
    ferianteId,
    fecha,
    total,
    pagado,
    pendiente: Math.max(0, total - pagado),
    cantidad: subs.length,
    subPedidos: subs,
    pagadoAt: registro?.pagado_at ?? null,
    confirmadoAt: registro?.confirmado_at ?? null,
  };
}

/** Resumen del día para el operador: a quién le tiene que pagar y cuánto. */
export async function liquidacionesDelDia(fecha = hoy()) {
  const filas = await consultar<Fila>(
    `SELECT f.id, f.nombre, f.puesto, f.telefono,
            COUNT(s.id)::int                                  AS cantidad,
            SUM(s.monto_feriante)::int                        AS total,
            COUNT(*) FILTER (WHERE s.compensado)::int          AS compensados,
            l.pagado_at, l.confirmado_at, l.monto_total AS monto_pagado
       FROM sub_pedidos s
       JOIN feriantes f ON f.id = s.feriante_id
       LEFT JOIN liquidaciones l ON l.feriante_id = f.id AND l.fecha = ?::date
      WHERE (s.estado = ? OR s.compensado)
        AND ${diaDe('COALESCE(s.retirado_at, s.aceptado_at)')} = ?::date
      GROUP BY f.id, l.pagado_at, l.confirmado_at, l.monto_total
      ORDER BY total DESC`,
    fecha, EstadoSubPedido.RETIRADO, fecha);

  const conPendiente = filas.map((f) => ({
    ...f,
    pagado: f.pagado_at ? f.monto_pagado ?? 0 : 0,
    pendiente: Math.max(0, f.total - (f.pagado_at ? f.monto_pagado ?? 0 : 0)),
  }));

  return {
    fecha,
    totalAPagar: conPendiente.reduce((a, f) => a + f.pendiente, 0),
    totalDelDia: conPendiente.reduce((a, f) => a + f.total, 0),
    feriantes: conPendiente,
  };
}

/** El operador marca que pagó en efectivo. */
export async function marcarPagado(ferianteId: string, fecha = hoy()) {
  return enTransaccion(async () => {
    const calc = await calcularLiquidacion(ferianteId, fecha);
    if (calc.cantidad === 0) throw new Error('No hay nada que pagar a este feriante en esa fecha.');

    const existente = await consultarUno<Fila>(
      'SELECT * FROM liquidaciones WHERE feriante_id = ? AND fecha = ?::date', ferianteId, fecha);
    // Ya se le entregó todo lo que había: no hay nada nuevo que pagar.
    if (existente?.pagado_at && calc.pendiente === 0) {
      return calcularLiquidacion(ferianteId, fecha);
    }

    if (existente) {
      // Se le paga la diferencia, y tiene que volver a confirmar:
      // confirmó haber recibido otra cantidad.
      await ejecutar(
        `UPDATE liquidaciones SET monto_total = ?, cantidad_sub_pedidos = ?, pagado_at = ?,
                confirmado_at = NULL
          WHERE id = ?`,
        calc.total, calc.cantidad, ahora(), existente.id);
    } else {
      await ejecutar(
        `INSERT INTO liquidaciones (id, feriante_id, fecha, monto_total,
           cantidad_sub_pedidos, pagado_at)
         VALUES (?, ?, ?::date, ?, ?, ?)`,
        id(), ferianteId, fecha, calc.total, calc.cantidad, ahora());
    }
    await registrarEvento('liquidacion', ferianteId, 'pagado',
      { fecha, total: calc.total, entregado: calc.pendiente });
    return calcularLiquidacion(ferianteId, fecha);
  });
}

/**
 * El feriante confirma en su app que recibió la plata. Sin esta
 * doble marca, un descuadre queda en la palabra de uno contra la
 * del otro.
 */
export async function confirmarRecepcion(ferianteId: string, fecha = hoy()) {
  const registro = await consultarUno<Fila>(
    'SELECT * FROM liquidaciones WHERE feriante_id = ? AND fecha = ?::date', ferianteId, fecha);
  if (!registro?.pagado_at) throw new Error('Todavía no está marcado como pagado.');

  await ejecutar('UPDATE liquidaciones SET confirmado_at = ? WHERE id = ?', ahora(), registro.id);
  await registrarEvento('liquidacion', ferianteId, 'confirmado', { fecha });
  return calcularLiquidacion(ferianteId, fecha);
}
