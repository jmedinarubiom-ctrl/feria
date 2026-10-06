/**
 * Envío de correos.
 *
 * Igual que `sms.ts`: sin nada configurado escribe en la consola,
 * que sirve para desarrollar. Para que el correo llegue de verdad
 * hay dos caminos, y se elige por variables de entorno:
 *
 *  - **SMTP** (`CORREO_SMTP_USUARIO` y `CORREO_SMTP_CLAVE`): manda
 *    desde una casilla que ya existe. Con Gmail y una «contraseña
 *    de aplicación» funciona sin dominio propio y sin pagar; Gmail
 *    deja mandar unos 500 correos al día, que para partir sobra.
 *  - **Resend** (`RESEND_API_KEY`): para cuando haya dominio propio
 *    y más volumen.
 *
 * Si están los dos, gana SMTP.
 */

import { paraElRegistro } from './sms.ts';

export type ResultadoCorreo = { enviado: boolean; proveedor: string; detalle?: string };

const hayResend = () => !!(process.env.RESEND_API_KEY && process.env.CORREO_REMITENTE);
const haySmtp = () => !!(process.env.CORREO_SMTP_USUARIO && process.env.CORREO_SMTP_CLAVE);

export const proveedorCorreo = (): string =>
  haySmtp() ? 'smtp' : hayResend() ? 'resend' : 'consola';

type Transporte = (a: string, asunto: string, texto: string, html?: string) => Promise<ResultadoCorreo>;

const porResend: Transporte = async (a, asunto, texto, html) => {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.CORREO_REMITENTE, to: [a], subject: asunto, text: texto,
      ...(html ? { html } : {}),
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

/**
 * Por SMTP, con nodemailer. Los valores por defecto son los de
 * Gmail; con otra casilla se cambian el servidor y el puerto.
 */
const porSmtp: Transporte = async (a, asunto, texto, html) => {
  const { default: nodemailer } = await import('nodemailer');
  const usuario = process.env.CORREO_SMTP_USUARIO!;
  const puerto = Number(process.env.CORREO_SMTP_PUERTO ?? 465);
  const cartero = nodemailer.createTransport({
    host: process.env.CORREO_SMTP_SERVIDOR ?? 'smtp.gmail.com',
    port: puerto,
    // 465 cifra desde el primer byte; en los demás puertos se
    // cifra apenas el servidor lo ofrece (STARTTLS).
    secure: puerto === 465,
    // Las contraseñas de aplicación de Google se muestran con
    // espacios («abcd efgh ijkl mnop») y así se suelen pegar.
    auth: { user: usuario, pass: process.env.CORREO_SMTP_CLAVE!.replace(/\s+/g, '') },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await cartero.sendMail({
      from: process.env.CORREO_REMITENTE || `Feria App <${usuario}>`,
      to: a,
      subject: asunto,
      text: texto,
      // Con las dos versiones —texto y HTML— el correo se parece a
      // los que manda cualquier servicio serio. Uno de puro texto
      // con un número suelto es justo como se ven los de spam.
      ...(html ? { html } : {}),
    });
    return { enviado: true, proveedor: 'smtp' };
  } catch (e: any) {
    // El detalle queda en el registro, no viaja al cliente.
    console.error('[correo] SMTP falló:', e?.code ?? '', e?.responseCode ?? '', e?.message ?? e);
    return { enviado: false, proveedor: 'smtp', detalle: explicarSmtp(e) };
  }
};

/** Lo que conviene revisar según cómo falló. Para `npm run probar-correo`. */
function explicarSmtp(e: any): string {
  if (e?.code === 'EAUTH' || e?.responseCode === 535) {
    return 'El servidor rechazó el usuario o la clave. Con Gmail tiene que ser una '
      + '«contraseña de aplicación», no la clave normal de la cuenta.';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(e?.code)) {
    return 'No se pudo conectar con el servidor de correo. Revisa el servidor, el puerto y la conexión.';
  }
  return e?.message ?? 'Error desconocido.';
}

let transporte: Transporte | null = null;
/** Para los tests: ver qué se mandó sin salir a internet. */
export const fijarTransporteCorreo = (t: Transporte | null): void => { transporte = t; };

export async function enviarCorreo(
  a: string, asunto: string, texto: string, html?: string,
): Promise<ResultadoCorreo> {
  if (transporte) return transporte(a, asunto, texto, html);
  if (haySmtp()) return porSmtp(a, asunto, texto, html);
  if (hayResend()) {
    try {
      return await porResend(a, asunto, texto, html);
    } catch (e) {
      console.error('[correo] no se pudo enviar:', (e as Error).message);
      return { enviado: false, proveedor: 'resend', detalle: 'sin respuesta' };
    }
  }
  console.log(`\n  ┌─ Correo a ${a} · ${paraElRegistro(asunto)}`);
  console.log(`  │  ${paraElRegistro(texto)}`);
  console.log(`  └─ (sin proveedor de correo configurado: no se envió de verdad)\n`);
  return { enviado: true, proveedor: 'consola' };
}

/**
 * El marco de todos los correos: la franja de la marca arriba, el
 * contenido en una tarjeta y un pie discreto. Sin imágenes, porque
 * los correos con imágenes de un remitente nuevo caen más en spam y
 * muchos clientes las bloquean.
 */
export function plantillaCorreo(contenido: string, pie = ''): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#F4F6F4;font-family:Arial,Helvetica,sans-serif;color:#16211D">
<div style="max-width:480px;margin:0 auto;padding:24px 16px">
  <div style="background:#8B2838;border-radius:16px 16px 0 0;padding:18px 24px">
    <span style="font-size:20px;font-weight:bold;color:#FFFFFF;letter-spacing:0.3px">Feria App</span>
    <span style="font-size:13px;color:#F3D9DD;margin-left:8px">tu feria libre, a domicilio</span>
  </div>
  <div style="background:#FFFFFF;border:1px solid #E4E7E4;border-top:0;border-radius:0 0 16px 16px;padding:24px">
${contenido}
  </div>
  <p style="font-size:12px;line-height:1.5;color:#6B7670;margin:16px 8px 0;text-align:center">${pie || 'Feria App · Región de Valparaíso'}</p>
</div></body></html>`;
}
