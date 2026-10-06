// La función no abre WebSockets: la app consulta cada pocos segundos.
export class WebSocketServer {
  constructor() { throw new Error('Sin WebSocket en la función.'); }
}
export type WebSocket = never;
