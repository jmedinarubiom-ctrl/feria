import { CONFIG } from '../config.ts';
import {
  ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila,
} from '../db/index.ts';
import {
  ErrorNegocio, EstadoSubPedido, EstadoViaje, TRANSICIONES_VIAJE, validarTransicion,
} from './estados.ts';
import { publicar } from '../realtime/bus.ts';
import { evaluarPedido } from './despacho.ts';

async function cambiarEstadoViaje(
  viajeId: string, hacia: EstadoViaje, extra: Fila = {},
): Promise<Fila> {
  const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE id = ? FOR UPDATE', viajeId);
  if (!viaje) throw new ErrorNegocio(404, `Viaje inexistente: ${viajeId}`);
  if (viaje.estado === hacia) return viaje;
  validarTransicion('viaje', TRANSICIONES_VIAJE, viaje.estado, hacia);

  const campos = ['estado = ?'];
  const valores: any[] = [hacia];
  for (const [k, v] of Object.entries(extra)) {
    campos.push(`${k} = ?`);
    valores.push(v);
  }
  valores.push(viajeId);
  await ejecutar(`UPDATE viajes SET ${campos.join(', ')} WHERE id = ?`, ...valores);

  await registrarEvento('viaje', viajeId, `-> ${hacia}`, { desde: viaje.estado });
  publicar({ tipo: 'viaje:cambio', viajeId, estado: hacia, repartidorId: viaje.repartidor_id });
  return viaje;
}

/**
 * Crea el viaje una vez que todos los sub-pedidos tienen dueño.
 *
 * Las paradas se agrupan por feriante: si el mismo puesto se quedó
 * con dos sub-pedidos, es una sola parada. Todo lo que quedó en
 * autogestión se junta en una única parada con el operador.
 */
export async function crearViaje(pedidoId: string): Promise<string> {
  const yaHay = await consultarUno<Fila>(
    `SELECT id FROM viajes WHERE pedido_id = ? AND estado <> ?`, pedidoId, EstadoViaje.CANCELADO);
  if (yaHay) return yaHay.id;

  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  const retiros = await retirosPendientes(pedidoId);

  const viajeId = id();
  const tarifa = CONFIG.tarifaReparto
    + Math.max(0, retiros.length - 1) * CONFIG.tarifaPorParadaExtra;
  await ejecutar(
    `INSERT INTO viajes (id, pedido_id, estado, tarifa) VALUES (?, ?, ?, ?)`,
    viajeId, pedidoId, EstadoViaje.BUSCANDO, tarifa,
  );

  let orden = 0;
  for (const r of retiros) {
    await ejecutar(
      `INSERT INTO paradas (id, viaje_id, orden, tipo, sub_pedido_id, etiqueta, lat, lng)
       VALUES (?, ?, ?, 'RETIRO', ?, ?, ?, ?)`,
      id(), viajeId, orden++, r.subPedidoId, r.etiqueta, r.lat, r.lng,
    );
  }
  await ejecutar(
    `INSERT INTO paradas (id, viaje_id, orden, tipo, sub_pedido_id, etiqueta, lat, lng)
     VALUES (?, ?, ?, 'ENTREGA', NULL, ?, ?, ?)`,
    id(), viajeId, orden, `Entrega — ${pedido!.cliente_nombre}, ${pedido!.direccion}`,
    pedido!.lat, pedido!.lng,
  );

  await registrarEvento('viaje', viajeId, 'creado', { pedidoId, paradas: orden + 1, tarifa });
  publicar({ tipo: 'viaje:nuevo', viajeId, pedidoId });
  return viajeId;
}

/** Los sub-pedidos que tienen dueño y todavía están en la feria. */
const POR_RETIRAR = [EstadoSubPedido.ACEPTADO, EstadoSubPedido.AUTOGESTION, EstadoSubPedido.LISTO];

type Retiro = { subPedidoId: string; etiqueta: string; lat: number | null; lng: number | null };

