import { ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila } from '../db/index.ts';
import { confirmarPago } from './despacho.ts';
import { configDesdeEntorno, crearPasarelaMercadoPago } from '../pagos/mercadopago.ts';
import type { Pasarela } from '../pagos/pasarela.ts';

export class ErrorPago extends Error {
  codigo: number;
  constructor(codigo: number, msg: string) {
    super(msg);
    this.codigo = codigo;
    this.name = 'ErrorPago';
  }
}

let elegida: Pasarela | null | undefined;

/**
 * La pasarela con la que se cobra: Mercado Pago, si tiene sus
 * credenciales (`MP_ACCESS_TOKEN` y `URL_PUBLICA`).
 *
 * Se resuelve una vez por proceso. Los tests la reemplazan con
 * `fijarPasarela`.
 */
export function pasarela(): Pasarela | null {
  if (elegida !== undefined) return elegida;

  const mp = configDesdeEntorno();
  if (mp) {
    elegida = crearPasarelaMercadoPago(mp);
  } else if ((process.env.PASARELA ?? '').toLowerCase() === 'mercadopago') {
    // Se pidió cobrar y faltan las credenciales.
    const falta = 'MP_ACCESS_TOKEN y URL_PUBLICA';
    if (process.env.NODE_ENV === 'production') {
      // En producción es un error: un pedido sin cobrar no es un
      // pedido gratis, es plata que se pierde.
      throw new ErrorPago(503, `PASARELA=mercadopago pero faltan ${falta}.`);
    }
    // En desarrollo se avisa y se sigue sin pasarela, para poder
    // recorrer el flujo completo antes de tener las credenciales.
    console.warn(
      `[pagos] PASARELA=mercadopago pero faltan ${falta}.\n`
      + '        Se sigue sin cobrar, que es lo que corresponde en desarrollo.');
    elegida = null;
  } else {
    elegida = null;
  }
  return elegida;
}

export const fijarPasarela = (p: Pasarela | null): void => { elegida = p; };
/** Vuelve a mirar el entorno. Para los tests. */
export const olvidarPasarela = (): void => { elegida = undefined; };

export const pasarelaConfigurada = (): boolean => pasarela() !== null;

/**
 * Arranca el cobro de un pedido.
 *
 * Devuelve la URL de la pasarela a la que hay que mandar al cliente. Si el
 * pedido ya tiene un cobro abierto se devuelve el mismo, para que
 * volver atrás en la app no genere dos órdenes de pago.
 */
type PagoIniciado = { url: string | null; pagoId: string; yaPagado: boolean };

/** Inicios de pago en vuelo, por pedido. */
const iniciando = new Map<string, Promise<PagoIniciado>>();

/**
 * Dos toques al botón de pagar llegan como dos peticiones juntas.
 * Las dos veían que no había cobro abierto —el primero todavía
 * estaba hablando con la pasarela— y creaban uno cada una. La
 * segunda espera a la primera y recibe el mismo cobro.
 */
export function iniciarPago(pedidoId: string, email: string): Promise<PagoIniciado> {
  const enVuelo = iniciando.get(pedidoId);
  if (enVuelo) return enVuelo;
  const promesa = iniciarPagoDeVerdad(pedidoId, email)
    .finally(() => iniciando.delete(pedidoId));
  iniciando.set(pedidoId, promesa);
  return promesa;
}

