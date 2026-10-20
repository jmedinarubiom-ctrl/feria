import { CONFIG } from '../config.ts';
import {
  ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila,
} from '../db/index.ts';
import { ErrorNegocio, EstadoViaje } from './estados.ts';
import { estadoFeria, horarioDeFeria, horarioForzado, momentoLocal } from './horario.ts';
import { hoy } from './liquidaciones.ts';
import { completarParada } from './reparto.ts';
import { puntoDeFeria } from './tarifas.ts';
import { publicar } from '../realtime/bus.ts';

/**
 * Compra programada: el camión de la tarde.
 *
 * El cliente pide en la mañana, los feriantes preparan sin apuro, y
 * al cierre un solo chofer reparte todos los pedidos del día en una
 * ruta. Cada pedido programado tiene su viaje, como cualquier otro,
 * pero marcado `programado`: no se les ofrece a las motos. El
 * operador junta los que hay en una ruta y se la asigna a un chofer;
 * la ruta ordena las entregas para recorrer lo menos posible.
 */

type Punto = { lat: number; lng: number };

const enMinutos = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const ventanaProgramada = (): string =>
  `${CONFIG.programado.desde}–${CONFIG.programado.hasta}`;

/**
 * Si hoy se puede pedir programado en esta feria, y por qué no.
 *
 * Hace falta que la feria esté tomando pedidos y que no haya pasado
 * la hora de corte: después los feriantes ya no alcanzan a preparar
 * con calma y la ruta se arma con lo que hay.
 */
export function programadoDisponible(feria: Fila, cuando = new Date()) {
  const base = {
    ventana: ventanaProgramada(),
    corte: CONFIG.programado.corte,
    costo: CONFIG.programado.costo,
  };
  const estado = estadoFeria(cuando, horarioDeFeria(feria));
  if (!estado.aceptandoPedidos) return { ...base, disponible: false, motivo: estado.mensaje };
  if (!horarioForzado() && momentoLocal(cuando).minutos > enMinutos(CONFIG.programado.corte)) {
    return {
      ...base, disponible: false,
      motivo: `El reparto programado de hoy se cerró a las ${CONFIG.programado.corte}.`,
    };
  }
  return { ...base, disponible: true, motivo: null };
}

/** Despacho de un programado: precio fijo, gratis igual que siempre si el carro es grande y cerca. */
export function despachoProgramado(totalProductos: number, km: number): number {
  const gratis = totalProductos >= CONFIG.despacho.gratisDesde && km <= CONFIG.despacho.gratisHastaKm;
  return gratis ? 0 : CONFIG.programado.costo;
}

// ============================================================
// El orden de las entregas
// ============================================================

const kmRecta = (a: Punto, b: Punto): number => {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};

const largo = (origen: Punto, puntos: Punto[], orden: number[]): number => {
  let total = 0, previo = origen;
  for (const i of orden) { total += kmRecta(previo, puntos[i]); previo = puntos[i]; }
  return total;
};

/**
 * El orden de visita que recorre menos, saliendo de la feria.
 *
 * Primero el vecino más cercano (siempre al punto más próximo que
 * falta) y después 2-opt: dar vuelta tramos mientras eso acorte la
 * ruta. Con 30 o 40 entregas queda a pocos por ciento del óptimo y
 * se calcula al instante, sin servicios externos. La ruta no vuelve
 * a la feria: el camión termina donde termina.
 *
 * Devuelve los índices en orden y los km por calle estimados.
 */
export function ordenarEntregas(origen: Punto, puntos: Punto[]): { orden: number[]; km: number } {
  const n = puntos.length;
  if (n === 0) return { orden: [], km: 0 };

  const faltan = new Set(puntos.map((_, i) => i));
  const orden: number[] = [];
  let actual = origen;
  while (faltan.size) {
    let mejor = -1, dMejor = Infinity;
    for (const i of faltan) {
      const d = kmRecta(actual, puntos[i]);
      if (d < dMejor) { dMejor = d; mejor = i; }
    }
    orden.push(mejor);
    faltan.delete(mejor);
    actual = puntos[mejor];
  }

  let mejoro = true;
  for (let vuelta = 0; mejoro && vuelta < 50; vuelta++) {
    mejoro = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const candidato = [...orden.slice(0, i), ...orden.slice(i, k + 1).reverse(), ...orden.slice(k + 1)];
        if (largo(origen, puntos, candidato) + 1e-9 < largo(origen, puntos, orden)) {
          orden.splice(0, n, ...candidato);
          mejoro = true;
        }
      }
    }
  }
  const km = Math.round(largo(origen, puntos, orden) * CONFIG.reparto.factorCalle * 10) / 10;
  return { orden, km };
}

// ============================================================
// El operador arma la ruta
// ============================================================

const DIA_LOCAL = (col: string) => `(${col} AT TIME ZONE '${CONFIG.zonaHoraria}')::date`;

