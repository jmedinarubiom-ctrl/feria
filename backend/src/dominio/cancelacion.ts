import {
  ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila,
} from '../db/index.ts';
import { EstadoPedido, EstadoSubPedido, EstadoViaje } from './estados.ts';
import { publicar } from '../realtime/bus.ts';
import { pasarela } from './pagos.ts';

export class ErrorCancelacion extends Error {
  codigo: number;
  constructor(codigo: number, msg: string) {
    super(msg);
    this.codigo = codigo;
    this.name = 'ErrorCancelacion';
  }
}

/** Un pedido entregado ya no se cancela: eso es un reclamo, otra cosa. */
const YA_TERMINADO = new Set<string>([
  EstadoPedido.ENTREGADO,
  EstadoPedido.CANCELADO,
  EstadoPedido.EXPIRADO,
]);

export type Cancelacion = {
  pedidoId: string;
  motivo: string;
  /** Cuánto devolverle. Si falta, se devuelve todo lo cobrado. */
  montoReembolso?: number;
};

export type ResultadoCancelacion = {
  pedidoId: string;
  numero: number;
  reembolso: { monto: number; solicitado: boolean; motivo?: string };
  /** Lo que hay que pagarle igual a los feriantes que ya habían aceptado. */
  compensaciones: Array<{ ferianteId: string; nombre: string; monto: number }>;
};

/**
 * Cancela un pedido: cierra las ofertas, libera a los feriantes,
 * anula el viaje y pide el reembolso.
 *
 * SOLO el operador cancela. El cliente que se arrepiente llama por
 * teléfono: del otro lado hay gente que ya se movió —un feriante
 * apartando mercadería, un repartidor en camino— y esa decisión
 * necesita a alguien que sepa en qué estado está el pedido, no un
 * botón.
 *
 * A los feriantes que ya habían aceptado se les paga igual. Apartaron
 * la mercadería de buena fe y no tienen culpa de que el pedido se
 * cayera; cobrarles el error sería la forma más rápida de que dejen
 * de contestar el teléfono.
 */
export async function cancelarPedido(datos: Cancelacion): Promise<ResultadoCancelacion> {
  const resultado = await enTransaccion(async () => {
    const pedido = await consultarUno<Fila>(
      'SELECT * FROM pedidos WHERE id = ?', datos.pedidoId);
    if (!pedido) throw new ErrorCancelacion(404, 'Pedido no encontrado.');

    if (YA_TERMINADO.has(pedido.estado)) {
      throw new ErrorCancelacion(409,
        pedido.estado === EstadoPedido.ENTREGADO
          ? 'El pedido ya se entregó. Eso se resuelve como reclamo, no como cancelación.'
          : `El pedido ya está ${pedido.estado.toLowerCase()}.`);
    }

    const motivo = String(datos.motivo ?? '').trim() || 'sin motivo';

    // Los que ya habían aceptado cobran igual.
    const subs = await consultar<Fila>(
      `SELECT s.*, f.nombre AS feriante_nombre
         FROM sub_pedidos s LEFT JOIN feriantes f ON f.id = s.feriante_id
        WHERE s.pedido_id = ? AND s.estado <> ?`,
      datos.pedidoId, EstadoSubPedido.CANCELADO);

    const compensaciones: ResultadoCancelacion['compensaciones'] = [];
    const ferianteIds: string[] = [];

    for (const s of subs) {
      const habiaAceptado = s.feriante_id
        && [EstadoSubPedido.ACEPTADO, EstadoSubPedido.LISTO].includes(s.estado);

      await ejecutar(
        'UPDATE sub_pedidos SET estado = ?, compensado = ? WHERE id = ?',
        EstadoSubPedido.CANCELADO, !!habiaAceptado, s.id);

      if (habiaAceptado) {
        compensaciones.push({
          ferianteId: s.feriante_id,
          nombre: s.feriante_nombre,
          monto: s.monto_feriante,
        });
        ferianteIds.push(s.feriante_id);
      }
      publicar({
        tipo: 'subpedido:cambio', subPedidoId: s.id,
        pedidoId: datos.pedidoId, estado: EstadoSubPedido.CANCELADO,
        ferianteId: s.feriante_id,
      });
    }

    // Las ofertas abiertas se cierran sin castigar a nadie: los
    // feriantes que no alcanzaron a contestar no hicieron nada mal.
    const abiertas = await consultar<Fila>(
      `SELECT o.id, o.feriante_id FROM ofertas o
         JOIN sub_pedidos s ON s.id = o.sub_pedido_id
        WHERE s.pedido_id = ? AND o.respuesta IS NULL`,
      datos.pedidoId);
    for (const o of abiertas) {
      await ejecutar(
        'UPDATE ofertas SET respuesta = ?, respondida_at = ? WHERE id = ?',
        'CERRADA', ahora(), o.id);
      publicar({
        tipo: 'oferta:cerrada', ferianteId: o.feriante_id,
        subPedidoId: '', motivo: 'el pedido se canceló',
      });
    }

    const viaje = await consultarUno<Fila>(
      'SELECT * FROM viajes WHERE pedido_id = ? AND estado <> ?',
      datos.pedidoId, EstadoViaje.CANCELADO);
    if (viaje) {
      await ejecutar('UPDATE viajes SET estado = ? WHERE id = ?',
        EstadoViaje.CANCELADO, viaje.id);
      await registrarEvento('viaje', viaje.id, '-> CANCELADO', { motivo });
      publicar({ tipo: 'viaje:cambio', viajeId: viaje.id, estado: EstadoViaje.CANCELADO });
    }

    await ejecutar('UPDATE pedidos SET estado = ? WHERE id = ?',
      EstadoPedido.CANCELADO, datos.pedidoId);
    await registrarEvento('pedido', datos.pedidoId, '-> CANCELADO', {
      motivo,
      compensaciones: compensaciones.reduce((a, c) => a + c.monto, 0),
    });
    publicar({ tipo: 'pedido:cambio', pedidoId: datos.pedidoId, estado: EstadoPedido.CANCELADO });
    publicar({
      tipo: 'pedido:cancelado', pedidoId: datos.pedidoId,
      numero: pedido.numero, ferianteIds,
    });

    return { pedido, compensaciones };
  });

  // El reembolso sale FUERA de la transacción: es una llamada a un
  // servicio externo, y no puede tener la base bloqueada esperándola.
  const reembolso = await pedirReembolso(
    resultado.pedido, datos.montoReembolso, datos.motivo);

  return {
    pedidoId: datos.pedidoId,
    numero: resultado.pedido.numero,
    reembolso,
    compensaciones: resultado.compensaciones,
  };
}

