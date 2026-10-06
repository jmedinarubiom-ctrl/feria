import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeModules } from 'react-native';
import Constants from 'expo-constants';

/**
 * Dirección del backend.
 *
 * En un teléfono de verdad `localhost` es el teléfono, no el
 * computador: hay que averiguar la IP del Mac en la red local. La
 * da Expo, que es quien le sirvió el bundle a la app.
 *
 * Antes esto leía `NativeModules.SourceCode.scriptURL`, que ya no
 * existe en React Native 0.86. Caía siempre al `?? 'localhost'` y
 * nadie lo notaba, porque en el simulador `localhost` ES el
 * computador. En un iPhone la app no llegaba a ningún lado y el
 * botón de «enviar código» no hacía nada.
 */
/**
 * `EXPO_PUBLIC_FERIA_API` puede traer varias direcciones separadas
 * por coma. Un APK de prueba apunta al Mac, y el Mac cambia de IP
 * según la red en que esté: con la lista, la app prueba cuál
 * responde (`buscarServidor`) en vez de quedar apuntando a la red
 * de ayer.
 */
const DIRECCIONES_FIJAS: string[] = String(process.env.EXPO_PUBLIC_FERIA_API ?? '')
  .split(',').map((d: string) => d.trim()).filter(Boolean);

function detectarHost(): string {
  // En producción el servidor tiene dominio propio y nada de esto
  // aplica. `EXPO_PUBLIC_` es el prefijo que Expo inyecta al bundle.
  const fijo = DIRECCIONES_FIJAS[0];
  if (fijo) return fijo;

  // `hostUri` viene como «192.168.1.26:8082». También sirve
  // `debuggerHost`, que es el nombre viejo de lo mismo.
  const candidatos = [
    Constants.expoConfig?.hostUri,
    (Constants as any).expoGoConfig?.debuggerHost,
    (Constants as any).manifest2?.extra?.expoGo?.debuggerHost,
    NativeModules?.SourceCode?.scriptURL,
  ];

  for (const c of candidatos) {
    if (typeof c !== 'string' || !c) continue;
    // Puede venir con esquema («http://ip:puerto») o sin él.
    const sinEsquema = c.includes('://') ? c.split('://')[1] : c;
    const anfitrion = sinEsquema.split('/')[0].split(':')[0];
    if (anfitrion) return anfitrion;
  }
  return 'localhost';
}

const armar = (h: string) => (h.startsWith('http') ? h : `http://${h}:4000`);

/**
 * La dirección del servidor, averiguada sola.
 *
 * Sirve para Expo Go y para una app publicada. Lo que no cubre es
 * el caso intermedio: un APK de prueba instalado en un teléfono que
 * no está en la misma red que el computador. Para eso está
 * `fijarServidor`, que la deja cambiar sin recompilar — rehacer un
 * APK de quince minutos para corregir una IP no tiene sentido.
 */
let base = armar(detectarHost());
export const BASE_AUTO = base;
// La automática vigente: cambia si `buscarServidor` encuentra otra.
let auto = base;

export const servidor = (): string => base;
export const fijarServidor = (url: string | null): void => {
  base = url ? armar(url.trim().replace(/\/$/, '')) : auto;
};

const responde = async (url: string): Promise<string> => {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 3000);
  try {
    const r = await fetch(url + '/salud', { signal: corte.signal });
    if (!r.ok) throw new Error('no responde');
    return url;
  } finally {
    clearTimeout(reloj);
  }
};

/**
 * Si hay varias direcciones posibles, deja puesta la primera que
 * responda. No toca nada si hay una sola o si ninguna contesta.
 */
export async function buscarServidor(): Promise<void> {
  if (DIRECCIONES_FIJAS.length < 2) return;
  try {
    auto = await Promise.any(DIRECCIONES_FIJAS.map((d) => responde(armar(d))));
    base = auto;
  } catch {
    // Ninguna respondió: queda la primera y la pantalla de ingreso
    // deja escribir otra a mano.
  }
}

/**
 * El servidor corre como función (Supabase): no hay WebSocket, y
 * cada intento de conexión es una llamada que cuenta en la cuota.
 * La pantalla se pone al día preguntando cada pocos segundos.
 */
export const sinSocket = (): boolean => base.includes('/functions/v1/');

// Se mantienen por compatibilidad con lo que ya las usa. `servidor()`
// es la que refleja un cambio hecho a mano.
export const HOST = detectarHost();
export const BASE = base;