/** Los pedidos programados de hoy que todavía no tienen ruta. */
export async function pendientesDeRuta(feriaId?: string) {
  return consultar<Fila>(
    `SELECT v.id AS viaje_id, p.id AS pedido_id, p.numero, p.feria_id, p.cliente_nombre,
            p.direccion, p.lat, p.lng, p.estado AS estado_pedido, p.distancia_km,
            (SELECT fe.nombre FROM ferias fe WHERE fe.id = p.feria_id) AS feria_nombre
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.programado AND v.ruta_id IS NULL AND v.estado = ?
        AND ${DIA_LOCAL('v.creado_at')} = ?::date
        ${feriaId ? 'AND p.feria_id = ?' : ''}
      ORDER BY p.numero`,
    EstadoViaje.BUSCANDO, hoy(), ...(feriaId ? [feriaId] : []));
}

/**
 * Junta los programados de hoy de una feria en una ruta, los ordena
 * y se la entrega al chofer.
 */
export async function armarRuta(feriaId: unknown, repartidorId: string) {
  if (typeof feriaId !== 'string' || !feriaId) throw new ErrorNegocio(422, 'Falta la feria.');
  const origen = await puntoDeFeria(feriaId);

  return enTransaccion(async () => {
    const pendientes = await pendientesDeRuta(feriaId);
    if (pendientes.length === 0) {
      throw new ErrorNegocio(409, 'No hay pedidos programados esperando ruta en esa feria.');
    }
    const enCurso = await consultarUno<Fila>(
      `SELECT id FROM rutas WHERE repartidor_id = ? AND estado IN ('ARMADA', 'EN_CURSO')`, repartidorId);
    if (enCurso) throw new ErrorNegocio(409, 'Ese chofer ya tiene una ruta sin terminar.');
    const ocupado = await consultarUno<Fila>(
      `SELECT id FROM viajes WHERE repartidor_id = ? AND estado IN (?, ?, ?)`,
      repartidorId, EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO, EstadoViaje.EN_RUTA);
    if (ocupado) throw new ErrorNegocio(409, 'Ese repartidor está llevando un pedido ahora.');

    const { orden, km } = ordenarEntregas(origen, pendientes.map((p) => ({ lat: p.lat, lng: p.lng })));
    const rutaId = id();
    await ejecutar(
      `INSERT INTO rutas (id, feria_id, fecha, repartidor_id, km_total) VALUES (?, ?, ?::date, ?, ?)`,
      rutaId, feriaId, hoy(), repartidorId, km);

    let posicion = 0;
    for (const i of orden) {
      const p = pendientes[i];
      await ejecutar(
        `UPDATE viajes SET ruta_id = ?, orden_ruta = ?, repartidor_id = ?, estado = ?, asignado_at = ?
          WHERE id = ?`,
        rutaId, posicion++, repartidorId, EstadoViaje.ASIGNADO, ahora(), p.viaje_id);
      await registrarEvento('viaje', p.viaje_id, '-> ASIGNADO', { repartidorId, rutaId });
    }
    await registrarEvento('ruta', rutaId, 'armada', { feriaId, repartidorId, entregas: orden.length, km });
    publicar({ tipo: 'ruta:nueva', rutaId, repartidorId, entregas: orden.length });
    return { rutaId, entregas: orden.length, km };
  });
}

/** Las rutas de hoy, con su avance, para el panel. */
export async function rutasDeHoy() {
  return consultar<Fila>(
    `SELECT r.*, fe.nombre AS feria_nombre, rp.nombre AS chofer,
            (SELECT COUNT(*)::int FROM viajes v WHERE v.ruta_id = r.id) AS entregas,
            (SELECT COUNT(*)::int FROM viajes v WHERE v.ruta_id = r.id AND v.estado = 'ENTREGADO') AS entregados
       FROM rutas r
       JOIN ferias fe ON fe.id = r.feria_id
       JOIN repartidores rp ON rp.id = r.repartidor_id
      WHERE r.fecha = ?::date
      ORDER BY r.creado_at`, hoy());
}

// ============================================================
// El chofer hace la ruta
// ============================================================

/** La ruta que tiene el chofer, con las entregas en orden. */
export async function rutaActiva(repartidorId: string) {
  const ruta = await consultarUno<Fila>(
    `SELECT r.*, fe.nombre AS feria_nombre FROM rutas r JOIN ferias fe ON fe.id = r.feria_id
      WHERE r.repartidor_id = ? AND r.estado IN ('ARMADA', 'EN_CURSO')
      ORDER BY r.creado_at DESC LIMIT 1`, repartidorId);
  if (!ruta) return null;

  const viajes = await consultar<Fila>(
    `SELECT v.id, v.estado, v.orden_ruta, p.id AS pedido_id, p.numero, p.cliente_nombre,
            p.cliente_telefono, p.direccion, p.notas, p.lat, p.lng, p.estado AS estado_pedido
       FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.ruta_id = ? ORDER BY v.orden_ruta`, ruta.id);
  const entregas = await Promise.all(viajes.map(async (v) => {
    const paradas = await consultar<Fila>(
      'SELECT id, tipo, etiqueta, completada_at FROM paradas WHERE viaje_id = ? ORDER BY orden', v.id);
    const entrega = paradas.find((p) => p.tipo === 'ENTREGA');
    return {
      ...v,
      paradaEntregaId: entrega?.id ?? null,
      retirosPendientes: paradas.filter((p) => p.tipo === 'RETIRO' && !p.completada_at).length,
    };
  }));
  const vivas = entregas.filter((e) => e.estado !== EstadoViaje.CANCELADO);
  return {
    ...ruta,
    ventana: ventanaProgramada(),
    entregas,
    resumen: {
      total: vivas.length,
      entregados: vivas.filter((e) => e.estado === EstadoViaje.ENTREGADO).length,
      porCargar: vivas.filter((e) => e.retirosPendientes > 0).length,
    },
  };
}

