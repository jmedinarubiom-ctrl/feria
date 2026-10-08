import { consultar, consultarUno, ejecutar, enTransaccion, registrarEvento, type Fila } from '../db/index.ts';
import { ErrorNegocio, EstadoSubPedido, EstadoViaje } from './estados.ts';
import { reembolsarParte } from './cancelacion.ts';
import { publicar } from '../realtime/bus.ts';
import { enviarPush } from '../realtime/push.ts';
import { CONFIG } from '../config.ts';

const clp = (n: number): string => '$' + Math.round(n).toLocaleString('es-CL');

async function avisarAlCliente(pedidoId: string, title: string, body: string): Promise<void> {
  const c = await consultarUno<Fila>(
    `SELECT c.push_token FROM pedidos p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?`, pedidoId);
  if (!c?.push_token) return;
  await enviarPush([{
    to: c.push_token, title, body, sound: 'default', priority: 'high', channelId: 'pedidos',
    data: { tipo: 'pedido', pedidoId },
  }]).catch(() => {});
}

// ============================================================
// Un producto que no había
// ============================================================

/**
 * El puesto no tiene un producto del pedido.
 *
 * Antes era todo o nada: si faltaba la palta, el feriante rechazaba
 * la parte entera o la entregaba incompleta sin que nadie se
 * enterara. Ahora marca lo que no tiene: ese producto no se le paga
 * a él, no se le cobra al cliente —se le devuelve— y el repartidor
 * sabe que esa bolsa va sin eso.
 *
 * Lo puede marcar el feriante que aceptó, o el operador cuando la
 * parte quedó para que la compre él.
 */
export async function marcarFaltante(
  itemId: string, quien: { rol: 'feriante' | 'operador'; id: string },
): Promise<{ devuelto: number; producto: string }> {
  const r = await enTransaccion(async () => {
    const item = await consultarUno<Fila>('SELECT * FROM items WHERE id = ?', itemId);
    if (!item) throw new ErrorNegocio(404, 'Producto no encontrado.');
    const sub = await consultarUno<Fila>(
      'SELECT * FROM sub_pedidos WHERE id = ? FOR UPDATE', item.sub_pedido_id);

    const esSuyo = quien.rol === 'feriante'
      ? sub!.feriante_id === quien.id && sub!.estado === EstadoSubPedido.ACEPTADO
      : sub!.estado === EstadoSubPedido.AUTOGESTION || sub!.estado === EstadoSubPedido.ACEPTADO;
    if (!esSuyo) {
      throw new ErrorNegocio(409, 'Solo se puede marcar un faltante mientras se prepara el pedido.');
    }
    if (item.faltante) return { devuelto: 0, producto: item.nombre, pedidoId: sub!.pedido_id, sub };

    const quedan = await consultarUno<Fila>(
      `SELECT COUNT(*)::int AS n FROM items WHERE sub_pedido_id = ? AND NOT faltante AND id <> ?`,
      sub!.id, itemId);
    if ((quedan?.n ?? 0) === 0) {
      throw new ErrorNegocio(409, quien.rol === 'feriante'
        ? 'Es lo único que te quedaba de este pedido. Si no tienes nada, libéralo para que lo tome otro puesto.'
        : 'Es lo único que quedaba de esta parte. Cancela el pedido o busca el producto en otro puesto.');
    }

    await ejecutar('UPDATE items SET faltante = true WHERE id = ?', itemId);
    await ejecutar(
      'UPDATE sub_pedidos SET monto_feriante = GREATEST(0, monto_feriante - ?) WHERE id = ?',
      item.precio_costo * item.cantidad, sub!.id);
    await registrarEvento('sub_pedido', sub!.id, 'faltante',
      { producto: item.nombre, cantidad: item.cantidad, por: quien.rol });
    publicar({
      tipo: 'subpedido:cambio', subPedidoId: sub!.id, pedidoId: sub!.pedido_id,
      estado: sub!.estado, ferianteId: sub!.feriante_id,
    });
    return { devuelto: item.precio_venta * item.cantidad, producto: item.nombre, pedidoId: sub!.pedido_id, sub };
  });

  if (r.devuelto > 0) {
    // Fuera de la transacción: hablar con la pasarela no puede dejar
    // el pedido con candado.
    await reembolsarParte(r.pedidoId, r.devuelto, `faltó ${r.producto}`);
    await avisarAlCliente(r.pedidoId, `No había ${r.producto.toLowerCase()}`,
      `Tu pedido va sin eso y te devolvemos ${clp(r.devuelto)}.`);
  }
  return { devuelto: r.devuelto, producto: r.producto };
}

// ============================================================
// Compensar después de la entrega
// ============================================================

/**
 * El operador devuelve una parte de lo pagado: la malla pesaba menos,
 * algo llegó golpeado. Queda con su motivo, que es lo que después
 * permite saber qué puesto entrega mal.
 */
