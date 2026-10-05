import { consultar, consultarUno, type Fila } from '../db/index.ts';
import { EstadoSubPedido, EstadoViaje } from './estados.ts';
import { CONFIG } from '../config.ts';
import { hoy } from './liquidaciones.ts';

const diaDe = (col: string) => `(${col} AT TIME ZONE '${CONFIG.zonaHoraria}')::date`;

const items = (subPedidoId: string) =>
  consultar('SELECT * FROM items WHERE sub_pedido_id = ?', subPedidoId);

/** Adjunta los items a cada fila que tenga un sub-pedido. */
async function conItems(filas: Fila[], clave = 'id'): Promise<Fila[]> {
  return Promise.all(filas.map(async (f) => ({ ...f, items: await items(f[clave]) })));
}

/** Lo que ve el feriante cuando le suena el teléfono. */
export async function ofertasAbiertas(ferianteId: string) {
  const filas = await consultar<Fila>(
    `SELECT o.id AS oferta_id, o.expira_at, o.ronda,
            s.id AS sub_pedido_id, s.monto_feriante, s.rubro_id,
            p.numero, p.notas, r.nombre AS rubro
       FROM ofertas o
       JOIN sub_pedidos s ON s.id = o.sub_pedido_id
       JOIN pedidos p     ON p.id = s.pedido_id
       JOIN rubros r      ON r.id = s.rubro_id
      WHERE o.feriante_id = ?
        AND o.respuesta IS NULL
        AND s.estado = ?
      ORDER BY o.expira_at`,
    ferianteId, EstadoSubPedido.OFERTANDO);

  return conItems(filas, 'sub_pedido_id');
}

/** Sub-pedidos que el feriante ya tomó y todavía tiene que preparar. */
export async function trabajoDelFeriante(ferianteId: string) {
  const filas = await consultar<Fila>(
    `SELECT s.*, p.numero, r.nombre AS rubro
       FROM sub_pedidos s
       JOIN pedidos p ON p.id = s.pedido_id
       JOIN rubros r  ON r.id = s.rubro_id
      WHERE s.feriante_id = ? AND s.estado IN (?, ?)
      ORDER BY s.aceptado_at`,
    ferianteId, EstadoSubPedido.ACEPTADO, EstadoSubPedido.LISTO);

  return conItems(filas);
}

/** Viajes que puede tomar un repartidor, con sus paradas. */
export async function viajesDisponibles(feriaId?: string) {
  const filas = await consultar<Fila>(
    `SELECT v.*, p.numero, p.direccion, p.feria_id,
            (SELECT COUNT(*)::int FROM paradas
              WHERE viaje_id = v.id AND tipo = 'RETIRO') AS retiros
       FROM viajes v
       JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.estado = ? ${feriaId ? 'AND p.feria_id = ?' : ''}
      ORDER BY v.creado_at`,
    ...(feriaId ? [EstadoViaje.BUSCANDO, feriaId] : [EstadoViaje.BUSCANDO]));

  return Promise.all(filas.map(async (v) => ({
    ...v,
    paradas: await consultar('SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', v.id),
  })));
}

export async function viajeActivo(repartidorId: string) {
  const viaje = await consultarUno<Fila>(
    `SELECT v.*, p.numero, p.cliente_nombre, p.cliente_telefono, p.direccion, p.notas
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.repartidor_id = ? AND v.estado IN (?, ?, ?)`,
    repartidorId, EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO, EstadoViaje.EN_RUTA);
  if (!viaje) return null;

  const paradas = await consultar<Fila>(
    'SELECT * FROM paradas WHERE viaje_id = ? ORDER BY orden', viaje.id);
  return {
    ...viaje,
    paradas: await Promise.all(paradas.map(async (p) => ({
      ...p,
      items: p.sub_pedido_id ? await itemsDeLaParada(viaje.pedido_id, p.sub_pedido_id) : [],
    }))),
  };
}

/**
 * Una parada puede cubrir varios sub-pedidos del mismo puesto, así
 * que el repartidor tiene que ver todo lo que retira ahí junto.
 */
