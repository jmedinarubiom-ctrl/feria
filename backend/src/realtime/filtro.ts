import type { Mensaje } from './bus.ts';

export type Suscripcion = { rol: string; id: string };

/**
 * Decide si un aviso le corresponde a una conexión.
 *
 * Cada mensaje va solo a quien tiene algo que hacer con él. Sin este
 * filtro el celular de cada feriante recibiría los movimientos de
 * los otros ocho puestos: gasta datos, gasta batería y le muestra
 * negocio ajeno.
 */
export function leRegistra(s: Suscripcion, m: Mensaje): boolean {
  switch (m.tipo) {
    case 'oferta:nueva':
    case 'oferta:cerrada':
      return s.rol === 'feriante' && s.id === m.ferianteId;

    case 'autogestion:nueva':
      return s.rol === 'operador';

    case 'viaje:nuevo':
      return s.rol === 'repartidor' || s.rol === 'operador';

    case 'viaje:cambio':
      return s.rol === 'operador'
        || (s.rol === 'repartidor' && (!m.repartidorId || s.id === m.repartidorId));

    case 'subpedido:cambio':
      return s.rol === 'operador'
        || (s.rol === 'feriante' && !!m.ferianteId && s.id === m.ferianteId)
        || (s.rol === 'cliente' && s.id === m.pedidoId);

    case 'pedido:cambio':
    case 'pedido:cancelado':
      return s.rol === 'operador' || (s.rol === 'cliente' && s.id === m.pedidoId);

    case 'ubicacion':
      // Solo al cliente de ESE pedido. Antes iba a todos, y cada
      // teléfono con un seguimiento abierto recargaba su pantalla
      // con cada punto de GPS de cualquier repartidor.
      return s.rol === 'operador' || (s.rol === 'cliente' && s.id === m.pedidoId);

    default:
      return false;
  }
}
