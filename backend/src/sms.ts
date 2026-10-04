/**
 * Envío de SMS.
 *
 * En desarrollo escribe el código en la consola; en producción sale
 * por Twilio. Se elige por variables de entorno, así que pasar de
 * uno a otro no toca código.
 */

export type ResultadoSms = { enviado: boolean; proveedor: string; detalle?: string };

const hayTwilio = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

export const proveedorSms = (): string => (hayTwilio() ? 'twilio' : 'consola');

/**
 * Twilio por REST, sin SDK: es una sola petición con autenticación
 * básica y un cuerpo de formulario.
 */
async function porTwilio(a: string, texto: string): Promise<ResultadoSms> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const cuerpo = new URLSearchParams({
    To: a,
    From: process.env.TWILIO_FROM!,
    Body: texto,
  });

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: cuerpo,
    signal: AbortSignal.timeout(10_000),
  });

  if (!r.ok) {
    const detalle = await r.text().catch(() => '');
    // No se propaga el detalle al cliente: puede traer datos de la
    // cuenta de Twilio.
    console.error('[sms] Twilio respondió', r.status, detalle.slice(0, 300));
    return { enviado: false, proveedor: 'twilio', detalle: `HTTP ${r.status}` };
  }
  return { enviado: true, proveedor: 'twilio' };
}

export async function enviarSms(a: string, texto: string): Promise<ResultadoSms> {
  if (hayTwilio()) return porTwilio(a, texto);

  console.log(`\n  ┌─ SMS a ${a}`);
  console.log(`  │  ${texto}`);
  console.log(`  └─ (sin Twilio configurado: no se envió de verdad)\n`);
  return { enviado: true, proveedor: 'consola' };
}
