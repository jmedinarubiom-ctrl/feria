import { CONFIG } from '../config.ts';

/**
 * Dirección escrita → punto en el mapa.
 *
 * Hasta ahora el pedido guardaba la dirección como texto y las
 * coordenadas quedaban fijas en el centro de Valparaíso para todos:
 * el repartidor veía la calle correcta pero el punto estaba siempre
 * en el mismo lugar, y cualquier cuenta por distancia trabajaba con
 * un dato falso.
 *
 * Usa Nominatim (OpenStreetMap), que es gratis y no pide clave. A
 * cambio exige identificarse y pide no pasar de una consulta por
 * segundo — por eso la cola. Un pedido cada pocos minutos está muy
 * por debajo de eso.
 *
 * Si no encuentra la dirección NO falla el pedido: devuelve null y
 * el pedido entra igual con el punto de la feria. Un cliente que no
 * puede comprar porque el geocodificador está caído es peor que un
 * repartidor que tiene que leer la dirección.
 */

export type Punto = { lat: number; lng: number; precision: string };

const AGENTE = 'FeriaApp/1.0 (reparto de feria libre; contacto@feria.cl)';

/** Nominatim pide máximo una consulta por segundo. */
let ultima = 0;
let cola: Promise<void> = Promise.resolve();

/**
 * Los turnos se encadenan. Antes cada llamada miraba `ultima` por
 * su cuenta: dos pedidos entrando juntos calculaban la misma espera
 * y salían los dos a la vez, que es justo lo que Nominatim pide no
 * hacer (y por lo que bloquea).
 */
function esperarTurno(): Promise<void> {
  const turno = cola.then(async () => {
    const falta = 1100 - (Date.now() - ultima);
    if (falta > 0) await new Promise((r) => setTimeout(r, falta));
    ultima = Date.now();
  });
  cola = turno;
  return turno;
}

/** Lo que se guarda para no volver a preguntar lo mismo. */
const memoria = new Map<string, Punto | null>();

/**
 * Ubica la dirección, y si no la encuentra prueba con la calle sola.
 *
 * Nominatim tiene muy pocos números de casa en Chile: «Subida
 * Ecuador 123» no existe para él, pero «Subida Ecuador» sí. Caer a
 * la esquina de la calle correcta es infinitamente mejor que caer
 * al centro de la ciudad, que es lo que pasaba antes.
 */
export async function geocodificar(
  direccion: string,
  opciones: { ciudad?: string; timeoutMs?: number } = {},
): Promise<Punto | null> {
  // Los tests no salen a internet: serían lentos, dependerían de que
  // Nominatim esté arriba y de paso le mandarían cientos de
  // consultas a un servicio gratuito por cada `npm test`.
  if (process.env.FERIA_SIN_GEO === '1') return null;

  const exacta = await buscar(direccion, opciones);
  if (exacta) return exacta;

  const sinNumero = direccion.replace(/\s*\d+[a-zA-Z]?\b.*$/, '').trim();
  if (!sinNumero || sinNumero === direccion.trim()) return null;

  const calle = await buscar(sinNumero, opciones);
  return calle ? { ...calle, precision: `calle (${calle.precision})` } : null;
}

async function buscar(
  direccion: string,
  opciones: { ciudad?: string; timeoutMs?: number },
): Promise<Punto | null> {
  const texto = direccion.trim();
  if (!texto) return null;

  const ciudad = opciones.ciudad ?? CONFIG.ciudad;
  const clave = `${ciudad}|${texto.toLowerCase()}`;
  if (memoria.has(clave)) return memoria.get(clave)!;

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', `${texto}, ${ciudad}`);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', CONFIG.pais);
  url.searchParams.set('addressdetails', '0');

  try {
    await esperarTurno();
    const control = AbortSignal.timeout(opciones.timeoutMs ?? 6000);
    const r = await fetch(url, { headers: { 'user-agent': AGENTE }, signal: control });
    if (!r.ok) throw new Error(`Nominatim ${r.status}`);

    const [primero] = await r.json() as Array<{ lat: string; lon: string; type?: string }>;
    const punto = primero
      ? {
          lat: Number(primero.lat),
          lng: Number(primero.lon),
          precision: primero.type ?? 'desconocida',
        }
      : null;

    const valido = punto && Number.isFinite(punto.lat) && Number.isFinite(punto.lng)
      ? punto : null;
    memoria.set(clave, valido);
    return valido;
  } catch (e) {
    // No se guarda en memoria: un error de red no es una respuesta,
    // y el próximo pedido a la misma dirección tiene que reintentar.
    console.warn('[geo] no se pudo ubicar', texto, (e as Error).message);
    return null;
  }
}

/** Para los tests y el apagado ordenado. */
export const olvidarGeocodificaciones = (): void => { memoria.clear(); };