async function itemsDeLaParada(pedidoId: string, subPedidoRef: string) {
  const ref = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', subPedidoRef);
  if (!ref) return [];
  // Lo que no tiene dueño todavía (ofertándose) o se canceló no se
  // retira en esta parada.
  const vivos = `estado NOT IN ('PENDIENTE', 'OFERTANDO', 'CANCELADO')`;
  const hermanos = ref.feriante_id
    ? await consultar<Fila>(
        `SELECT id FROM sub_pedidos WHERE pedido_id = ? AND feriante_id = ? AND ${vivos}`,
        pedidoId, ref.feriante_id)
    : await consultar<Fila>(
        `SELECT id FROM sub_pedidos WHERE pedido_id = ? AND feriante_id IS NULL AND ${vivos}`,
        pedidoId);
  const listas = await Promise.all(hermanos.map((s) => items(s.id)));
  return listas.flat();
}

/** Vista completa de un pedido: la usan el cliente y el panel del operador. */
export async function pedidoCompleto(pedidoId: string) {
  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  if (!pedido) return null;

  const subs = await consultar<Fila>(
    `SELECT s.*, r.nombre AS rubro, f.nombre AS feriante_nombre, f.puesto
       FROM sub_pedidos s
       JOIN rubros r ON r.id = s.rubro_id
       LEFT JOIN feriantes f ON f.id = s.feriante_id
      WHERE s.pedido_id = ?`,
    pedidoId);

  const viaje = await consultarUno<Fila>(
    `SELECT v.*, rp.nombre AS repartidor_nombre, rp.lat, rp.lng, rp.vehiculo
       FROM viajes v LEFT JOIN repartidores rp ON rp.id = v.repartidor_id
      WHERE v.pedido_id = ? AND v.estado <> ?`,
    pedidoId, EstadoViaje.CANCELADO);

  return { ...pedido, subPedidos: await conItems(subs), viaje: viaje ?? null };
}

/** La cola del operador: todo lo que nadie aceptó y hay que ir a comprar. */
export async function colaAutogestion() {
  const filas = await consultar<Fila>(
    `SELECT s.*, p.numero, p.direccion, r.nombre AS rubro
       FROM sub_pedidos s
       JOIN pedidos p ON p.id = s.pedido_id
       JOIN rubros r  ON r.id = s.rubro_id
      WHERE s.estado = ?
      ORDER BY s.creado_at`,
    EstadoSubPedido.AUTOGESTION);

  return conItems(filas);
}

/**
 * Salud del despacho. La tasa de aceptación es el número que decide
 * si el negocio funciona: si es baja, el operador termina haciendo
 * todos los pedidos a mano y no hay plataforma que valga.
 */
