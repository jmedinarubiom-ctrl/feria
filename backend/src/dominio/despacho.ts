import { CONFIG } from '../config.ts';
import {
  ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila,
} from '../db/index.ts';
import {
  EstadoPedido, EstadoSubPedido, TRANSICIONES_PEDIDO, TRANSICIONES_SUB_PEDIDO, validarTransicion,
} from './estados.ts';
import { publicar } from '../realtime/bus.ts';
import { crearViaje } from './reparto.ts';
import { verificarHorario, estadoFeria } from './horario.ts';
import { geocodificar } from './geocodificar.ts';

// ============================================================
// Cambios de estado
// ============================================================

async function cambiarEstadoSubPedido(
  subPedidoId: string, hacia: EstadoSubPedido, extra: Fila = {},
): Promise<Fila> {
  const sub = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', subPedidoId);
  if (!sub) throw new Error(`Sub-pedido inexistente: ${subPedidoId}`);
  validarTransicion('sub_pedido', TRANSICIONES_SUB_PEDIDO, sub.estado, hacia);

  const campos = ['estado = ?'];
  const valores: any[] = [hacia];
  for (const [k, v] of Object.entries(extra)) {
    campos.push(`${k} = ?`);
    valores.push(v);
  }
  valores.push(subPedidoId);
  await ejecutar(`UPDATE sub_pedidos SET ${campos.join(', ')} WHERE id = ?`, ...valores);

  await registrarEvento('sub_pedido', subPedidoId, `-> ${hacia}`, { desde: sub.estado, ...extra });
  publicar({
    tipo: 'subpedido:cambio', subPedidoId, pedidoId: sub.pedido_id, estado: hacia,
    ferianteId: extra.feriante_id ?? sub.feriante_id ?? null,
  });
  return sub;
}

async function cambiarEstadoPedido(
  pedidoId: string, hacia: EstadoPedido, extra: Fila = {},
): Promise<Fila> {
  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  if (!pedido) throw new Error(`Pedido inexistente: ${pedidoId}`);
  if (pedido.estado === hacia) return pedido;
  validarTransicion('pedido', TRANSICIONES_PEDIDO, pedido.estado, hacia);

  const campos = ['estado = ?'];
  const valores: any[] = [hacia];
  for (const [k, v] of Object.entries(extra)) {
    campos.push(`${k} = ?`);
    valores.push(v);
  }
  valores.push(pedidoId);
  await ejecutar(`UPDATE pedidos SET ${campos.join(', ')} WHERE id = ?`, ...valores);

  await registrarEvento('pedido', pedidoId, `-> ${hacia}`, { desde: pedido.estado });
  publicar({ tipo: 'pedido:cambio', pedidoId, estado: hacia });
  return pedido;
}

// ============================================================
// Alta de pedido
// ============================================================

export type ItemEntrante = { productoId: string; cantidad: number };

export type PedidoEntrante = {
  shopifyOrderId?: string | null;
  feriaId: string;
  clienteNombre: string;
  clienteTelefono: string;
  /** Sin esto no hay dónde mandar un reembolso. */
  clienteEmail?: string | null;
  direccion: string;
  lat: number;
  lng: number;
  notas?: string | null;
  /** Lo que ya se le cobró de despacho. Si falta, se calcula acá. */
  costoDespacho?: number;
  /**
   * El cobro ya ocurrió afuera (checkout de Shopify).
   *
   * Con esto no se aplica el horario: rechazar plata que ya se cobró
   * deja al cliente sin pedido y sin devolución. Se acepta y queda
   * anotado para que el operador lo vea.
   */
  yaCobrado?: boolean;
  items: ItemEntrante[];
};

export class PedidoMuyChico extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PedidoMuyChico';
  }
}

/**
 * Cuánto se le cobra de despacho a un carro.
 *
 * Gratis sobre cierto monto: al cliente le conviene agregar
 * mercadería antes que pagar el envío, y a tú te conviene que la
 * agregue, porque el reparto cuesta lo mismo lleve poco o mucho.
 */