export async function compensar(pedidoId: string, montoCrudo: unknown, motivoCrudo: unknown, operadorId: string) {
  const monto = Math.round(Number(montoCrudo));
  const motivo = String(motivoCrudo ?? '').trim().slice(0, 200);
  if (!Number.isFinite(monto) || monto <= 0) throw new ErrorNegocio(422, 'Indica cuánto devolver.');
  if (motivo.length < 4) throw new ErrorNegocio(422, 'Escribe el motivo de la devolución.');
  const pedido = await consultarUno<Fila>('SELECT id, numero, total_venta FROM pedidos WHERE id = ?', pedidoId);
  if (!pedido) throw new ErrorNegocio(404, 'Pedido no encontrado.');
  if (monto > pedido.total_venta) throw new ErrorNegocio(422, 'No se puede devolver más de lo que se pagó.');

  const r = await reembolsarParte(pedidoId, monto, motivo);
  await registrarEvento('pedido', pedidoId, 'compensación', { monto: r.monto, motivo, operadorId });
  if (r.monto > 0) {
    await avisarAlCliente(pedidoId, `Te devolvimos ${clp(r.monto)}`, `Pedido #${pedido.numero}: ${motivo}.`);
  }
  return r;
}

// ============================================================
// Calificación del cliente
// ============================================================

/**
 * El cliente pone de 1 a 5 estrellas a un pedido entregado.
 *
 * La nota se reparte entre los puestos que lo prepararon y el
 * repartidor que lo llevó, y pesa en a quién se le ofrece primero
 * la próxima vez. Una nota baja le llega al operador con el
 * comentario: es el único momento en que el cliente dice qué pasó.
 */
export async function calificar(pedidoId: string, clienteId: string, estrellasCrudas: unknown, comentarioCrudo: unknown) {
  const estrellas = Math.round(Number(estrellasCrudas));
  if (!(estrellas >= 1 && estrellas <= 5)) throw new ErrorNegocio(422, 'La nota va de 1 a 5.');
  const comentario = String(comentarioCrudo ?? '').trim().slice(0, 500) || null;

  return enTransaccion(async () => {
    const pedido = await consultarUno<Fila>(
      'SELECT id, numero, estado, cliente_id FROM pedidos WHERE id = ? FOR UPDATE', pedidoId);
    if (!pedido || pedido.cliente_id !== clienteId) throw new ErrorNegocio(404, 'Pedido no encontrado.');
    if (pedido.estado !== 'ENTREGADO') throw new ErrorNegocio(409, 'Se califica cuando el pedido ya llegó.');

    const puesto = await ejecutar(
      `INSERT INTO calificaciones (pedido_id, estrellas, comentario) VALUES (?, ?, ?)
       ON CONFLICT (pedido_id) DO NOTHING`, pedidoId, estrellas, comentario);
    if (puesto.afectadas !== 1) throw new ErrorNegocio(409, 'Este pedido ya tiene su calificación.');

    await ejecutar(
      `UPDATE feriantes SET estrellas_suma = estrellas_suma + ?, estrellas_n = estrellas_n + 1
        WHERE id IN (SELECT DISTINCT feriante_id FROM sub_pedidos
                      WHERE pedido_id = ? AND feriante_id IS NOT NULL AND estado = ?)`,
      estrellas, pedidoId, EstadoSubPedido.RETIRADO);
    await ejecutar(
      `UPDATE repartidores SET estrellas_suma = estrellas_suma + ?, estrellas_n = estrellas_n + 1
        WHERE id IN (SELECT repartidor_id FROM viajes WHERE pedido_id = ? AND estado = ?)`,
      estrellas, pedidoId, EstadoViaje.ENTREGADO);
    await registrarEvento('pedido', pedidoId, 'calificado', { estrellas });

    return { ok: true, estrellas };
  });
}

// ============================================================
// Un viaje que nadie toma
// ============================================================

const MINUTOS_POR_ESCALON = Number(process.env.VIAJE_ESCALON_MINUTOS ?? 5);
const ALZA_POR_ESCALON = Number(process.env.VIAJE_ALZA ?? 500);
const ESCALONES = Number(process.env.VIAJE_ESCALONES ?? 4);

/**
 * Sube la tarifa de los viajes que llevan rato sin repartidor.
 *
 * Un pedido listo en la feria sin nadie que lo lleve es mercadería
 * que se echa a perder. Cada 5 minutos la tarifa sube $500 (hasta
 * cuatro veces) y se les vuelve a avisar a los repartidores; al
 * operador se le avisa desde el primer escalón.
 */
