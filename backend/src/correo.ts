/**
 * Envío de correos.
 *
 * Igual que `sms.ts`: en desarrollo escribe en la consola, en
 * producción sale por un proveedor. Se usa Resend por REST, sin
 * SDK: es una sola petición. Se elige por variables de entorno.
 */

export type ResultadoCorreo = { enviado: boolean; proveedor: string; detalle?: string };

const hayResend = () => !!(process.env.RESEND_API_KEY && process.env.CORREO_REMITENTE);

export const proveedorCorreo = (): string => (hayResend() ? 'resend' : 'consola');

type Transporte = (a: string, asunto: string, texto: string) => Promise<ResultadoCorreo>;

const porResend: Transporte = async (a, asunto, texto) => {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.CORREO_REMITENTE, to: [a], subject: asunto, text: texto,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const detalle = await r.text().catch(() => '');
    // El detalle no viaja al cliente: puede traer datos de la cuenta.
    console.error('[correo] Resend respondió', r.status, detalle.slice(0, 300));
    return { enviado: false, proveedor: 'resend', detalle: `HTTP ${r.status}` };
  }
  return { enviado: true, proveedor: 'resend' };
};

let transporte: Transporte | null = null;
/** Para los tests: ver qué se mandó sin salir a internet. */
export const fijarTransporteCorreo = (t: Transporte | null): void => { transporte = t; };

export async function enviarCorreo(a: string, asunto: string, texto: string): Promise<ResultadoCorreo> {
  if (transporte) return transporte(a, asunto, texto);
  if (hayResend()) {
    try {
      return await porResend(a, asunto, texto);
    } catch (e) {
      console.error('[correo] no se pudo enviar:', (e as Error).message);
      return { enviado: false, proveedor: 'resend', detalle: 'sin respuesta' };
    }
  }
  console.log(`\n  ┌─ Correo a ${a} · ${asunto}`);
  console.log(`  │  ${texto}`);
  console.log(`  └─ (sin proveedor de correo configurado: no se envió de verdad)\n`);
  return { enviado: true, proveedor: 'consola' };
}
