import { createHmac } from 'node:crypto';

import { CONFIG } from '../config.ts';

import type {
  CobroCreado, DatosCobro, DatosReembolso, EstadoCobro, Pasarela, ReembolsoCreado,
} from './pasarela.ts';

/**
 * Cliente de Flow.cl.
 *
 * Flow es un agregador chileno: con una sola integración quedan
 * disponibles Webpay (tarjetas), transferencia bancaria y Servipag.
 * La transferencia cobra bastante menos comisión que la tarjeta, y
 * en el barrio es un medio de pago normal.
 *
 * El checkout es alojado: el cliente paga en la página de Flow y
 * vuelve. Nunca pasa un número de tarjeta por acá, así que el
 * sistema queda fuera del alcance de PCI.
 */

export type ConfigFlow = {
  apiKey: string;
  secretKey: string;
  /** https://sandbox.flow.cl/api mientras se prueba. */
  base: string;
  /** Adónde llama Flow para confirmar (tiene que ser público). */
  urlConfirmacion: string;
  /** Adónde vuelve el cliente después de pagar. */
  urlRetorno: string;
};

export function configDesdeEntorno(): ConfigFlow | null {
  const { FLOW_API_KEY, FLOW_SECRET_KEY, FLOW_BASE } = process.env;
  const publica = CONFIG.urlPublica;
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY || !publica) return null;
  return {
    apiKey: FLOW_API_KEY,
    secretKey: FLOW_SECRET_KEY,
    base: FLOW_BASE ?? 'https://www.flow.cl/api',
    urlConfirmacion: `${publica}/webhooks/flow/confirmacion`,
    urlRetorno: `${publica}/pagos/retorno`,
  };
}

/**
 * Firma que exige Flow: los parámetros ordenados alfabéticamente,
 * concatenados como nombre+valor, con HMAC-SHA256 y la secret key.
 *
 * El orden importa. Si se firma en otro orden Flow rechaza la
 * petición sin decir por qué.
 */
export function firmar(params: Record<string, string | number>, secretKey: string): string {
  const cadena = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHmac('sha256', secretKey).update(cadena).digest('hex');
}

type Transporte = (url: string, cuerpo: URLSearchParams | null) => Promise<any>;

