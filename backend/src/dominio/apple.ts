import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createSign, randomBytes } from 'node:crypto';

import { consultarUno, ejecutar, type Fila } from '../db/index.ts';

/**
 * Revocar el permiso de «Iniciar sesión con Apple».
 *
 * Apple exige que, cuando alguien elimina una cuenta creada con su
 * botón, la app le avise para que el permiso deje de figurar en el
 * Apple ID de esa persona. Para eso hay que guardar, al entrar, un
 * permiso de larga vida (el «refresh token») y entregárselo de
 * vuelta al eliminar la cuenta.
 *
 * Hace falta la llave de «Sign in with Apple» de la cuenta de
 * desarrollador (`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`).
 * Sin ella todo esto no hace nada y el ingreso con Apple funciona
 * igual: solo no se revoca.
 */
const idDeLaApp = (): string | undefined =>
  (process.env.APPLE_CLIENT_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean)[0];

// La llave .p8 es un texto de varias líneas; en una variable de
// entorno suele venir con «\n» escritos.
const llavePrivada = (): string | undefined =>
  process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim() || undefined;

export const puedeRevocarApple = (): boolean =>
  !!(idDeLaApp() && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && llavePrivada());

const b64 = (dato: Buffer | string): string => Buffer.from(dato).toString('base64url');

/**
 * La «contraseña» de la app ante Apple: un token firmado con la
 * llave, que vale unos minutos. Se arma uno por llamada.
 */
export function secretoDeCliente(ahora = Math.floor(Date.now() / 1000)): string {
  const cabecera = b64(JSON.stringify({ alg: 'ES256', kid: process.env.APPLE_KEY_ID }));
  const cuerpo = b64(JSON.stringify({
    iss: process.env.APPLE_TEAM_ID,
    iat: ahora,
    exp: ahora + 300,
    aud: 'https://appleid.apple.com',
    sub: idDeLaApp(),
  }));
  const firma = createSign('SHA256').update(`${cabecera}.${cuerpo}`)
    .sign({ key: createPrivateKey(llavePrivada()!), dsaEncoding: 'ieee-p1363' });
  return `${cabecera}.${cuerpo}.${b64(firma)}`;
}

type Transporte = (camino: 'token' | 'revoke', campos: Record<string, string>) =>
  Promise<{ ok: boolean; estado: number; datos: any }>;

const porHttp: Transporte = async (camino, campos) => {
  const r = await fetch(`https://appleid.apple.com/auth/${camino}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const texto = await r.text();
  let datos: any = {};
  try { datos = texto ? JSON.parse(texto) : {}; } catch { /* la revocación responde vacío */ }
  return { ok: r.ok, estado: r.status, datos };
};

let transporte: Transporte = porHttp;
/** Para los tests: hablar con un Apple de mentira. */
export const fijarTransporteApple = (t: Transporte | null): void => { transporte = t ?? porHttp; };

// ---------- guardar el permiso, cifrado ----------

// Quien lea la base no debería poder usar el permiso: se cifra con
// una llave derivada del secreto del servidor.
const llaveDeCifrado = (): Buffer =>
  createHash('sha256').update(`apple:${process.env.FERIA_SECRETO ?? 'secreto-de-desarrollo-no-usar-en-produccion'}`).digest();

export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', llaveDeCifrado(), iv);
  const cuerpo = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), cuerpo]).toString('base64');
}

export function descifrar(guardado: string): string | null {
  try {
    const b = Buffer.from(guardado, 'base64');
    const d = createDecipheriv('aes-256-gcm', llaveDeCifrado(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Al entrar con Apple: cambia el código de un solo uso que entrega
 * la app por el permiso de larga vida, y lo guarda. Nunca lanza: que
 * esto falle no puede impedir que la persona entre.
 */
export async function guardarPermisoApple(clienteId: string, codigo: unknown): Promise<boolean> {
  if (!puedeRevocarApple() || typeof codigo !== 'string' || !codigo || codigo.length > 2000) return false;
  try {
    const r = await transporte('token', {
      client_id: idDeLaApp()!,
      client_secret: secretoDeCliente(),
      code: codigo,
      grant_type: 'authorization_code',
    });
    const permiso = r.datos?.refresh_token;
    if (!r.ok || typeof permiso !== 'string') {
      console.error('[apple] no se obtuvo el permiso:', r.estado, r.datos?.error ?? '');
      return false;
    }
    await ejecutar('UPDATE clientes SET apple_permiso = ? WHERE id = ?', cifrar(permiso), clienteId);
    return true;
  } catch (e) {
    console.error('[apple] no se pudo guardar el permiso:', (e as Error).message);
    return false;
  }
}

/** El permiso guardado de una cuenta, para revocarlo después de borrarla. */
export async function permisoAppleDe(clienteId: string): Promise<string | null> {
  const c = await consultarUno<Fila>('SELECT apple_permiso FROM clientes WHERE id = ?', clienteId);
  return c?.apple_permiso ? descifrar(c.apple_permiso) : null;
}

/** Le devuelve el permiso a Apple. Tampoco lanza. */
export async function revocarPermisoApple(permiso: string | null): Promise<boolean> {
  if (!permiso || !puedeRevocarApple()) return false;
  try {
    const r = await transporte('revoke', {
      client_id: idDeLaApp()!,
      client_secret: secretoDeCliente(),
      token: permiso,
      token_type_hint: 'refresh_token',
    });
    if (!r.ok) console.error('[apple] no aceptó la revocación:', r.estado, r.datos?.error ?? '');
    return r.ok;
  } catch (e) {
    console.error('[apple] no se pudo revocar:', (e as Error).message);
    return false;
  }
}
