import { EventEmitter } from 'node:events';
import { alConfirmar } from '../db/index.ts';

/**
 * Bus interno. El motor de despacho publica acá y el servidor
 * WebSocket reenvía a las apps. Mantenerlo desacoplado permite
 * testear el despacho sin levantar red.
 */
export type Mensaje =
  | { tipo: 'oferta:nueva'; ferianteId: string; subPedidoId: string; expiraAt: string }
  | { tipo: 'oferta:cerrada'; ferianteId: string; subPedidoId: string; motivo: string }
  | {
      tipo: 'subpedido:cambio'; subPedidoId: string; pedidoId: string; estado: string;
      /** Quién lo tiene. Sin esto el aviso va a los ocho puestos. */
      ferianteId?: string | null;
    }
  | { tipo: 'pedido:cambio'; pedidoId: string; estado: string }
  | { tipo: 'viaje:nuevo'; viajeId: string; pedidoId: string }
  | { tipo: 'viaje:cambio'; viajeId: string; estado: string; repartidorId?: string }
  | { tipo: 'autogestion:nueva'; subPedidoId: string; pedidoId: string }
  | { tipo: 'ubicacion'; viajeId: string; pedidoId: string; lat: number; lng: number }
  | { tipo: 'pedido:cancelado'; pedidoId: string; numero: number; ferianteIds: string[] };

export const bus = new EventEmitter<{ mensaje: [Mensaje] }>();

/**
 * Publica un aviso. Dentro de una transacción queda en espera hasta
 * el COMMIT: avisar antes haría que la app pidiera datos que otra
 * conexión todavía no ve.
 */
export const publicar = (m: Mensaje): void => {
  alConfirmar(() => bus.emit('mensaje', m));
};