/**
 * Las paradas de retiro que hacen falta ahora mismo.
 *
 * Se agrupan por feriante: si el mismo puesto se quedó con dos
 * sub-pedidos, es una sola parada. Una parada guarda el primero
 * como referencia y el resto se resuelve por feriante al
 * completarla. Lo que está ofertándose no tiene parada: todavía no
 * se sabe en qué puesto va a estar.
 */
async function retirosPendientes(pedidoId: string): Promise<Retiro[]> {
  const subs = await consultar<Fila>(
    `SELECT s.*, f.nombre AS feriante_nombre, f.puesto, f.lat AS f_lat, f.lng AS f_lng
       FROM sub_pedidos s
       LEFT JOIN feriantes f ON f.id = s.feriante_id
      WHERE s.pedido_id = ? AND s.estado IN (?, ?, ?)
      ORDER BY s.creado_at, s.id`,
    pedidoId, ...POR_RETIRAR);

  const grupos = new Map<string, Fila[]>();
  for (const s of subs) {
    const clave = s.feriante_id ?? '__autogestion__';
    grupos.set(clave, [...(grupos.get(clave) ?? []), s]);
  }

  return [...grupos].map(([clave, lista]) => {
    const ref = lista[0];
    return {
      subPedidoId: ref.id,
      etiqueta: clave === '__autogestion__'
        ? `Autogestión — retiro con el operador (${lista.length} ${lista.length === 1 ? 'bolsa' : 'bolsas'})`
        : `${ref.puesto} — ${ref.feriante_nombre}`,
      lat: ref.f_lat ?? null,
      lng: ref.f_lng ?? null,
    };
  });
}

/**
 * Pone las paradas del viaje al día con quién tiene cada bolsa.
 *
 * El viaje se arma cuando todos los sub-pedidos tienen dueño, pero
 * el dueño puede cambiar después: un feriante que aceptó y devuelve
 * el pedido («no lo puedo cumplir»). Las paradas quedaban como se
 * crearon, y el repartidor iba a buscar la bolsa al puesto que la
 * había devuelto — y al tocar RETIRADO marcaba como retirado algo
 * que todavía se estaba ofertando.
 *
 * Las paradas ya completadas no se tocan. Si no cambió nada no
 * escribe nada, para no cambiarle los ids a la app del repartidor.
 */
export async function sincronizarParadas(pedidoId: string): Promise<void> {
  const viaje = await consultarUno<Fila>(
    `SELECT * FROM viajes WHERE pedido_id = ? AND estado IN (?, ?, ?)`,
    pedidoId, EstadoViaje.BUSCANDO, EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO);
  if (!viaje) return;

  const deseadas = await retirosPendientes(pedidoId);
  const actuales = await consultar<Fila>(
    `SELECT sub_pedido_id, etiqueta FROM paradas
      WHERE viaje_id = ? AND tipo = 'RETIRO' AND completada_at IS NULL`, viaje.id);

  const firma = (l: Array<{ ref: string; etiqueta: string }>) =>
    l.map((p) => `${p.ref}|${p.etiqueta}`).sort().join('\n');
  if (firma(actuales.map((p) => ({ ref: p.sub_pedido_id, etiqueta: p.etiqueta })))
      === firma(deseadas.map((p) => ({ ref: p.subPedidoId, etiqueta: p.etiqueta })))) return;

  await ejecutar(
    `DELETE FROM paradas WHERE viaje_id = ? AND tipo = 'RETIRO' AND completada_at IS NULL`,
    viaje.id);
  const hechas = await consultarUno<Fila>(
    `SELECT COALESCE(MAX(orden), -1)::int AS n FROM paradas
      WHERE viaje_id = ? AND tipo = 'RETIRO'`, viaje.id);
  let orden = hechas!.n + 1;

  // La entrega va siempre al final. Se corre primero: el orden es
  // único por viaje y si no chocaría con los retiros nuevos.
  await ejecutar(`UPDATE paradas SET orden = ? WHERE viaje_id = ? AND tipo = 'ENTREGA'`,
    orden + deseadas.length, viaje.id);
  for (const r of deseadas) {
    await ejecutar(
      `INSERT INTO paradas (id, viaje_id, orden, tipo, sub_pedido_id, etiqueta, lat, lng)
       VALUES (?, ?, ?, 'RETIRO', ?, ?, ?, ?)`,
      id(), viaje.id, orden++, r.subPedidoId, r.etiqueta, r.lat, r.lng);
  }

  await registrarEvento('viaje', viaje.id, 'paradas actualizadas',
    { retiros: deseadas.map((r) => r.etiqueta) });
  publicar({
    tipo: 'viaje:cambio', viajeId: viaje.id, estado: viaje.estado,
    repartidorId: viaje.repartidor_id ?? undefined,
  });
}

