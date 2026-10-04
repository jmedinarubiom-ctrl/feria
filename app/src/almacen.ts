import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Guarda el token de sesión.
 *
 * En el teléfono va al llavero del sistema (Keychain / Keystore).
 * En web —que se usa solo para probar— cae a localStorage, que no
 * es equivalente: no publiques la versión web con datos reales.
 */
const CLAVE = 'feria.sesion';

export type SesionGuardada = {
  token: string;
  rol: 'feriante' | 'repartidor' | 'operador';
  actorId: string;
  nombre: string;
};

export async function guardarSesion(s: SesionGuardada): Promise<void> {
  const texto = JSON.stringify(s);
  if (Platform.OS === 'web') localStorage.setItem(CLAVE, texto);
  else await SecureStore.setItemAsync(CLAVE, texto);
}

export async function leerSesion(): Promise<SesionGuardada | null> {
  try {
    const texto = Platform.OS === 'web'
      ? localStorage.getItem(CLAVE)
      : await SecureStore.getItemAsync(CLAVE);
    return texto ? (JSON.parse(texto) as SesionGuardada) : null;
  } catch {
    return null;
  }
}

export async function borrarSesion(): Promise<void> {
  if (Platform.OS === 'web') localStorage.removeItem(CLAVE);
  else await SecureStore.deleteItemAsync(CLAVE);
}


/**
 * Dirección del servidor elegida a mano.
 *
 * Solo se usa cuando la automática no sirve: un APK de prueba en un
 * teléfono que no está en la misma red que el computador. Se guarda
 * para no tener que escribirla en cada arranque.
 */
const CLAVE_SERVIDOR = 'feria.servidor';

export async function leerServidor(): Promise<string | null> {
  try {
    return Platform.OS === 'web'
      ? localStorage.getItem(CLAVE_SERVIDOR)
      : await SecureStore.getItemAsync(CLAVE_SERVIDOR);
  } catch {
    return null;
  }
}

export async function guardarServidor(url: string | null): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (url) localStorage.setItem(CLAVE_SERVIDOR, url);
      else localStorage.removeItem(CLAVE_SERVIDOR);
    } else if (url) {
      await SecureStore.setItemAsync(CLAVE_SERVIDOR, url);
    } else {
      await SecureStore.deleteItemAsync(CLAVE_SERVIDOR);
    }
  } catch {
    // Sin almacenamiento la app sigue andando; solo no recuerda.
  }
}