async function pedirReembolso(pedido: Fila, monto: number | undefined, motivo: string) {
  const pago = await consultarUno<Fila>(
    `SELECT * FROM pagos WHERE pedido_id = ? AND estado = 'PAGADO'`, pedido.id);

  // Nunca se cobró: no hay nada que devolver.
  if (!pago) return { monto: 0, solicitado: false, motivo: 'el pedido nunca se pagó' };

  const aDevolver = Math.min(
    monto === undefined ? pago.monto : Math.round(monto),
    pago.monto - pago.monto_reembolsado);
  if (aDevolver <= 0) {
    return { monto: 0, solicitado: false, motivo: 'ya estaba reembolsado' };
  }

  const via = pasarela();
  // La pasarela que cobró tiene que ser la que devuelve: un pago
  // hecho con Flow no se reembolsa desde Mercado Pago, y si el
  // proveedor cambió en el medio hay que resolverlo a mano.
  if (!via || pago.proveedor !== via.nombre) {
    // Sin pasarela real (desarrollo) se anota igual, para que la
    // contabilidad del día cuadre.
    await ejecutar(
      'UPDATE pagos SET monto_reembolsado = ?, reembolsado_at = ? WHERE id = ?',
      aDevolver, ahora(), pago.id);
    await registrarEvento('pago', pago.id, 'reembolso anotado (sin pasarela)',
      { monto: aDevolver, motivo });
    return { monto: aDevolver, solicitado: true, motivo: 'anotado sin pasarela' };
  }

  try {
    const r = await via.reembolsar({
      ordenReembolso: `rf-${pago.orden_comercio}-${id().slice(0, 6)}`,
      referenciaPago: pago.referencia_externa ?? '',
      ordenComercioOriginal: pago.orden_comercio,
      emailCliente: pedido.cliente_email || 'sin@correo.cl',
      monto: aDevolver,
    });
    if (!r.aceptado) throw new Error(`${via.nombre} rechazó el reembolso.`);

    await ejecutar(
      'UPDATE pagos SET monto_reembolsado = ?, reembolsado_at = ? WHERE id = ?',
      aDevolver, ahora(), pago.id);
    await registrarEvento('pago', pago.id, 'reembolso solicitado',
      { monto: aDevolver, referencia: r.referencia, pasarela: via.nombre, motivo });
    return { monto: aDevolver, solicitado: true };
  } catch (e) {
    // La cancelación ya ocurrió; el reembolso se reintenta a mano.
    // Que falle la devolución no puede dejar a ocho feriantes
    // preparando un pedido cancelado.
    await registrarEvento('pago', pago.id, 'reembolso falló',
      { monto: aDevolver, error: String(e), motivo });
    return { monto: aDevolver, solicitado: false, motivo: String(e) };
  }
}

/** Reembolsos que quedaron pendientes y hay que resolver a mano. */
export async function reembolsosPendientes() {
  return consultar(
    `SELECT p.numero, p.cliente_nombre, p.cliente_telefono,
            g.id AS pago_id, g.monto, g.orden_comercio
       FROM pagos g JOIN pedidos p ON p.id = g.pedido_id
      WHERE g.estado = 'PAGADO'
        AND g.monto_reembolsado = 0
        AND p.estado = 'CANCELADO'
      ORDER BY p.numero`);
}