export async function metricas(fecha = hoy()) {
  const o = await consultarUno<Fila>(
    `SELECT COUNT(*)::int                                        AS enviadas,
            COUNT(*) FILTER (WHERE respuesta = 'ACEPTA')::int    AS aceptadas,
            COUNT(*) FILTER (WHERE respuesta = 'RECHAZA')::int   AS rechazadas,
            COUNT(*) FILTER (WHERE respuesta = 'TIMEOUT')::int   AS vencidas
       FROM ofertas WHERE ${diaDe('enviada_at')} = ?::date`, fecha);

  const s = await consultarUno<Fila>(
    `SELECT COUNT(*)::int                                      AS total,
            COUNT(*) FILTER (WHERE s.autogestionado)::int      AS autogestion,
            COUNT(*) FILTER (WHERE s.estado = 'AUTOGESTION')::int AS autogestion_pendiente
       FROM sub_pedidos s
      WHERE ${diaDe('s.creado_at')} = ?::date`, fecha);

  const pedidos = await consultarUno<Fila>(
    `SELECT COUNT(*)::int                                    AS total,
            COUNT(*) FILTER (WHERE estado = 'ENTREGADO')::int AS entregados,
            COALESCE(SUM(total_venta), 0)::int               AS venta,
            COALESCE(SUM(costo_despacho), 0)::int            AS despacho_cobrado
       FROM pedidos WHERE ${diaDe('creado_at')} = ?::date`, fecha);

  // Margen sobre lo entregado: es la plata que efectivamente se ganó
  // o se perdió, no la que se facturó.
  const cerrados = await consultarUno<Fila>(
    `SELECT COALESCE(SUM(p.total_venta), 0)::int AS ingresos,
            COALESCE((SELECT SUM(s.monto_feriante) FROM sub_pedidos s
                       WHERE s.pedido_id = ANY(ARRAY(SELECT id FROM pedidos
                         WHERE estado = 'ENTREGADO' AND ${diaDe('creado_at')} = ?::date))
                         AND s.estado = 'RETIRADO'), 0)::int AS mercaderia,
            COALESCE((SELECT SUM(v.tarifa) FROM viajes v
                       WHERE v.pedido_id = ANY(ARRAY(SELECT id FROM pedidos
                         WHERE estado = 'ENTREGADO' AND ${diaDe('creado_at')} = ?::date))), 0)::int AS reparto
       FROM pedidos p
      WHERE p.estado = 'ENTREGADO' AND ${diaDe('p.creado_at')} = ?::date`,
    fecha, fecha, fecha);

  // Lo que costaron las cancelaciones: mercadería que se pagó y no
  // se vendió. Es plata perdida y tiene que verse.
  const perdidas = await consultarUno<Fila>(
    `SELECT COALESCE(SUM(s.monto_feriante), 0)::int AS compensaciones,
            COUNT(DISTINCT s.pedido_id)::int        AS pedidos
       FROM sub_pedidos s
      WHERE s.compensado
        AND ${diaDe('s.aceptado_at')} = ?::date`, fecha);

  const respondidas = o!.aceptadas + o!.rechazadas;

  const ingresos = cerrados!.ingresos;
  const comisiones = Math.round(ingresos * CONFIG.comisiones);
  const margen = ingresos - cerrados!.mercaderia - cerrados!.reparto
    - comisiones - perdidas!.compensaciones;

  return {
    fecha,
    pedidos: {
      total: pedidos!.total,
      entregados: pedidos!.entregados,
      venta: pedidos!.venta,
      despachoCobrado: pedidos!.despacho_cobrado,
    },
    /**
     * La cuenta completa de lo entregado hoy. Es el número que dice
     * si el negocio existe: sin esto solo se ve la venta, que sube
     * igual aunque cada pedido pierda plata.
     */
    plata: {
      ingresos,
      mercaderia: cerrados!.mercaderia,
      reparto: cerrados!.reparto,
      comisiones,
      /** Mercadería que pagaste de pedidos cancelados. */
      cancelaciones: perdidas!.compensaciones,
      pedidosCancelados: perdidas!.pedidos,
      margen,
      porPedido: pedidos!.entregados ? Math.round(margen / pedidos!.entregados) : null,
      tasaMargen: ingresos ? Number((margen / ingresos).toFixed(3)) : null,
    },
    ofertas: {
      enviadas: o!.enviadas,
      aceptadas: o!.aceptadas,
      rechazadas: o!.rechazadas,
      vencidas: o!.vencidas,
      /** Cuántas ofertas terminan en aceptación. */
      tasaAceptacion: o!.enviadas ? Number((o!.aceptadas / o!.enviadas).toFixed(3)) : null,
      /** De los que reciben una oferta, cuántos contestan algo. */
      tasaRespuesta: o!.enviadas ? Number((respondidas / o!.enviadas).toFixed(3)) : null,
    },
    subPedidos: {
      total: s!.total,
      autogestion: s!.autogestion,
      /** Los que todavía tienes que ir a comprar ahora mismo. */
      pendientes: s!.autogestion_pendiente,
      /** Porción del trabajo que terminas haciendo tú. */
      tasaAutogestion: s!.total ? Number((s!.autogestion / s!.total).toFixed(3)) : null,
    },
  };
}
