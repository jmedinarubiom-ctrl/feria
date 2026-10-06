/**
 * Freno de peticiones por IP.
 *
 * `auth.ts` ya limita los SMS por teléfono, pero nada impedía que
 * alguien martillara `/cotizar` o `/catalogo` mil veces por segundo
 * desde la misma máquina. Con una sola instancia y una base chica,
 * eso basta para dejar la feria sin servicio en plena mañana de
 * sábado.
 *
 * Es una ventana deslizante en memoria: se pierde al reiniciar y no
 * se comparte entre instancias. Para esta escala alcanza; el día que
 * haya varias instancias esto tiene que pasar al proxy de adelante.
 */

type Ventana = { desde: number; cuenta: number };

const ventanas = new Map<string, Ventana>();

/** Lo normal es muy poco: una persona mirando el catálogo. */
export const LIMITE_POR_MINUTO = Number(process.env.LIMITE_POR_MINUTO ?? 120);
const VENTANA_MS = 60_000;

/**
 * De quién viene la petición.
 *
 * Detrás de un proxy, `remoteAddress` es siempre el del proxy: sin
 * mirar `x-forwarded-for` el límite sería global y la primera
 * persona que entra deja fuera a todas las demás. Se toma la primera
 * IP de la cadena, que es la del cliente.
 */
export function deQuien(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  const reenviada = req.headers['x-forwarded-for'];
  const cadena = Array.isArray(reenviada) ? reenviada.join(',') : reenviada;
  const lista = (cadena ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  // `x-forwarded-for` lo puede escribir cualquiera: quien manda la
  // petición pone ahí lo que quiera y cada proxy agrega la suya al
  // FINAL. Con `PROXIES_DE_CONFIANZA` (cuántos proxies propios hay
  // adelante: 1 en casi todos los hostings) se toma la que escribió
  // el proxy y no la que inventó el cliente; sin eso, cambiando esa
  // cabecera en cada petición se esquiva el freno entero.
  const proxies = Number(process.env.PROXIES_DE_CONFIANZA);
  if (Number.isInteger(proxies) && proxies > 0) {
    return lista[lista.length - proxies] || req.socket?.remoteAddress || 'desconocida';
  }
  // Sin configurar se conserva lo de siempre (la primera), que
  // funciona en desarrollo y detrás del túnel.
  return lista[0] || req.socket?.remoteAddress || 'desconocida';
}

/** Devuelve cuántos segundos faltan para poder reintentar, o 0. */
export function pasar(ip: string, ahora = Date.now()): number {
  const v = ventanas.get(ip);
  if (!v || ahora - v.desde >= VENTANA_MS) {
    ventanas.set(ip, { desde: ahora, cuenta: 1 });
    return 0;
  }
  v.cuenta++;
  if (v.cuenta <= LIMITE_POR_MINUTO) return 0;
  return Math.ceil((VENTANA_MS - (ahora - v.desde)) / 1000);
}

/**
 * Saca las ventanas vencidas.
 *
 * Sin esto el mapa crece con cada IP que haya pasado alguna vez, y
 * un servidor que lleva meses arriba se queda sin memoria por un
 * contador que ya no sirve.
 */
export function limpiar(ahora = Date.now()): number {
  let fuera = 0;
  for (const [ip, v] of ventanas) {
    if (ahora - v.desde >= VENTANA_MS) { ventanas.delete(ip); fuera++; }
  }
  return fuera;
}

export const olvidarTodo = (): void => { ventanas.clear(); };
export const cuantasVentanas = (): number => ventanas.size;