async function iniciarPagoDeVerdad(pedidoId: string, email: string): Promise<PagoIniciado> {
  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  if (!pedido) throw new ErrorPago(404, 'Pedido no encontrado.');

  if (pedido.estado !== 'PENDIENTE_PAGO') {
    if (pedido.estado === 'EXPIRADO') {
      throw new ErrorPago(410, 'El pedido expiró. Ármalo de nuevo.');
    }
    // Ya estaba pagado: la app puede seguir al seguimiento.
    return { url: null, pagoId: '', yaPagado: true };
  }

  // El correo del checkout es el único que tenemos para un eventual
  // reembolso: si el pedido no lo traía, se guarda ahora.
  if (email && !pedido.cliente_email) {
    await ejecutar('UPDATE pedidos SET cliente_email = ? WHERE id = ?', email, pedidoId);
  }

  const abierto = await consultarUno<Fila>(
    `SELECT * FROM pagos WHERE pedido_id = ? AND estado = 'INICIADO' AND url_pago IS NOT NULL
      ORDER BY creado_at DESC LIMIT 1`, pedidoId);
  if (abierto) return { url: abierto.url_pago, pagoId: abierto.id, yaPagado: false };

  const via = pasarela();
  const pagoId = id();
  // La orden de comercio tiene que ser única para siempre: la
  // pasarela rechaza una repetida, que es justamente lo que impide
  // cobrar dos veces el mismo pedido por un reintento.
  const ordenComercio = `feria-${pedido.numero}-${pagoId.slice(0, 8)}`;

  if (!via) {
    // Sin pasarela configurada no se puede cobrar. En desarrollo se
    // deja pasar para poder probar el flujo completo; en producción
    // es un error, no un pedido gratis.
    if (process.env.NODE_ENV === 'production') {
      throw new ErrorPago(503, 'La pasarela de pago no está configurada.');
    }
    await ejecutar(
      `INSERT INTO pagos (id, pedido_id, proveedor, orden_comercio, monto, estado, medio)
       VALUES (?, ?, 'dev', ?, ?, 'INICIADO', 'dev')`,
      pagoId, pedidoId, ordenComercio, pedido.total_venta);
    return { url: null, pagoId, yaPagado: false };
  }

  await ejecutar(
    `INSERT INTO pagos (id, pedido_id, proveedor, orden_comercio, monto, estado)
     VALUES (?, ?, ?, ?, ?, 'INICIADO')`,
    pagoId, pedidoId, via.nombre, ordenComercio, pedido.total_venta);

  const creado = await via.crear({
    ordenComercio,
    monto: pedido.total_venta,
    concepto: `Feria — pedido #${pedido.numero}`,
    email,
  });

  await ejecutar(
    'UPDATE pagos SET referencia_externa = ?, url_pago = ? WHERE id = ?',
    creado.referencia, creado.url, pagoId);
  await registrarEvento('pago', pagoId, 'iniciado',
    { pedidoId, monto: pedido.total_venta, ordenComercio, pasarela: via.nombre });

  return { url: creado.url, pagoId, yaPagado: false };
}

/**
 * Confirma un pago a partir de lo que avisó la pasarela.
 *
 * `referencia` es el id del payment de Mercado Pago. Nunca se cree lo que dice el aviso: llega por HTTP desde
 * fuera y cualquiera puede inventarlo. Lo único que vale es
 * preguntarle a la pasarela con una petición nuestra.
 */
export async function confirmarDesdePasarela(
  referencia: string,
): Promise<{ pagado: boolean; pedidoId?: string }> {
  const via = pasarela();
  if (!via) throw new ErrorPago(503, 'La pasarela de pago no está configurada.');
  if (!referencia) throw new ErrorPago(400, 'Falta la referencia del pago.');

  const estado = await via.consultar(referencia);
  const pago = await consultarUno<Fila>(
    'SELECT * FROM pagos WHERE orden_comercio = ?', estado.ordenComercio);
  if (!pago) throw new ErrorPago(404, 'No conocemos esa orden de pago.');

  if (pago.estado === 'PAGADO') return { pagado: true, pedidoId: pago.pedido_id };

  if (!estado.pagado) {
    // Pendiente no es rechazado: una transferencia en curso todavía
    // puede llegar, y la pasarela vuelve a avisar cuando se define.
    if (estado.cerrado) {
      await ejecutar('UPDATE pagos SET estado = ? WHERE id = ?', 'RECHAZADO', pago.id);
      await registrarEvento('pago', pago.id, 'rechazado', { pasarela: estado.crudo });
    }
    return { pagado: false, pedidoId: pago.pedido_id };
  }

  // Que el monto cobrado sea el del pedido. Si no coincide, algo se
  // manipuló en el camino y no se despacha nada.
  if (estado.monto !== pago.monto) {
    await registrarEvento('pago', pago.id, 'monto no coincide',
      { esperado: pago.monto, recibido: estado.monto });
    throw new ErrorPago(409, 'El monto pagado no coincide con el del pedido.');
  }

  await enTransaccion(async () => {
    // La referencia se reescribe: en Mercado Pago el id con el que
    // se creó el cobro (la preferencia) no es contra el que se
    // reembolsa. El reembolso va contra este.
    await ejecutar(
      `UPDATE pagos SET estado = 'PAGADO', medio = ?, referencia_externa = ?,
                        confirmado_at = ? WHERE id = ?`,
      estado.medio, estado.referencia, ahora(), pago.id);
    await registrarEvento('pago', pago.id, 'pagado',
      { medio: estado.medio, monto: estado.monto, pasarela: via.nombre });
  });

  await confirmarPago(pago.pedido_id);
  return { pagado: true, pedidoId: pago.pedido_id };
}

/**
 * Confirmación de desarrollo, sin pasarela.
 *
 * Existe para poder recorrer el flujo completo sin credenciales de
 * la pasarela. Se apaga sola en producción.
 */