export function calcularDespacho(totalProductos: number): number {
  return totalProductos >= CONFIG.despacho.gratisDesde ? 0 : CONFIG.despacho.costo;
}

/** Lo que necesita la app para mostrar el carro antes de cobrar. */
export function cotizar(totalProductos: number) {
  const despacho = calcularDespacho(totalProductos);
  return {
    totalProductos,
    despacho,
    total: totalProductos + despacho,
    minimo: CONFIG.despacho.pedidoMinimo,
    alcanzaMinimo: totalProductos >= CONFIG.despacho.pedidoMinimo,
    gratisDesde: CONFIG.despacho.gratisDesde,
    /** Cuánto falta para que el despacho salga gratis. */
    faltaParaGratis: despacho > 0
      ? Math.max(0, CONFIG.despacho.gratisDesde - totalProductos)
      : 0,
  };
}

/**
 * Crea el pedido, lo parte en sub-pedidos por rubro y abre la
 * primera ronda de ofertas de cada uno.
 *
 * Partir por rubro es la decisión estructural del sistema: ningún
 * puesto de la feria vende verdura, fruta y pescado a la vez, así
 * que un pedido mixto SIEMPRE requiere varios puestos.
 */
export async function crearPedido(entrada: PedidoEntrante): Promise<{ pedidoId: string; numero: number }> {
  if (entrada.items.length === 0) throw new Error('El pedido no tiene items.');
  // Un pedido fuera de horario no tiene a quién ofrecerse: no hay
  // ni un puesto abierto en toda la feria. Salvo que ya esté cobrado
  // —ver `yaCobrado`—, en cuyo caso rechazarlo es peor.
  const fueraDeHorario = !estadoFeria().aceptandoPedidos;
  if (fueraDeHorario && !entrada.yaCobrado) verificarHorario();

  // El punto lo decide el servidor a partir de la dirección escrita,
  // no la app: antes llegaba siempre el mismo par de coordenadas y
  // el repartidor terminaba guiándose solo por el texto. Va FUERA de
  // la transacción porque es una llamada a otro servicio, y si falla
  // el pedido entra igual con el punto de la feria — no poder
  // comprar es peor que un punto impreciso.
  const ubicado = await geocodificar(entrada.direccion);
  const punto = ubicado
    ?? (Number.isFinite(entrada.lat) && Number.isFinite(entrada.lng)
        ? { lat: entrada.lat, lng: entrada.lng, precision: 'informada por la app' }
        : { ...CONFIG.puntoFeria, precision: 'feria' });

  return enTransaccion(async () => {
    // Idempotencia: Shopify reintenta webhooks. Sin esto, un
    // reintento crea el pedido dos veces y se despacha doble.
    if (entrada.shopifyOrderId) {
      const previo = await consultarUno<Fila>(
        'SELECT id, numero FROM pedidos WHERE shopify_order_id = ?', entrada.shopifyOrderId);
      if (previo) return { pedidoId: previo.id, numero: previo.numero };
    }

    const productos = new Map<string, Fila>();
    for (const it of entrada.items) {
      if (productos.has(it.productoId)) continue;
      const p = await consultarUno<Fila>(
        'SELECT * FROM productos WHERE id = ? AND activo', it.productoId);
      if (!p) throw new Error(`Producto inexistente o inactivo: ${it.productoId}`);
      productos.set(it.productoId, p);
    }

    const porRubro = new Map<string, ItemEntrante[]>();
    let totalProductos = 0;
    for (const it of entrada.items) {
      if (!Number.isInteger(it.cantidad) || it.cantidad <= 0) {
        throw new Error(`Cantidad inválida para ${it.productoId}`);
      }
      const p = productos.get(it.productoId)!;
      totalProductos += p.precio_venta * it.cantidad;
      const lista = porRubro.get(p.rubro_id) ?? [];
      lista.push(it);
      porRubro.set(p.rubro_id, lista);
    }

    if (totalProductos < CONFIG.despacho.pedidoMinimo) {
      throw new PedidoMuyChico(
        `El pedido mínimo es ${CONFIG.despacho.pedidoMinimo}. Este es de ${totalProductos}.`);
    }

    // Un pedido que viene de Shopify ya trae cobrado su despacho en
    // el checkout; uno interno se cotiza acá.
    const costoDespacho = entrada.costoDespacho ?? calcularDespacho(totalProductos);
    const totalVenta = totalProductos + costoDespacho;

    const pedidoId = id();
    const creado = await consultarUno<Fila>(
      `INSERT INTO pedidos (id, shopify_order_id, feria_id, cliente_nombre,
        cliente_telefono, cliente_email, direccion, lat, lng, geo_precision, notas,
        total_productos, costo_despacho, total_venta, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING numero`,
      pedidoId, entrada.shopifyOrderId ?? null, entrada.feriaId, entrada.clienteNombre,
      entrada.clienteTelefono, entrada.clienteEmail ?? null, entrada.direccion,
      punto.lat, punto.lng, punto.precision,
      entrada.notas ?? null, totalProductos, costoDespacho, totalVenta,
      EstadoPedido.PENDIENTE_PAGO,
    );
    const numero = creado!.numero;
    await registrarEvento('pedido', pedidoId, 'creado',
      { numero, totalProductos, costoDespacho, totalVenta, rubros: [...porRubro.keys()] });
    if (fueraDeHorario) {
      await registrarEvento('pedido', pedidoId, 'creado fuera de horario',
        { mensaje: estadoFeria().mensaje });
    }

    const subIds: string[] = [];
    for (const [rubroId, itemsRubro] of porRubro) {
      const subId = id();
      let montoFeriante = 0;
      for (const it of itemsRubro) {
        montoFeriante += productos.get(it.productoId)!.precio_costo * it.cantidad;
      }

      await ejecutar(
        `INSERT INTO sub_pedidos (id, pedido_id, rubro_id, monto_feriante, estado, ronda)
         VALUES (?, ?, ?, ?, ?, 0)`,
        subId, pedidoId, rubroId, montoFeriante, EstadoSubPedido.PENDIENTE,
      );

      for (const it of itemsRubro) {
        const p = productos.get(it.productoId)!;
        await ejecutar(
          `INSERT INTO items (id, sub_pedido_id, producto_id, nombre, formato,
             cantidad, precio_venta, precio_costo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id(), subId, p.id, p.nombre, p.formato, it.cantidad, p.precio_venta, p.precio_costo,
        );
      }
      subIds.push(subId);
    }

    // Acá NO se despacha nada: el pedido queda esperando el pago.
    // Despachar antes de cobrar pondría a ocho feriantes a preparar
    // mercadería de algo que nadie pagó.
    return { pedidoId, numero };
  });
}

/**
 * La pasarela confirmó el pago: recién ahora sale a la feria.
 *
 * Es idempotente porque las pasarelas reintentan sus confirmaciones,
 * y un segundo intento no puede volver a ofertar lo mismo.
 */
export async function confirmarPago(pedidoId: string): Promise<boolean> {
  return enTransaccion(async () => {
    const r = await ejecutar(
      'UPDATE pedidos SET estado = ? WHERE id = ? AND estado = ?',
      EstadoPedido.PAGADO, pedidoId, EstadoPedido.PENDIENTE_PAGO);
    if (r.afectadas !== 1) return false;

    await registrarEvento('pedido', pedidoId, '-> PAGADO');
    publicar({ tipo: 'pedido:cambio', pedidoId, estado: EstadoPedido.PAGADO });

    await cambiarEstadoPedido(pedidoId, EstadoPedido.DESPACHANDO);
    const subs = await consultar<Fila>(
      'SELECT id FROM sub_pedidos WHERE pedido_id = ? AND estado = ?',
      pedidoId, EstadoSubPedido.PENDIENTE);
    for (const s of subs) {
      // Feria cerrada o nadie conectado: no tiene sentido esperar
      // 90 segundos a nadie, va derecho a la cola del operador.
      if (!await intentarSiguienteRonda(s.id, 1)) {
        await aAutogestion(s.id, 'sin feriantes conectados');
      }
    }
    return true;
  });
}

/**
 * Cierra los pedidos de gente que abrió el checkout y no volvió.
 *
 * Sin esto la tabla se llena de pedidos fantasma que ensucian las
 * métricas y no se sabe si están vivos o muertos.
 */
export async function expirarPendientes(): Promise<number> {
  const viejos = await consultar<Fila>(
    `SELECT id FROM pedidos
      WHERE estado = ?
        AND creado_at < now() - make_interval(mins => ?)`,
    EstadoPedido.PENDIENTE_PAGO, CONFIG.minutosParaPagar);

  for (const p of viejos) {
    await enTransaccion(async () => {
      await cambiarEstadoPedido(p.id, EstadoPedido.EXPIRADO);
      await registrarEvento('pedido', p.id, 'expirado sin pagar',
        { minutos: CONFIG.minutosParaPagar });
    });
  }
  return viejos.length;
}

// ============================================================
// Cascada de ofertas
// ============================================================

async function candidatos(sub: Fila, pedido: Fila, alcance: string, limite: number): Promise<Fila[]> {
  const filtroRubro = alcance === 'FERIA_COMPLETA'
    ? ''
    : 'AND EXISTS (SELECT 1 FROM feriante_rubros fr WHERE fr.feriante_id = f.id AND fr.rubro_id = ?)';
  const params: any[] = [pedido.feria_id];
  if (filtroRubro) params.push(sub.rubro_id);
  params.push(sub.id, limite);

  // Reputación con suavizado de Laplace: un feriante nuevo arranca
  // en 0.5 y no queda sepultado al final de la cola para siempre.
  return consultar<Fila>(
    `SELECT f.*,
            (f.aceptaciones + 1.0) /
            (f.aceptaciones + f.rechazos + f.timeouts + f.incumplidos * 3 + 2.0) AS reputacion
       FROM feriantes f
      WHERE f.conectado
        AND f.feria_id = ?
        ${filtroRubro}
        -- Se excluye a quien ya contestó (o dejó vencer) esta oferta.
        -- Los que quedaron en 'CERRADA' perdieron la carrera sin culpa,
        -- así que siguen siendo elegibles si el pedido vuelve a la cascada.
        AND NOT EXISTS (SELECT 1 FROM ofertas o
                         WHERE o.sub_pedido_id = ? AND o.feriante_id = f.id
                           AND (o.respuesta IS NULL OR o.respuesta <> 'CERRADA'))
      ORDER BY reputacion DESC, random()
      LIMIT ?`,
    ...params,
  );
}

/**
 * Abre una ronda de ofertas. Devuelve false si no quedaba nadie a
 * quien ofrecer, para que el llamador decida (siguiente ronda o
 * autogestión).
 */
export async function abrirRonda(subPedidoId: string, ronda: number): Promise<boolean> {
  const sub = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', subPedidoId);
  if (!sub) throw new Error(`Sub-pedido inexistente: ${subPedidoId}`);

  const config = CONFIG.rondas.find((r) => r.numero === ronda);
  if (!config) return false;

  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', sub.pedido_id);
  const elegidos = await candidatos(sub, pedido!, config.alcance, config.limite);
  if (elegidos.length === 0) return false;

  const expiraAt = new Date(Date.now() + config.ventanaSegundos * 1000);

  for (const f of elegidos) {
    await ejecutar(
      `INSERT INTO ofertas (id, sub_pedido_id, feriante_id, ronda, expira_at)
       VALUES (?, ?, ?, ?, ?)`,
      id(), subPedidoId, f.id, ronda, expiraAt,
    );
    publicar({
      tipo: 'oferta:nueva', ferianteId: f.id, subPedidoId, expiraAt: expiraAt.toISOString(),
    });
  }

  await cambiarEstadoSubPedido(subPedidoId, EstadoSubPedido.OFERTANDO, { ronda });
  await registrarEvento('sub_pedido', subPedidoId, 'ronda abierta', {
    ronda, alcance: config.alcance, ofrecidoA: elegidos.length, expiraAt,
  });
  return true;
}

/**
 * Busca la próxima ronda que efectivamente tenga a quién ofrecerle.
 *
 * Una ronda puede quedar vacía sin que la cascada esté agotada: la
 * ronda 2 no agrega a nadie si el rubro ya se cubrió entero en la 1,
 * pero la ronda 3 abre a toda la feria y sí tiene candidatos.
 */
async function intentarSiguienteRonda(subPedidoId: string, desde: number): Promise<boolean> {
  for (const r of CONFIG.rondas) {
    if (r.numero < desde) continue;
    if (await abrirRonda(subPedidoId, r.numero)) return true;
  }
  return false;
}

/** Cierra las ofertas abiertas de un sub-pedido sin castigar a nadie. */
async function cerrarOfertasAbiertas(
  subPedidoId: string, motivo: string, exceptoFeriante?: string,
): Promise<void> {
  const abiertas = await consultar<Fila>(
    'SELECT * FROM ofertas WHERE sub_pedido_id = ? AND respuesta IS NULL', subPedidoId);
  for (const o of abiertas) {
    if (o.feriante_id === exceptoFeriante) continue;
    await ejecutar(
      'UPDATE ofertas SET respuesta = ?, respondida_at = ? WHERE id = ?',
      'CERRADA', ahora(), o.id);
    publicar({ tipo: 'oferta:cerrada', ferianteId: o.feriante_id, subPedidoId, motivo });
  }
}

export class OfertaNoDisponible extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'OfertaNoDisponible';
  }
}

/**
 * Un feriante acepta. Gana el primero: el UPDATE condicional sobre
 * el estado es lo que resuelve la carrera cuando cinco feriantes
 * tocan el botón en el mismo segundo.
 */
export async function aceptarOferta(subPedidoId: string, ferianteId: string): Promise<Fila> {
  return enTransaccion(async () => {
    const oferta = await consultarUno<Fila>(
      `SELECT * FROM ofertas
        WHERE sub_pedido_id = ? AND feriante_id = ? AND respuesta IS NULL`,
      subPedidoId, ferianteId);
    if (!oferta) throw new OfertaNoDisponible('No tienes una oferta abierta para este pedido.');
    if (oferta.expira_at.getTime() < Date.now()) {
      throw new OfertaNoDisponible('La oferta ya venció.');
    }

    const r = await ejecutar(
      `UPDATE sub_pedidos SET estado = ?, feriante_id = ?, aceptado_at = ?
        WHERE id = ? AND estado = ?`,
      EstadoSubPedido.ACEPTADO, ferianteId, ahora(), subPedidoId, EstadoSubPedido.OFERTANDO,
    );
    if (r.afectadas !== 1) throw new OfertaNoDisponible('Otro feriante lo tomó primero.');

    await ejecutar('UPDATE ofertas SET respuesta = ?, respondida_at = ? WHERE id = ?',
      'ACEPTA', ahora(), oferta.id);
    await ejecutar('UPDATE feriantes SET aceptaciones = aceptaciones + 1 WHERE id = ?', ferianteId);
    await cerrarOfertasAbiertas(subPedidoId, 'tomado por otro feriante', ferianteId);

    await registrarEvento('sub_pedido', subPedidoId, '-> ACEPTADO',
      { ferianteId, ronda: oferta.ronda });
    const sub = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', subPedidoId);
    publicar({
      tipo: 'subpedido:cambio', subPedidoId, pedidoId: sub!.pedido_id,
      estado: 'ACEPTADO', ferianteId,
    });

    await evaluarPedido(sub!.pedido_id);
    return sub!;
  });
}

/** "No tengo". No es gratis ni caro: se registra y baja la prioridad. */
export async function rechazarOferta(subPedidoId: string, ferianteId: string): Promise<void> {
  await enTransaccion(async () => {
    const oferta = await consultarUno<Fila>(
      `SELECT * FROM ofertas
        WHERE sub_pedido_id = ? AND feriante_id = ? AND respuesta IS NULL`,
      subPedidoId, ferianteId);
    if (!oferta) throw new OfertaNoDisponible('No tienes una oferta abierta para este pedido.');

    await ejecutar('UPDATE ofertas SET respuesta = ?, respondida_at = ? WHERE id = ?',
      'RECHAZA', ahora(), oferta.id);
    await ejecutar('UPDATE feriantes SET rechazos = rechazos + 1 WHERE id = ?', ferianteId);
    await registrarEvento('sub_pedido', subPedidoId, 'rechazo',
      { ferianteId, ronda: oferta.ronda });

    // Si ya contestaron todos, no esperamos a que venza la ventana.
    const pendientes = await consultarUno<Fila>(
      `SELECT COUNT(*)::int AS n FROM ofertas
        WHERE sub_pedido_id = ? AND ronda = ? AND respuesta IS NULL`,
      subPedidoId, oferta.ronda);
    if ((pendientes?.n ?? 0) === 0) await avanzarCascada(subPedidoId, oferta.ronda);
  });
}

/**
 * El feriante aceptó pero después no pudo cumplir. El sub-pedido
 * vuelve a la cascada desde la ronda siguiente y se le anota un
 * incumplimiento, que pesa el triple en la reputación.
 */
export async function liberarSubPedido(subPedidoId: string, ferianteId: string): Promise<void> {
  await enTransaccion(async () => {
    const sub = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', subPedidoId);
    if (!sub) throw new Error(`Sub-pedido inexistente: ${subPedidoId}`);
    if (sub.estado !== EstadoSubPedido.ACEPTADO || sub.feriante_id !== ferianteId) {
      throw new OfertaNoDisponible('Este pedido no está aceptado por tú.');
    }

    await ejecutar('UPDATE feriantes SET incumplidos = incumplidos + 1 WHERE id = ?', ferianteId);
    await ejecutar(
      'UPDATE sub_pedidos SET feriante_id = NULL, aceptado_at = NULL WHERE id = ?', subPedidoId);
    await registrarEvento('sub_pedido', subPedidoId, 'liberado',
      { ferianteId, desdeRonda: sub.ronda });

    if (!await intentarSiguienteRonda(subPedidoId, sub.ronda + 1)) {
      await aAutogestion(subPedidoId, 'liberado sin reemplazo');
    }
  });
}

/**
 * Nadie aceptó. El pedido NO se cancela: pasa a la cola del
 * operador, que lo compra personalmente. Este es el fallback que
 * hace que el cliente nunca se quede sin su pedido.
 */
async function aAutogestion(subPedidoId: string, motivo: string): Promise<void> {
  const sub = await cambiarEstadoSubPedido(subPedidoId, EstadoSubPedido.AUTOGESTION,
    { autogestionado: true });
  await registrarEvento('sub_pedido', subPedidoId, 'autogestion', { motivo });
  publicar({ tipo: 'autogestion:nueva', subPedidoId, pedidoId: sub.pedido_id });
  await evaluarPedido(sub.pedido_id);
}

/** Cierra la ronda `ronda` y decide qué sigue. */
async function avanzarCascada(subPedidoId: string, ronda: number): Promise<void> {
  const sub = await consultarUno<Fila>('SELECT * FROM sub_pedidos WHERE id = ?', subPedidoId);
  if (!sub || sub.estado !== EstadoSubPedido.OFERTANDO) return;

  const vencidas = await consultar<Fila>(
    `SELECT * FROM ofertas
      WHERE sub_pedido_id = ? AND ronda = ? AND respuesta IS NULL`,
    subPedidoId, ronda);
  for (const o of vencidas) {
    await ejecutar('UPDATE ofertas SET respuesta = ?, respondida_at = ? WHERE id = ?',
      'TIMEOUT', ahora(), o.id);
    await ejecutar('UPDATE feriantes SET timeouts = timeouts + 1 WHERE id = ?', o.feriante_id);
    publicar({ tipo: 'oferta:cerrada', ferianteId: o.feriante_id, subPedidoId, motivo: 'vencida' });
  }

  if (!await intentarSiguienteRonda(subPedidoId, ronda + 1)) {
    await aAutogestion(subPedidoId, 'cascada agotada');
  }
}

/**
 * Latido del motor: cierra rondas vencidas. Se llama cada segundo
 * desde el servidor, y a mano desde los tests.
 */
export async function tick(): Promise<void> {
  try {
    await expirarPendientes();
  } catch (e) {
    console.error('[tick] expirando pendientes', e);
  }


  const vencidas = await consultar<Fila>(
    `SELECT DISTINCT s.id AS sub_id, o.ronda
       FROM ofertas o
       JOIN sub_pedidos s ON s.id = o.sub_pedido_id
      WHERE o.respuesta IS NULL
        AND o.expira_at <= now()
        AND s.estado = ?
        AND s.ronda = o.ronda`,
    EstadoSubPedido.OFERTANDO,
  );
  for (const v of vencidas) {
    try {
      await enTransaccion(() => avanzarCascada(v.sub_id, v.ronda));
    } catch (e) {
      await registrarEvento('sub_pedido', v.sub_id, 'error en cascada', { error: String(e) });
    }
  }
}

// ============================================================
// Preparación y avance del pedido
// ============================================================

/** El feriante (o el operador) marca el sub-pedido preparado. */
export async function marcarListo(subPedidoId: string): Promise<void> {
  await enTransaccion(async () => {
    const sub = await cambiarEstadoSubPedido(
      subPedidoId, EstadoSubPedido.LISTO, { listo_at: ahora() });
    await evaluarPedido(sub.pedido_id);
  });
}

/**
 * Recalcula el estado del pedido a partir de sus sub-pedidos.
 * Es la única función que hace avanzar el pedido: así no hay dos
 * caminos que puedan dejarlo en un estado inconsistente.
 */
export async function evaluarPedido(pedidoId: string): Promise<void> {
  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  if (!pedido || pedido.estado === EstadoPedido.CANCELADO) return;

  const subs = await consultar<Fila>(
    `SELECT estado FROM sub_pedidos WHERE pedido_id = ? AND estado <> ?`,
    pedidoId, EstadoSubPedido.CANCELADO);
  if (subs.length === 0) return;

  const todos = (...estados: string[]) => subs.every((s) => estados.includes(s.estado));

  if (todos(EstadoSubPedido.RETIRADO)) {
    await cambiarEstadoPedido(pedidoId, EstadoPedido.EN_RUTA);
    return;
  }
  if (todos(EstadoSubPedido.LISTO, EstadoSubPedido.RETIRADO)) {
    if (pedido.estado === EstadoPedido.DESPACHANDO) {
      await cambiarEstadoPedido(pedidoId, EstadoPedido.EN_PREPARACION);
    }
    await cambiarEstadoPedido(pedidoId, EstadoPedido.LISTO_PARA_RETIRO);
    return;
  }
  // Todos los sub-pedidos tienen dueño (feriante o el operador):
  // recién acá tiene sentido llamar a un repartidor, porque recién
  // acá se conocen las paradas del viaje.
  if (todos(EstadoSubPedido.ACEPTADO, EstadoSubPedido.AUTOGESTION,
            EstadoSubPedido.LISTO, EstadoSubPedido.RETIRADO)) {
    if (pedido.estado === EstadoPedido.DESPACHANDO) {
      await cambiarEstadoPedido(pedidoId, EstadoPedido.EN_PREPARACION);
      await crearViaje(pedidoId);
    }
  }
}
