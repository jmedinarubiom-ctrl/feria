import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

import { ErrorAuth, type IdentidadExterna } from './auth.ts';

/**
 * Verificación de los tokens de Google y de Apple.
 *
 * La app le pide a Google o a Apple que identifique a la persona y
 * recibe un «ID token»: un texto firmado que dice quién es. La app
 * lo manda acá, y acá NO se le cree a la app: se comprueba la firma
 * contra las llaves públicas del proveedor, que el token sea para
 * ESTA aplicación y que no esté vencido. Sin eso, cualquiera podría
 * armar un token diciendo ser quien quiera.
 *
 * Sin SDK: son JWT firmados con RS256, y Node trae todo para
 * verificarlos.
 */

type Proveedor = {
  emisores: string[];
  urlLlaves: string;
  /** Para qué aplicaciones se aceptan tokens (el `aud`). */
  audiencias: () => string[];
};

const lista = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Probar «Iniciar sesión con Apple» desde Expo Go.
 *
 * Dentro de Expo Go, Apple firma el permiso a nombre de Expo Go
 * (`host.exp.Exponent`), no de nuestra app, y el servidor lo rechaza
 * con razón. Para poder probar antes de tener la app compilada se
 * acepta también ese nombre, pero SOLO en el servidor de desarrollo
 * del computador: cualquier otra app abierta en Expo Go obtiene
 * permisos con ese mismo nombre, así que en un servidor expuesto a
 * internet sería una puerta falsa.
 */
const deExpoGo = (): string[] =>
  process.env.NODE_ENV !== 'production' && process.env.FERIA_EXPUESTA !== '1'
    && lista(process.env.APPLE_CLIENT_IDS).length > 0
    ? ['host.exp.Exponent'] : [];

const PROVEEDORES: Record<IdentidadExterna['proveedor'], Proveedor> = {
  google: {
    emisores: ['https://accounts.google.com', 'accounts.google.com'],
    urlLlaves: 'https://www.googleapis.com/oauth2/v3/certs',
    // Los «client ID» del proyecto de Google Cloud: uno por plataforma.
    audiencias: () => lista(process.env.GOOGLE_CLIENT_IDS),
  },
  apple: {
    emisores: ['https://appleid.apple.com'],
    urlLlaves: 'https://appleid.apple.com/auth/keys',
    // El identificador de la app (cl.feria.app).
    audiencias: () => [...lista(process.env.APPLE_CLIENT_IDS), ...deExpoGo()],
  },
};

/** Qué ingresos externos están configurados. La app muestra solo esos botones. */
export const externosDisponibles = () => ({
  google: PROVEEDORES.google.audiencias().length > 0,
  apple: PROVEEDORES.apple.audiencias().length > 0,
});

// ---------- llaves públicas ----------

type Llaves = Array<JsonWebKey & { kid?: string }>;
type BuscadorDeLlaves = (url: string) => Promise<Llaves>;

const porHttp: BuscadorDeLlaves = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { keys?: Llaves }).keys ?? [];
};

let buscar: BuscadorDeLlaves = porHttp;
const guardadas = new Map<string, { llaves: Llaves; hasta: number }>();

/** Para los tests: llaves propias en vez de las de Google y Apple. */
export const fijarLlaves = (b: BuscadorDeLlaves | null): void => {
  buscar = b ?? porHttp;
  guardadas.clear();
};

/**
 * Los proveedores rotan sus llaves cada tanto. Se guardan una hora,
 * y si aparece un token firmado con una que no se conoce se vuelven
 * a pedir una vez: puede ser una llave recién estrenada.
 */
async function llaveDe(url: string, kid: string): Promise<JsonWebKey> {
  const enMemoria = guardadas.get(url);
  let llave = enMemoria && enMemoria.hasta > Date.now()
    ? enMemoria.llaves.find((k) => k.kid === kid) : undefined;
  if (!llave) {
    let llaves: Llaves;
    try {
      llaves = await buscar(url);
    } catch {
      throw new ErrorAuth(503, 'No se pudo comprobar el ingreso. Intenta de nuevo.');
    }
    guardadas.set(url, { llaves, hasta: Date.now() + 3_600_000 });
    llave = llaves.find((k) => k.kid === kid);
  }
  if (!llave) throw new ErrorAuth(401, 'No se pudo comprobar el ingreso.');
  return llave;
}

// ---------- verificación ----------

const deBase64Url = (t: string): Buffer => Buffer.from(t, 'base64url');

export async function verificarTokenExterno(
  proveedor: unknown, idToken: unknown, nombre?: unknown,
): Promise<IdentidadExterna> {
  if (proveedor !== 'google' && proveedor !== 'apple') {
    throw new ErrorAuth(400, 'Ingreso desconocido.');
  }
  const cfg = PROVEEDORES[proveedor];
  const audiencias = cfg.audiencias();
  if (audiencias.length === 0) {
    throw new ErrorAuth(503, 'Ese ingreso todavía no está disponible.');
  }

  const invalido = new ErrorAuth(401, 'No se pudo comprobar el ingreso.');
  const partes = typeof idToken === 'string' ? idToken.split('.') : [];
  if (partes.length !== 3) throw invalido;

  let cabecera: any;
  let datos: any;
  try {
    cabecera = JSON.parse(deBase64Url(partes[0]).toString('utf8'));
    datos = JSON.parse(deBase64Url(partes[1]).toString('utf8'));
  } catch {
    throw invalido;
  }
  // Solo RS256. Aceptar lo que diga el token —«none», o HS256 con
  // la llave pública como secreto— es la forma clásica de saltarse
  // la firma.
  if (cabecera?.alg !== 'RS256' || typeof cabecera.kid !== 'string') throw invalido;

  const jwk = await llaveDe(cfg.urlLlaves, cabecera.kid);
  let firmaOk = false;
  try {
    firmaOk = createVerify('RSA-SHA256')
      .update(`${partes[0]}.${partes[1]}`)
      .verify(createPublicKey({ key: jwk, format: 'jwk' }), deBase64Url(partes[2]));
  } catch {
    firmaOk = false;
  }
  if (!firmaOk) throw invalido;

  const ahora = Math.floor(Date.now() / 1000);
  const paraQuien: string[] = Array.isArray(datos.aud) ? datos.aud : [datos.aud];
  if (!cfg.emisores.includes(datos.iss)) throw invalido;
  // Un token válido pero emitido para OTRA aplicación no sirve acá.
  if (!paraQuien.some((a) => audiencias.includes(a))) throw invalido;
  if (typeof datos.exp !== 'number' || datos.exp < ahora - 30) throw invalido;
  if (typeof datos.sub !== 'string' || !datos.sub) throw invalido;

  // El correo solo cuenta si el proveedor lo da por verificado: con
  // él se une esta cuenta a una que ya exista, y un correo sin
  // verificar permitiría quedarse con la cuenta de otro.
  const verificado = datos.email_verified === true || datos.email_verified === 'true';
  const correo = verificado && typeof datos.email === 'string'
    ? datos.email.trim().toLowerCase().slice(0, 120) : null;

  // Apple no pone el nombre en el token: lo entrega la app, y solo
  // la primera vez. Es un dato de cortesía, no de identidad.
  const nombreVisible = typeof datos.name === 'string' ? datos.name
    : typeof nombre === 'string' ? nombre : null;

  return { proveedor, sub: datos.sub, correo, nombre: nombreVisible?.trim() || null };
}
