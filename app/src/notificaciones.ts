import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

import { api } from './api';

/**
 * Push del lado de la app.
 *
 * ⚠️ Las notificaciones remotas NO funcionan en Expo Go: desde el
 * SDK 53 hay que usar un development build (`npx expo run:ios` o
 * `eas build --profile development`). Acá se detecta y se avisa en
 * vez de reventar, para que el resto de la app siga andando.
 */

/** Con la app abierta el aviso igual se muestra: puede estar en otra pantalla. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const enExpoGo = Constants.appOwnership === 'expo';

/**
 * Canales de Android.
 *
 * El canal define cuánto molesta el aviso, y el usuario puede
 * cambiarlo pero no la app: por eso las ofertas tienen su propio
 * canal en MAX, separado de todo lo demás. Si compartieran canal
 * con avisos menores, silenciar uno silenciaría el otro.
 */
async function crearCanales(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('ofertas', {
    name: 'Pedidos nuevos',
    description: 'Cuando entra un pedido que puedes tomar. Tiene 90 segundos.',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 400, 200, 400],
    enableVibrate: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
  });

  await Notifications.setNotificationChannelAsync('viajes', {
    name: 'Viajes disponibles',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 300, 150, 300],
  });

  await Notifications.setNotificationChannelAsync('autogestion', {
    name: 'Pedidos sin feriante',
    description: 'Cuando nadie tomó un pedido y lo tienes que comprar tú.',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
  });
}

export type EstadoPush =
  | { estado: 'listo'; token: string }
  | { estado: 'sin-permiso' }
  | { estado: 'no-disponible'; motivo: string };

/**
 * Pide permiso, saca el token y lo registra en el servidor.
 *
 * Se llama después de entrar, no al abrir la app: pedir permiso de
 * notificaciones en la primera pantalla, antes de que la persona
 * sepa para qué son, es la forma más rápida de que lo rechacen.
 */
export async function activarPush(rol: string): Promise<EstadoPush> {
  if (!Device.isDevice) {
    return { estado: 'no-disponible', motivo: 'El simulador no recibe notificaciones.' };
  }
  if (enExpoGo) {
    return {
      estado: 'no-disponible',
      motivo: 'Expo Go no soporta notificaciones remotas. Hace falta un development build.',
    };
  }

  await crearCanales();

  const { status: actual } = await Notifications.getPermissionsAsync();
  let status = actual;
  if (status !== 'granted') {
    ({ status } = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }));
  }
  if (status !== 'granted') return { estado: 'sin-permiso' };

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) {
    return {
      estado: 'no-disponible',
      motivo: 'Falta el projectId de EAS en app.json (extra.eas.projectId).',
    };
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  const camino = rol === 'feriante' ? '/feriante/conexion'
    : rol === 'repartidor' ? '/repartidor/conexion'
    : '/operador/conexion';

  // `conectado: true` solo aplica a feriante y repartidor; el
  // endpoint del operador lo ignora.
  await api('POST', camino, { cuerpo: { pushToken: token, conectado: true } });
  return { estado: 'listo', token };
}

/** Avisa cuando el usuario toca una notificación, para refrescar la pantalla. */
export function alTocarNotificacion(fn: (datos: any) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    fn(r.notification.request.content.data);
  });
  return () => sub.remove();
}