export class ErrorApi extends Error {
  estado: number;
  /** El servidor pide la clave del operador para terminar de entrar. */
  pideClave: boolean;
  /**
   * El servidor pide además el código que mandó al correo de la
   * cuenta (vuelve después de meses). Trae el correo tapado.
   */
  pideCorreo: { correo: string; codigoDev?: string } | null;
  constructor(mensaje: string, estado: number, cuerpo: any = {}) {
    super(mensaje);
    this.estado = estado;
    this.pideClave = !!cuerpo.pideClave;
    this.pideCorreo = cuerpo.pideCorreo
      ? { correo: String(cuerpo.correo ?? ''), codigoDev: cuerpo.codigoDev } : null;
  }
}

/**
 * Token de la sesión en curso.
 *
 * Vive en memoria durante la ejecución; la copia persistente está
 * en el llavero (ver `almacen.ts`). Se guarda acá para no leer el
 * llavero en cada petición.
 */
let tokenActual: string | null = null;

export const fijarToken = (t: string | null): void => { tokenActual = t; };

/** Aviso de que el servidor rechazó la sesión: la app tiene que sacar al usuario. */
let alExpirar: (() => void) | null = null;
export const cuandoExpireLaSesion = (fn: () => void): void => { alExpirar = fn; };

export async function api(
  metodo: 'GET' | 'POST',
  camino: string,
  opciones: { cuerpo?: unknown; sinSesion?: boolean } = {},
): Promise<any> {
  const r = await fetch(servidor() + camino, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(tokenActual && !opciones.sinSesion
        ? { authorization: `Bearer ${tokenActual}` }
        : {}),
    },
    body: metodo === 'POST' ? JSON.stringify(opciones.cuerpo ?? {}) : undefined,
  });
  const cuerpo = await r.json().catch(() => ({}));

  if (r.status === 401 && !opciones.sinSesion) {
    // El token venció o lo revocaron desde otro teléfono.
    tokenActual = null;
    alExpirar?.();
  }
  if (!r.ok) throw new ErrorApi(cuerpo.error ?? `Error ${r.status}`, r.status, cuerpo);
  return cuerpo;
}

// ---------- Ingreso ----------

/** A dónde va el código: al teléfono por SMS, o al correo. */
export type Destino = { telefono: string } | { correo: string };

export const pedirCodigo = (destino: Destino) =>
  api('POST', '/auth/codigo', { cuerpo: destino, sinSesion: true });

export const canjearCodigo = (
  destino: Destino, codigo: string, dispositivo: string,
  extra: { clave?: string; codigoCorreo?: string } = {},
) => api('POST', '/auth/sesion', {
  cuerpo: {
    ...destino, codigo, dispositivo,
    ...(extra.clave ? { clave: extra.clave } : {}),
    ...(extra.codigoCorreo ? { codigoCorreo: extra.codigoCorreo } : {}),
  },
  sinSesion: true,
});

/**
 * Escucha canales de Supabase Realtime.
 *
 * Es el protocolo de Phoenix sobre un WebSocket: entrar a cada canal,
 * mandar un latido cada 25 segundos y avisar cuando llega algo. Son
 * tan pocas líneas que no vale sumar una biblioteca al paquete.
 */
function abrirCanal(
  url: string, llave: string, canales: string[],
  al: { alAviso: () => void; alEstado: (arriba: boolean) => void },
): { cerrar: () => void } {
  let abierto = true;
  let ws: WebSocket | null = null;
  let latido: ReturnType<typeof setInterval> | undefined;
  let otraVez: ReturnType<typeof setTimeout> | undefined;
  let n = 0;

  const conectar = () => {
    if (!abierto) return;
    ws = new WebSocket(`${url}?apikey=${encodeURIComponent(llave)}&vsn=1.0.0`);
    const enviar = (topic: string, event: string, payload: unknown) =>
      ws?.send(JSON.stringify({ topic, event, payload, ref: String(++n) }));
    ws.onopen = () => {
      for (const c of canales) {
        enviar(`realtime:${c}`, 'phx_join', {
          config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false },
        });
      }
      latido = setInterval(() => enviar('phoenix', 'heartbeat', {}), 25000);
    };
    ws.onmessage = (e) => {
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m?.event === 'broadcast') al.alAviso();
      else if (m?.event === 'phx_reply' && String(m.topic).startsWith('realtime:')) {
        al.alEstado(m.payload?.status === 'ok');
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(latido);
      al.alEstado(false);
      if (abierto) otraVez = setTimeout(conectar, 5000);
    };
  };
  conectar();

  return {
    cerrar: () => {
      abierto = false;
      clearInterval(latido);
      clearTimeout(otraVez);
      ws?.close();
    },
  };
}