export async function confirmarEnDesarrollo(pagoId: string): Promise<boolean> {
  if (process.env.NODE_ENV === 'production') {
    throw new ErrorPago(404, 'Ruta no encontrada.');
  }
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  if (!pago) throw new ErrorPago(404, 'Pago no encontrado.');
  if (pago.estado === 'PAGADO') return true;

  await ejecutar(
    `UPDATE pagos SET estado = 'PAGADO', confirmado_at = ? WHERE id = ?`, ahora(), pagoId);
  await confirmarPago(pago.pedido_id);
  return true;
}

export async function pagosDe(pedidoId: string): Promise<Fila[]> {
  return consultar(
    'SELECT id, proveedor, monto, medio, estado, creado_at, confirmado_at FROM pagos WHERE pedido_id = ? ORDER BY creado_at',
    pedidoId);
}

/**
 * Revisa los cobros abiertos preguntándole a la pasarela.
 *
 * El webhook es una optimización, no la fuente de verdad. Se pierde
 * más seguido de lo que uno cree: Mercado Pago deshabilita el aviso
 * después de varios fallos seguidos, un despliegue en el momento
 * justo se come uno, y en desarrollo directamente no llega porque
 * `localhost` no existe para nadie más.
 *
 * Sin esto, un cliente que pagó se queda mirando «esperando el
 * pago» mientras la plata ya salió de su cuenta. Con esto el
 * sistema se entera igual, con unos segundos de atraso.
 *
 * Solo mira cobros con unos segundos de vida —antes de eso el
 * cliente todavía está en el checkout— y deja de mirarlos cuando ya
 * no tiene sentido: nadie paga un checkout de hace una hora.
 */
export async function revisarCobrosAbiertos(
  opciones: { desdeSegundos?: number; hastaMinutos?: number } = {},
): Promise<{ revisados: number; confirmados: number }> {
  const via = pasarela();
  if (!via) return { revisados: 0, confirmados: 0 };

  const desde = opciones.desdeSegundos ?? 20;
  const hasta = opciones.hastaMinutos ?? 60;

  const abiertos = await consultar<Fila>(
    `SELECT id, referencia_externa FROM pagos
      WHERE estado = 'INICIADO'
        AND proveedor = ?
        AND referencia_externa IS NOT NULL
        AND creado_at <= now() - make_interval(secs => ?)
        AND creado_at >  now() - make_interval(mins => ?)
      ORDER BY creado_at
      LIMIT 20`,
    via.nombre, desde, hasta);

  let confirmados = 0;
  for (const pago of abiertos) {
    try {
      const r = await revisarCobro(pago.id);
      if (r.pagado) confirmados++;
    } catch (e) {
      // Que falle uno no puede frenar la revisión de los demás.
      console.warn('[pagos] no se pudo revisar', pago.id, (e as Error).message);
    }
  }
  return { revisados: abiertos.length, confirmados };
}

/**
 * Revisa UN cobro contra la pasarela.
 *
 * Es lo mismo que hace el webhook, pero preguntando nosotros. La
 * app lo llama mientras espera, así el cliente no depende de que el
 * aviso llegue.
 */
export async function revisarCobro(pagoId: string): Promise<{ pagado: boolean }> {
  const via = pasarela();
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  if (!pago) throw new ErrorPago(404, 'Pago no encontrado.');
  if (pago.estado === 'PAGADO') return { pagado: true };
  if (!via || pago.proveedor !== via.nombre || !pago.referencia_externa) {
    return { pagado: false };
  }

  // En Mercado Pago la referencia guardada al crear es la de la
  // preferencia, y la API de pagos no la conoce: hay que buscar el
  // pago que nació de ella.
  const referencia = via.nombre === 'mercadopago'
    ? await pagoDeLaPreferencia(via, pago)
    : pago.referencia_externa;
  if (!referencia) return { pagado: false };

  const r = await confirmarDesdePasarela(referencia);
  return { pagado: r.pagado };
}

/**
 * Busca el pago que nació de una preferencia de Mercado Pago.
 *
 * La búsqueda es por `external_reference`, que es nuestra orden de
 * comercio: es el único hilo entre el checkout que creamos y el
 * pago que el cliente terminó haciendo.
 */
async function pagoDeLaPreferencia(via: Pasarela, pago: Fila): Promise<string | null> {
  const buscar = (via as any).buscarPorOrden;
  if (typeof buscar !== 'function') return pago.referencia_externa;
  const encontrado = await buscar(pago.orden_comercio);
  return encontrado ?? null;
}