export async function escalarViajes(): Promise<number> {
  const viajes = await consultar<Fila>(
    `SELECT v.id, v.pedido_id, v.tarifa, COALESCE(v.tarifa_base, v.tarifa) AS base, p.numero,
            (extract(epoch FROM now() - v.creado_at) / 60)::int AS minutos
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.estado = ? AND v.repartidor_id IS NULL
        AND v.creado_at > now() - interval '3 hours'`, EstadoViaje.BUSCANDO);
  let subidos = 0;
  for (const v of viajes) {
    const escalon = Math.min(ESCALONES, Math.floor(v.minutos / MINUTOS_POR_ESCALON));
    const nueva = v.base + escalon * ALZA_POR_ESCALON;
    if (escalon < 1 || nueva <= v.tarifa) continue;
    const r = await ejecutar(
      `UPDATE viajes SET tarifa = ?, tarifa_base = ? WHERE id = ? AND estado = ? AND tarifa < ?`,
      nueva, v.base, v.id, EstadoViaje.BUSCANDO, nueva);
    if (r.afectadas !== 1) continue;
    subidos++;
    await registrarEvento('viaje', v.id, 'sube la tarifa', { de: v.tarifa, a: nueva, minutos: v.minutos });
    // El mismo aviso de «viaje nuevo», ahora con el precio mejorado.
    publicar({ tipo: 'viaje:nuevo', viajeId: v.id, pedidoId: v.pedido_id });
    if (escalon === 1) {
      const ops = await consultar<Fila>('SELECT push_token FROM operadores WHERE push_token IS NOT NULL');
      await enviarPush(ops.map((o) => ({
        to: o.push_token, title: `Pedido #${v.numero} sin repartidor`,
        body: `Lleva ${v.minutos} minutos esperando. Puedes asignarlo a mano desde el panel.`,
        sound: 'default' as const, priority: 'high' as const, channelId: 'autogestion',
      }))).catch(() => {});
    }
  }
  return subidos;
}

/** El operador le entrega el viaje a un repartidor concreto. */
export async function repartidorParaAsignar(repartidorId: unknown): Promise<string> {
  const r = await consultarUno<Fila>(
    'SELECT id FROM repartidores WHERE id = ? AND activo AND NOT pendiente', String(repartidorId ?? ''));
  if (!r) throw new ErrorNegocio(404, 'Ese repartidor no existe o no está activo.');
  return r.id;
}

// ============================================================
// Cuándo llega
// ============================================================

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};

/**
 * Una estimación honesta de cuánto falta, en minutos.
 *
 * No hay datos de tránsito: se calcula con la distancia en línea
 * recta, alargada un 40 % porque las calles no son rectas (y en
 * Valparaíso menos), a 18 km/h, más 4 minutos por cada puesto que
 * falta retirar. Se muestra como «unos N minutos», no como una hora.
 */
export function estimarLlegada(pedido: Fila, viaje: Fila | null, paradasPendientes: number): number | null {
  if (!viaje || ![EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO, EstadoViaje.EN_RUTA].includes(viaje.estado)) return null;
  if (!Number.isFinite(pedido.lat) || !Number.isFinite(pedido.lng)) return null;
  const destino = { lat: pedido.lat, lng: pedido.lng };
  const enRuta = viaje.estado === EstadoViaje.EN_RUTA;
  const desde = enRuta && Number.isFinite(viaje.lat) && Number.isFinite(viaje.lng)
    ? { lat: viaje.lat, lng: viaje.lng }
    : { lat: CONFIG.puntoFeria.lat, lng: CONFIG.puntoFeria.lng };
  const viajeMin = (km(desde, destino) * 1.4 / 18) * 60;
  const retiros = enRuta ? 0 : Math.max(0, paradasPendientes) * 4;
  return Math.max(2, Math.round(viajeMin + retiros + 2));
}

// ============================================================
// Una nota para el repartidor
// ============================================================

/** El cliente agrega o cambia la indicación de entrega mientras el pedido no llega. */
export async function anotarParaElRepartidor(pedidoId: string, clienteId: string, notaCruda: unknown) {
  const nota = String(notaCruda ?? '').trim().slice(0, 300);
  const pedido = await consultarUno<Fila>(
    'SELECT id, numero, estado, cliente_id FROM pedidos WHERE id = ?', pedidoId);
  if (!pedido || pedido.cliente_id !== clienteId) throw new ErrorNegocio(404, 'Pedido no encontrado.');
  if (['ENTREGADO', 'CANCELADO', 'EXPIRADO'].includes(pedido.estado)) {
    throw new ErrorNegocio(409, 'Este pedido ya está cerrado.');
  }
  await ejecutar('UPDATE pedidos SET notas = ? WHERE id = ?', nota || null, pedidoId);
  await registrarEvento('pedido', pedidoId, 'nota del cliente', {});
  const rep = await consultarUno<Fila>(
    `SELECT r.push_token FROM viajes v JOIN repartidores r ON r.id = v.repartidor_id
      WHERE v.pedido_id = ? AND v.estado IN (?, ?, ?)`,
    pedidoId, EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO, EstadoViaje.EN_RUTA);
  if (rep?.push_token && nota) {
    await enviarPush([{
      to: rep.push_token, title: `Nota del cliente · pedido #${pedido.numero}`, body: nota,
      sound: 'default', priority: 'high', channelId: 'viajes',
    }]).catch(() => {});
  }
  return { ok: true, notas: nota || null };
}

// ============================================================
// Pagos de días anteriores que el feriante no confirmó
// ============================================================

export const pagosPorConfirmar = (ferianteId: string) => consultar<Fila>(
  `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, monto_total AS monto, pagado_at
     FROM liquidaciones
    WHERE feriante_id = ? AND pagado_at IS NOT NULL AND confirmado_at IS NULL
      AND fecha > CURRENT_DATE - 30
    ORDER BY fecha DESC`, ferianteId);
