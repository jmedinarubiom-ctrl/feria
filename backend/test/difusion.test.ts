import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leRegistra, type Suscripcion } from '../src/realtime/filtro.ts';
import { temasDe } from '../src/realtime/difusion.ts';
import type { Mensaje } from '../src/realtime/bus.ts';

/** Los temas que escucha cada quien, como los arma `comoEscuchar`. */
const temasQueEscucha = (s: Suscripcion): string[] =>
  s.rol === 'operador' ? ['op']
    : s.rol === 'feriante' ? [`f:${s.id}`]
    : s.rol === 'repartidor' ? [`r:${s.id}`, 'rs']
    : [`p:${s.id}`];

const GENTE: Suscripcion[] = [
  { rol: 'operador', id: 'op-1' },
  { rol: 'feriante', id: 'f-jose' }, { rol: 'feriante', id: 'f-otro' },
  { rol: 'repartidor', id: 'r-diego' }, { rol: 'repartidor', id: 'r-sofia' },
  { rol: 'cliente', id: 'ped-1' }, { rol: 'cliente', id: 'ped-2' },
];

const MENSAJES: Mensaje[] = [
  { tipo: 'oferta:nueva', ferianteId: 'f-jose', subPedidoId: 's1', expiraAt: '' },
  { tipo: 'oferta:cerrada', ferianteId: 'f-jose', subPedidoId: 's1', motivo: '' },
  { tipo: 'subpedido:cambio', subPedidoId: 's1', pedidoId: 'ped-1', estado: 'ACEPTADO', ferianteId: 'f-jose' },
  { tipo: 'subpedido:cambio', subPedidoId: 's1', pedidoId: 'ped-1', estado: 'OFRECIDO' },
  { tipo: 'pedido:cambio', pedidoId: 'ped-1', estado: 'PAGADO' },
  { tipo: 'viaje:nuevo', viajeId: 'v1', pedidoId: 'ped-1' },
  { tipo: 'viaje:cambio', viajeId: 'v1', estado: 'TOMADO', repartidorId: 'r-diego' },
  { tipo: 'viaje:cambio', viajeId: 'v1', estado: 'LIBRE' },
  { tipo: 'autogestion:nueva', subPedidoId: 's1', pedidoId: 'ped-1' },
  { tipo: 'ubicacion', viajeId: 'v1', pedidoId: 'ped-1', lat: 0, lng: 0 },
  { tipo: 'pedido:cancelado', pedidoId: 'ped-1', numero: 1, ferianteIds: ['f-jose'] },
];

test('el canal en vivo le avisa exactamente a quien le avisaba el WebSocket', () => {
  for (const m of MENSAJES) {
    const temas = temasDe(m);
    for (const s of GENTE) {
      const porCanal = temasQueEscucha(s).some((t) => temas.includes(t));
      assert.equal(porCanal, leRegistra(s, m),
        `${m.tipo} → ${s.rol} ${s.id}: canal ${porCanal}, WebSocket ${leRegistra(s, m)}`);
    }
  }
});