/**
 * El chofer carga el camión: retira de una vez todas las bolsas de
 * todos los pedidos de la ruta. Lo que todavía no tiene puesto
 * (se está ofertando de nuevo) queda pendiente y se avisa.
 */
export async function cargarCamion(repartidorId: string) {
  const ruta = await consultarUno<Fila>(
    `SELECT * FROM rutas WHERE repartidor_id = ? AND estado IN ('ARMADA', 'EN_CURSO')`, repartidorId);
  if (!ruta) throw new ErrorNegocio(404, 'No tienes una ruta asignada.');

  const retiros = await consultar<Fila>(
    `SELECT pa.id, p.numero FROM paradas pa
       JOIN viajes v ON v.id = pa.viaje_id
       JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.ruta_id = ? AND pa.tipo = 'RETIRO' AND pa.completada_at IS NULL
        AND v.estado IN (?, ?)
      ORDER BY v.orden_ruta, pa.orden`,
    ruta.id, EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO);
  const conProblema = new Set<number>();
  for (const r of retiros) {
    try {
      await completarParada(r.id, repartidorId);
    } catch {
      conProblema.add(r.numero);
    }
  }
  const sinTerminar = await consultar<Fila>(
    `SELECT p.numero FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.ruta_id = ? AND v.estado IN (?, ?) ORDER BY v.orden_ruta`,
    ruta.id, EstadoViaje.ASIGNADO, EstadoViaje.RETIRANDO);
  for (const s of sinTerminar) conProblema.add(s.numero);

  if (ruta.estado === 'ARMADA') {
    await ejecutar(`UPDATE rutas SET estado = 'EN_CURSO', iniciada_at = ? WHERE id = ?`, ahora(), ruta.id);
    await registrarEvento('ruta', ruta.id, 'en curso', { pendientes: [...conProblema] });
  }
  publicar({ tipo: 'ruta:avance', rutaId: ruta.id });
  return { cargados: retiros.length, pendientes: [...conProblema].sort((a, b) => a - b) };
}

/**
 * Después de cada entrega: cierra la ruta si ya no queda nada.
 * La llama `completarParada`.
 */
export async function revisarRuta(rutaId: string): Promise<void> {
  const quedan = await consultarUno<Fila>(
    `SELECT COUNT(*)::int AS n FROM viajes WHERE ruta_id = ? AND estado NOT IN (?, ?)`,
    rutaId, EstadoViaje.ENTREGADO, EstadoViaje.CANCELADO);
  if ((quedan?.n ?? 0) === 0) {
    await ejecutar(
      `UPDATE rutas SET estado = 'TERMINADA', terminada_at = ? WHERE id = ? AND estado <> 'TERMINADA'`,
      ahora(), rutaId);
    await registrarEvento('ruta', rutaId, 'terminada', {});
  }
  publicar({ tipo: 'ruta:avance', rutaId });
}

// ============================================================
// Cuándo llega
// ============================================================

/**
 * Las entregas que faltan de una ruta en curso, en orden, con los
 * minutos estimados hasta cada una: desde donde va el camión, por
 * calle, a la velocidad de un camión en ciudad y con unos minutos
 * por cada entrega anterior.
 */
export async function llegadasDeRuta(rutaId: string) {
  const ruta = await consultarUno<Fila>(
    `SELECT r.*, rp.lat AS c_lat, rp.lng AS c_lng FROM rutas r
       JOIN repartidores rp ON rp.id = r.repartidor_id WHERE r.id = ?`, rutaId);
  if (!ruta || ruta.estado !== 'EN_CURSO') return [];
  const faltan = await consultar<Fila>(
    `SELECT v.id, p.id AS pedido_id, p.lat, p.lng FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.ruta_id = ? AND v.estado = ? ORDER BY v.orden_ruta`, rutaId, EstadoViaje.EN_RUTA);
  let desde: Punto = Number.isFinite(ruta.c_lat) && Number.isFinite(ruta.c_lng)
    ? { lat: ruta.c_lat, lng: ruta.c_lng } : await puntoDeFeria(ruta.feria_id);
  let minutos = 0;
  return faltan.map((f, i) => {
    const destino = { lat: f.lat, lng: f.lng };
    minutos += (kmRecta(desde, destino) * CONFIG.reparto.factorCalle / CONFIG.programado.kmPorHora) * 60;
    if (i > 0) minutos += CONFIG.programado.minutosPorEntrega;
    desde = destino;
    return { pedidoId: f.pedido_id, antes: i, minutos: Math.max(2, Math.round(minutos)) };
  });
}
