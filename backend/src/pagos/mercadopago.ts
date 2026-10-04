import type {
  CobroCreado, DatosCobro, DatosReembolso, EstadoCobro, Pasarela, ReembolsoCreado,
} from './pasarela.ts';

/**
 * Cliente de Mercado Pago (Checkout Pro).
 *
 * El checkout es alojado: el cliente paga en la página de Mercado
 * Pago y vuelve. Nunca pasa un número de tarjeta por acá, así que
 * el sistema queda fuera del alcance de PCI.
 *
 * La diferencia importante con Flow: acá hay DOS identificadores.
 * Primero se crea una «preferencia» (el checkout), y recién cuando
 * alguien paga nace un «payment» con otro id. El webhook avisa del
 * segundo, y el reembolso va contra el segundo. El hilo entre los
 * dos es `external_reference`, que es nuestra orden de comercio.
 */

export type ConfigMercadoPago = {
  /**
   * Access token de la aplicación.
   *
   * Si es de un usuario de prueba, todo el entorno es de prueba: no
   * hay que elegir nada más. Mercado Pago dejó de usar el prefijo
   * `TEST-` para distinguirlos, así que mirar la cadena ya no dice
   * nada — las credenciales de sandbox hoy también empiezan con
   * `APP_USR-`.
   */
  accessToken: string;
  base: string;
  /** Adónde avisa Mercado Pago (tiene que ser público). */
  urlNotificacion: string;
  /** Adónde vuelve el cliente después de pagar. */
  urlRetorno: string;
  /**
   * Si Mercado Pago puede alcanzar nuestras URLs.
   *
   * En desarrollo son `localhost` y no puede: hay que omitir las
   * que exige que sean públicas, o rechaza la preferencia entera.
   */
  publica?: boolean;
  /**
   * Usa el checkout de `sandbox.mercadopago.cl`.
   *
   * Solo para credenciales viejas con prefijo `TEST-`. Con un
   * usuario de prueba moderno el checkout normal ya es de prueba.
   */
  sandboxViejo?: boolean;
};

export function configDesdeEntorno(): ConfigMercadoPago | null {
  const { MP_ACCESS_TOKEN, MP_BASE, MP_SANDBOX, URL_PUBLICA } = process.env;
  if (!MP_ACCESS_TOKEN || !URL_PUBLICA) return null;
  return {
    accessToken: MP_ACCESS_TOKEN,
    sandboxViejo: MP_SANDBOX === '1',
    base: MP_BASE ?? 'https://api.mercadopago.com',
    urlNotificacion: `${URL_PUBLICA}/webhooks/mercadopago`,
    urlRetorno: `${URL_PUBLICA}/pagos/retorno`,
    publica: esPublica(URL_PUBLICA),
  };
}

/**
 * ¿Mercado Pago puede alcanzar esta dirección?
 *
 * En desarrollo `URL_PUBLICA` apunta a `localhost`, que para MP no
 * existe. No es un detalle cosmético: con una URL así rechaza la
 * preferencia entera con «auto_return invalid», y no se puede
 * cobrar nada.
 */
export function esPublica(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return !/^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
      .test(hostname);
  } catch {
    return false;
  }
}

type Transporte = (
  url: string,
  opciones: { metodo: 'GET' | 'POST'; cuerpo?: unknown; cabeceras: Record<string, string> },
) => Promise<any>;

const porHttp: Transporte = async (url, { metodo, cuerpo, cabeceras }) => {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(15_000),
  });
  const texto = await r.text();
  let datos: any;
  try {
    datos = texto ? JSON.parse(texto) : {};
  } catch {
    throw new Error(
      `Mercado Pago devolvió algo que no es JSON (HTTP ${r.status}): ${texto.slice(0, 200)}`);
  }
  if (!r.ok) {
    // MP trae el detalle útil en `message`; `cause` tiene el código.
    const detalle = datos?.message ?? datos?.error ?? `HTTP ${r.status}`;
    throw new Error(`Mercado Pago: ${detalle}`);
  }
  return datos;
};

let transporte: Transporte = porHttp;
export const fijarTransporteMP = (t: Transporte): void => { transporte = t; };
export const restaurarTransporteMP = (): void => { transporte = porHttp; };

/**
 * Cómo se traduce el estado de Mercado Pago.
 *
 * `approved` es lo único que cuenta como pagado. `in_process` y
 * `pending` son plata que todavía puede llegar —una transferencia
 * en curso— así que el pedido NO se despacha pero tampoco se
 * cierra: el webhook vuelve a avisar cuando se define.
 */
const TERMINADOS = new Set(['rejected', 'cancelled', 'refunded', 'charged_back']);

/** La traducción a nuestros nombres; `null` si MP no dijo cuál. */
function medioLegible(pago: any): string | null {
  const tipo = pago?.payment_type_id;
  if (!tipo) return pago?.payment_method_id ?? null;
  const nombres: Record<string, string> = {
    credit_card: 'tarjeta de crédito',
    debit_card: 'tarjeta de débito',
    prepaid_card: 'tarjeta prepago',
    bank_transfer: 'transferencia',
    account_money: 'saldo Mercado Pago',
    ticket: 'cupón de pago',
  };
  return nombres[tipo] ?? `${tipo}${pago.payment_method_id ? ` (${pago.payment_method_id})` : ''}`;
}

/**
 * La pasarela de Mercado Pago, con un extra sobre la interfaz común.
 *
 * `buscarPorOrden` no está en `Pasarela` porque es un problema que
 * solo tiene Mercado Pago: la preferencia y el pago son dos cosas
 * distintas, y sin webhook no hay forma de saber el id del segundo.
 * Buscando por nuestra orden de comercio sí.
 */