const porHttp: Transporte = async (url, cuerpo) => {
  const r = await fetch(url, {
    method: cuerpo ? 'POST' : 'GET',
    headers: cuerpo ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
    body: cuerpo ?? undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const texto = await r.text();
  let datos: any;
  try {
    datos = JSON.parse(texto);
  } catch {
    throw new Error(`Flow devolvió algo que no es JSON (HTTP ${r.status}): ${texto.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`Flow: ${datos?.message ?? `HTTP ${r.status}`}`);
  return datos;
};

let transporte: Transporte = porHttp;
export const fijarTransporteFlow = (t: Transporte): void => { transporte = t; };
export const restaurarTransporteFlow = (): void => { transporte = porHttp; };

export type PagoCreado = { url: string; token: string; flowOrder: number };

/** Crea la orden de pago y devuelve la URL a la que mandar al cliente. */
export async function crearPago(cfg: ConfigFlow, datos: {
  ordenComercio: string;
  monto: number;
  concepto: string;
  email: string;
}): Promise<PagoCreado> {
  const params: Record<string, string | number> = {
    apiKey: cfg.apiKey,
    commerceOrder: datos.ordenComercio,
    subject: datos.concepto,
    currency: 'CLP',
    amount: Math.round(datos.monto),
    email: datos.email,
    urlConfirmation: cfg.urlConfirmacion,
    urlReturn: cfg.urlRetorno,
  };
  const cuerpo = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]));
  cuerpo.set('s', firmar(params, cfg.secretKey));

  const r = await transporte(`${cfg.base}/payment/create`, cuerpo);
  if (!r?.url || !r?.token) throw new Error('Flow no devolvió una URL de pago.');
  // Flow entrega la URL y el token por separado; se juntan acá.
  return { url: `${r.url}?token=${r.token}`, token: r.token, flowOrder: r.flowOrder };
}

export type EstadoPagoFlow = {
  pagado: boolean;
  estado: number;
  medio: string | null;
  ordenComercio: string;
  monto: number;
};

/**
 * Le pregunta a Flow cómo terminó el pago.
 *
 * Se llama SIEMPRE, incluso cuando el callback dice que salió bien:
 * el callback llega por HTTP desde fuera y no se puede confiar en
 * su contenido. Lo único confiable es la respuesta de Flow a una
 * petición firmada por nosotros.
 */
export async function consultarPago(cfg: ConfigFlow, token: string): Promise<EstadoPagoFlow> {
  const params = { apiKey: cfg.apiKey, token };
  const url = new URL(`${cfg.base}/payment/getStatus`);
  url.searchParams.set('apiKey', cfg.apiKey);
  url.searchParams.set('token', token);
  url.searchParams.set('s', firmar(params, cfg.secretKey));

  const r = await transporte(url.toString(), null);
  return {
    // status 2 = pagado. 1 pendiente, 3 rechazado, 4 anulado.
    pagado: r?.status === 2,
    estado: r?.status ?? 0,
    medio: r?.paymentData?.media ?? null,
    ordenComercio: r?.commerceOrder,
    monto: Math.round(Number(r?.amount ?? 0)),
  };
}

export type ReembolsoCreado = { token: string; estado: number; aceptado: boolean };

/**
 * Devuelve plata al cliente.
 *
 * Flow procesa el reembolso contra el pago original; el dinero puede
 * tardar días en llegar a la tarjeta, así que lo que se guarda es
 * que se pidió, no que ya llegó.
 */
export async function reembolsar(cfg: ConfigFlow, datos: {
  ordenReembolso: string;
  ordenComercioOriginal: string;
  emailCliente: string;
  monto: number;
}): Promise<ReembolsoCreado> {
  const params: Record<string, string | number> = {
    apiKey: cfg.apiKey,
    refundCommerceOrder: datos.ordenReembolso,
    receiverEmail: datos.emailCliente,
    amount: Math.round(datos.monto),
    urlCallBack: `${cfg.urlConfirmacion}-reembolso`,
    commerceTrxId: datos.ordenComercioOriginal,
  };
  const cuerpo = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]));
  cuerpo.set('s', firmar(params, cfg.secretKey));

  const r = await transporte(`${cfg.base}/refund/create`, cuerpo);
  return {
    token: r?.token ?? '',
    estado: r?.status ?? 0,
    // 1 = creado, 2 = aceptado, 3 = rechazado, 4 = cancelado.
    aceptado: r?.status === 1 || r?.status === 2,
  };
}

// ============================================================
// Adaptador a la interfaz común
// ============================================================

/**
 * Flow visto como una `Pasarela` cualquiera.
 *
 * Lo de arriba sigue igual porque es lo que hablan los tests y es
 * donde viven las rarezas de Flow —la firma por orden alfabético,
 * los estados numerados—. Esto solo las traduce.
 */
export function crearPasarelaFlow(cfg: ConfigFlow): Pasarela {
  return {
    nombre: 'flow',

    async crear(datos: DatosCobro): Promise<CobroCreado> {
      const r = await crearPago(cfg, {
        ordenComercio: datos.ordenComercio,
        monto: datos.monto,
        concepto: datos.concepto,
        email: datos.email,
      });
      return { url: r.url, referencia: r.token };
    },

    async consultar(referencia: string): Promise<EstadoCobro> {
      const e = await consultarPago(cfg, referencia);
      return {
        pagado: e.pagado,
        // 3 = rechazado, 4 = anulado. 1 sigue pendiente.
        cerrado: e.estado === 3 || e.estado === 4,
        medio: e.medio,
        ordenComercio: e.ordenComercio,
        monto: e.monto,
        // En Flow el token identifica el pago de principio a fin.
        referencia,
        crudo: { status: e.estado },
      };
    },

    async reembolsar(datos: DatosReembolso): Promise<ReembolsoCreado> {
      const r = await reembolsar(cfg, {
        ordenReembolso: datos.ordenReembolso,
        ordenComercioOriginal: datos.ordenComercioOriginal,
        emailCliente: datos.emailCliente,
        monto: datos.monto,
      });
      return { referencia: r.token, aceptado: r.aceptado };
    },
  };
}