export class ViajeNoDisponible extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ViajeNoDisponible';
  }
}

/** Primer repartidor que lo toma se lo queda (misma carrera que las ofertas). */
export async function aceptarViaje(viajeId: string, repartidorId: string): Promise<Fila> {
  return enTransaccion(async () => {
    const r = await ejecutar(
      `UPDATE viajes SET estado = ?, repartidor_id = ?, asignado_at = ?
        WHERE id = ? AND estado = ?`,
      EstadoViaje.ASIGNADO, repartidorId, ahora(), viajeId, EstadoViaje.BUSCANDO,
    );
    if (r.afectadas !== 1) throw new ViajeNoDisponible('Otro repartidor tomó este viaje.');

    await registrarEvento('viaje', viajeId, '-> ASIGNADO', { repartidorId });
    publicar({ tipo: 'viaje:cambio', viajeId, estado: EstadoViaje.ASIGNADO, repartidorId });
    return (await consultarUno<Fila>('SELECT * FROM viajes WHERE id = ?', viajeId))!;
  });
}

/**
 * El repartidor completa una parada. Si es de retiro, los
 * sub-pedidos de ese puesto quedan RETIRADO — que el repartidor
 * los tenga en la mano es la única confirmación que importa.
 */
export async function completarParada(paradaId: string, repartidorId: string): Promise<void> {
  await enTransaccion(async () => {
    // Con candado: dos toques seguidos al botón no completan la
    // parada dos veces.
    const parada = await consultarUno<Fila>(
      'SELECT * FROM paradas WHERE id = ? FOR UPDATE', paradaId);
    if (!parada) throw new ErrorNegocio(404, `Parada inexistente: ${paradaId}`);
    if (parada.completada_at) return;

    const viaje = await consultarUno<Fila>('SELECT * FROM viajes WHERE id = ?', parada.viaje_id);
    if (viaje!.repartidor_id !== repartidorId) {
      throw new ViajeNoDisponible('Este viaje no es tuyo.');
    }
    // El repartidor puede estar tocando botones sin haberse enterado
    // de que el pedido se canceló mientras iba en camino.
    if (![EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO, EstadoViaje.EN_RUTA]
          .includes(viaje!.estado)) {
      throw new ViajeNoDisponible(
        viaje!.estado === EstadoViaje.CANCELADO
          ? 'Este viaje se canceló. Anda al detalle del pedido.'
          : 'Este viaje ya está cerrado.');
    }

    // Las paradas se completan en orden: saltearse una significa
    // que el repartidor dejó bolsas atrás.
    const anterior = await consultarUno<Fila>(
      `SELECT id FROM paradas WHERE viaje_id = ? AND orden < ? AND completada_at IS NULL
        ORDER BY orden LIMIT 1`,
      parada.viaje_id, parada.orden);
    if (anterior) throw new ViajeNoDisponible('Te falta completar una parada anterior.');

    await ejecutar('UPDATE paradas SET completada_at = ? WHERE id = ?', ahora(), paradaId);
    if (viaje!.estado === EstadoViaje.ASIGNADO) {
      await cambiarEstadoViaje(viaje!.id, EstadoViaje.RETIRANDO, { iniciado_at: ahora() });
    }

    if (parada.tipo === 'RETIRO') {
      const ref = await consultarUno<Fila>(
        'SELECT * FROM sub_pedidos WHERE id = ?', parada.sub_pedido_id);
      // Solo lo que tiene dueño y sigue en la feria. Sin el filtro
      // de estado, la parada de autogestión —que busca «sin
      // feriante»— se llevaba también lo que estaba ofertándose.
      const hermanos = ref!.feriante_id
        ? await consultar<Fila>(
            `SELECT * FROM sub_pedidos
              WHERE pedido_id = ? AND feriante_id = ? AND estado IN (?, ?, ?)`,
            ref!.pedido_id, ref!.feriante_id, ...POR_RETIRAR)
        : await consultar<Fila>(
            `SELECT * FROM sub_pedidos
              WHERE pedido_id = ? AND feriante_id IS NULL AND estado IN (?, ?, ?)`,
            ref!.pedido_id, ...POR_RETIRAR);

      for (const s of hermanos) {
        if (s.estado === EstadoSubPedido.ACEPTADO || s.estado === EstadoSubPedido.AUTOGESTION) {
          await ejecutar('UPDATE sub_pedidos SET estado = ?, listo_at = ? WHERE id = ?',
            EstadoSubPedido.LISTO, ahora(), s.id);
        }
        await ejecutar('UPDATE sub_pedidos SET estado = ?, retirado_at = ? WHERE id = ?',
          EstadoSubPedido.RETIRADO, ahora(), s.id);
        await registrarEvento('sub_pedido', s.id, '-> RETIRADO', { repartidorId });
        publicar({
          tipo: 'subpedido:cambio', subPedidoId: s.id, pedidoId: s.pedido_id,
          estado: 'RETIRADO', ferianteId: s.feriante_id,
        });
      }

      // Se cuenta lo que falta retirar, no las paradas: un
      // sub-pedido que volvió a ofertarse no tiene parada todavía,
      // y el repartidor no puede salir sin esa bolsa.
      const faltanRetiros = await consultarUno<Fila>(
        `SELECT COUNT(*)::int AS n FROM sub_pedidos
          WHERE pedido_id = ? AND estado NOT IN (?, ?)`,
        ref!.pedido_id, EstadoSubPedido.RETIRADO, EstadoSubPedido.CANCELADO);
      if ((faltanRetiros?.n ?? 0) === 0) {
        await cambiarEstadoViaje(viaje!.id, EstadoViaje.EN_RUTA);
      }
      await evaluarPedido(ref!.pedido_id);
    } else {
      if (viaje!.estado !== EstadoViaje.EN_RUTA) {
        throw new ViajeNoDisponible(
          'Todavía falta una bolsa: se está buscando otro puesto. Espera el aviso.');
      }
      await cambiarEstadoViaje(viaje!.id, EstadoViaje.ENTREGADO, { entregado_at: ahora() });
      await ejecutar('UPDATE pedidos SET estado = ?, entregado_at = ? WHERE id = ?',
        'ENTREGADO', ahora(), viaje!.pedido_id);
      await registrarEvento('pedido', viaje!.pedido_id, '-> ENTREGADO', { repartidorId });
      publicar({ tipo: 'pedido:cambio', pedidoId: viaje!.pedido_id, estado: 'ENTREGADO' });
    }
  });
}

export async function registrarUbicacion(
  repartidorId: string, lat: number, lng: number,
): Promise<void> {
  await ejecutar('UPDATE repartidores SET lat = ?, lng = ?, ubicacion_at = ? WHERE id = ?',
    lat, lng, ahora(), repartidorId);

  const viaje = await consultarUno<Fila>(
    `SELECT id, pedido_id FROM viajes WHERE repartidor_id = ? AND estado IN (?, ?, ?)`,
    repartidorId, EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO, EstadoViaje.EN_RUTA);
  if (!viaje) return;

  await ejecutar(
    'INSERT INTO ubicaciones (repartidor_id, viaje_id, lat, lng) VALUES (?, ?, ?, ?)',
    repartidorId, viaje.id, lat, lng);
  publicar({ tipo: 'ubicacion', viajeId: viaje.id, pedidoId: viaje.pedido_id, lat, lng });
}