export type PasarelaMercadoPago = Pasarela & {
  buscarPorOrden(ordenComercio: string): Promise<string | null>;
};

export function crearPasarelaMercadoPago(cfg: ConfigMercadoPago): PasarelaMercadoPago {
  const auth = { authorization: `Bearer ${cfg.accessToken}` };

  return {
    nombre: 'mercadopago',

    /**
     * El pago que nació de una preferencia nuestra.
     *
     * Si hubo varios intentos —tarjeta rechazada y después
     * transferencia— se queda con el aprobado; si ninguno lo está,
     * con el más reciente, que es el que todavía puede definirse.
     */
    async buscarPorOrden(ordenComercio: string): Promise<string | null> {
      const url = new URL(`${cfg.base}/v1/payments/search`);
      url.searchParams.set('external_reference', ordenComercio);
      url.searchParams.set('sort', 'date_created');
      url.searchParams.set('criteria', 'desc');
      url.searchParams.set('limit', '10');

      const r = await transporte(url.toString(), { metodo: 'GET', cabeceras: auth });
      const encontrados: any[] = Array.isArray(r?.results) ? r.results : [];
      if (encontrados.length === 0) return null;

      const aprobado = encontrados.find((p) => p?.status === 'approved');
      return String((aprobado ?? encontrados[0]).id);
    },

    async crear(datos: DatosCobro): Promise<CobroCreado> {
      const preferencia = {
        items: [{
          id: datos.ordenComercio,
          title: datos.concepto,
          quantity: 1,
          unit_price: Math.round(datos.monto),
          currency_id: 'CLP',
        }],
        // El hilo entre la preferencia y el pago que nazca de ella.
        external_reference: datos.ordenComercio,
        payer: datos.email ? { email: datos.email } : undefined,
        // Con `localhost` MP rechaza la preferencia entera, así que
        // en desarrollo se omiten. No se pierde nada: el servidor le
        // pregunta por los cobros abiertos igual, y el cliente
        // vuelve solo desde el navegador.
        notification_url: cfg.publica ? cfg.urlNotificacion : undefined,
        back_urls: cfg.publica
          ? { success: cfg.urlRetorno, pending: cfg.urlRetorno, failure: cfg.urlRetorno }
          : undefined,
        auto_return: cfg.publica ? 'approved' : undefined,
        // Sin cuotas: el margen de la feria no aguanta el costo.
        payment_methods: { installments: 1 },
        statement_descriptor: 'FERIA',
      };

      const r = await transporte(`${cfg.base}/checkout/preferences`, {
        metodo: 'POST', cuerpo: preferencia, cabeceras: auth,
      });

      // MP devuelve las dos URLs siempre. La buena es `init_point`:
      // lo que hace que el cobro sea de prueba son las credenciales,
      // no la dirección. `sandbox_init_point` queda para las
      // credenciales viejas con prefijo TEST-.
      const url = cfg.sandboxViejo
        ? (r?.sandbox_init_point ?? r?.init_point)
        : (r?.init_point ?? r?.sandbox_init_point);
      if (!url || !r?.id) throw new Error('Mercado Pago no devolvió una URL de pago.');
      return { url, referencia: String(r.id) };
    },

    async consultar(referencia: string): Promise<EstadoCobro> {
      const pago = await transporte(
        `${cfg.base}/v1/payments/${encodeURIComponent(referencia)}`,
        { metodo: 'GET', cabeceras: auth });

      const estado = String(pago?.status ?? '');
      return {
        pagado: estado === 'approved',
        cerrado: TERMINADOS.has(estado),
        medio: medioLegible(pago),
        ordenComercio: String(pago?.external_reference ?? ''),
        // `transaction_amount` es lo que pagó el cliente; CLP no
        // tiene decimales pero la API los manda igual.
        monto: Math.round(Number(pago?.transaction_amount ?? 0)),
        referencia: String(pago?.id ?? referencia),
        crudo: { status: estado, detalle: pago?.status_detail },
      };
    },

    async reembolsar(datos: DatosReembolso): Promise<ReembolsoCreado> {
      // El reembolso va contra el payment, no contra la preferencia.
      // `X-Idempotency-Key` evita devolver dos veces si se reintenta.
      const r = await transporte(
        `${cfg.base}/v1/payments/${encodeURIComponent(datos.referenciaPago)}/refunds`,
        {
          metodo: 'POST',
          cuerpo: { amount: Math.round(datos.monto) },
          cabeceras: { ...auth, 'X-Idempotency-Key': datos.ordenReembolso },
        });

      const estado = String(r?.status ?? '');
      return {
        referencia: String(r?.id ?? ''),
        aceptado: estado === 'approved' || estado === 'in_process' || estado === 'pending',
      };
    },
  };
}

/**
 * Qué pago avisa una notificación de Mercado Pago.
 *
 * MP tiene varios formatos según la antigüedad de la integración:
 * `?type=payment&data.id=123`, `?topic=payment&id=123`, y el cuerpo
 * JSON `{ type, data: { id } }`. Se aceptan todos y se ignora
 * cualquier otro tipo de aviso (hay avisos de planes, facturas y
 * contracargos que no nos interesan).
 */
export function pagoAvisado(
  consulta: URLSearchParams, cuerpo: any,
): string | null {
  const tipo = consulta.get('type') ?? consulta.get('topic') ?? cuerpo?.type ?? cuerpo?.topic;
  if (tipo && tipo !== 'payment') return null;

  const id = consulta.get('data.id')
    ?? consulta.get('id')
    ?? cuerpo?.data?.id
    ?? cuerpo?.id;
  const texto = id == null ? '' : String(id).trim();
  return /^[0-9]+$/.test(texto) ? texto : null;
}