/**
 * Carga un endpoint y lo vuelve a pedir cuando el WebSocket avisa
 * que algo cambió.
 *
 * Recargar entero en vez de aplicar el cambio incremental es más
 * simple y suficiente a esta escala: el servidor manda el aviso,
 * el cliente pregunta la verdad. No hay estado que se desincronice.
 */
export function useTablero(camino: string, rol: string, actorId: string) {
  const [datos, setDatos] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const enVivoRef = useRef(false);
  const [enVivo, setEnVivo] = useState(false);

  const recargar = useCallback(async () => {
    try {
      setDatos(await api('GET', camino));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCargando(false);
    }
  }, [camino, actorId]);

  useEffect(() => {
    let vivo = true;
    let ws: WebSocket | null = null;
    let reintento: ReturnType<typeof setTimeout>;

    const conectar = () => {
      if (!vivo || sinSocket()) return;
      const wsBase = servidor().replace(/^http/, 'ws') + '/ws';
      // El servidor ya no le cree a la URL quién es uno: feriante,
      // repartidor y operador se identifican con el token de su
      // sesión. El cliente no tiene sesión; su llave es el id de su
      // pedido.
      // El token va en el primer mensaje y no en la dirección: las
      // direcciones quedan escritas en los registros de los
      // servidores del camino.
      ws = new WebSocket(`${wsBase}?rol=${rol}&id=${encodeURIComponent(actorId)}`);
      ws.onopen = () => {
        if (rol !== 'cliente' && tokenActual) ws?.send(JSON.stringify({ token: tokenActual }));
        enVivoRef.current = true; setEnVivo(true); void recargar();
      };
      ws.onmessage = () => { void recargar(); };
      ws.onerror = () => {};
      ws.onclose = () => {
        enVivoRef.current = false;
        setEnVivo(false);
        // Reconectar sin ruido: en la feria la señal se cae sola.
        if (vivo) reintento = setTimeout(conectar, 2000);
      };
    };

    // Con el servidor como función, los avisos llegan por el canal
    // en vivo de Supabase: el servidor dice dónde y qué escuchar.
    let canal: { cerrar: () => void } | null = null;
    const escuchar = async () => {
      if (!vivo || !sinSocket()) return;
      try {
        const como = await api('GET', rol === 'cliente'
          ? `/vivo?pedido=${encodeURIComponent(actorId)}` : '/vivo');
        if (!vivo || !como?.disponible) return;
        canal = abrirCanal(como.url, como.llave, como.canales, {
          alAviso: () => { void recargar(); },
          alEstado: (arriba) => {
            enVivoRef.current = arriba; setEnVivo(arriba);
            if (arriba) void recargar();
          },
        });
      } catch {
        if (vivo) reintento = setTimeout(escuchar, 15000);
      }
    };

    void recargar();
    conectar();
    void escuchar();

    // Red de seguridad por si el socket queda colgado sin cerrarse:
    // las ofertas vencen por tiempo y la pantalla tiene que enterarse.
    const encuesta = setInterval(
      () => { if (!enVivoRef.current) void recargar(); }, sinSocket() ? 8000 : 5000);
    // Con el canal arriba igual se pregunta de vez en cuando: un
    // aviso perdido no puede dejar la pantalla detenida.
    const repaso = setInterval(() => { if (enVivoRef.current && sinSocket()) void recargar(); }, 60000);

    return () => {
      vivo = false;
      clearTimeout(reintento);
      clearInterval(encuesta);
      clearInterval(repaso);
      canal?.cerrar();
      ws?.close();
    };
  }, [rol, actorId, recargar]);

  return { datos, error, cargando, enVivo, recargar };
}

/** Segundos que faltan para `expiraAt` (timestamp UTC del servidor). */
export function usarCuentaRegresiva(expiraAt: string | null): number {
  const [restante, setRestante] = useState(0);

  useEffect(() => {
    if (!expiraAt) return setRestante(0);
    // El servidor manda ISO 8601 con zona; Date lo parsea directo.
    const fin = new Date(expiraAt).getTime();
    if (Number.isNaN(fin)) return setRestante(0);
    const calcular = () => setRestante(Math.max(0, Math.round((fin - Date.now()) / 1000)));
    calcular();
    const t = setInterval(calcular, 250);
    return () => clearInterval(t);
  }, [expiraAt]);

  return restante;
}
