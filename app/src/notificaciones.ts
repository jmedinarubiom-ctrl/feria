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

  await Notifications.setNotificationChannelAsync('pedidos', {
    name: 'Tu pedido',
    description: 'Cuando tu pedido sale de la feria y cuando llega.',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
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
    : rol === 'cliente' ? '/cliente/conexion'
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

// ============================================================
// El carrito que quedó a medias
// ============================================================

const ID_CARRITO = 'feria.carrito';
/** A las cuántas horas de dejar el carrito se le recuerda. */
const HORAS_CARRITO = 2;

/**
 * Recuerda el carrito sin terminar.
 *
 * El carrito vive en el teléfono —el servidor no sabe que existe
 * hasta que se convierte en pedido—, así que el recordatorio también:
 * es una notificación que el propio teléfono se programa. Se vuelve
 * a programar con cada cambio y se cancela cuando el carrito queda
 * vacío o se paga. Si la persona no dio permiso de notificaciones no
 * hace nada: acá no se le pide.
 */
export async function recordarCarrito(unidades: number): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(ID_CARRITO).catch(() => {});
    if (unidades <= 0 || Platform.OS === 'web') return;
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    await crearCanales();
    await Notifications.scheduleNotificationAsync({
      identifier: ID_CARRITO,
      content: {
        title: 'Tu carrito te está esperando',
        body: unidades === 1
          ? 'Dejaste 1 producto sin pedir. Termina tu compra antes de que cierre la feria.'
          : `Dejaste ${unidades} productos sin pedir. Termina tu compra antes de que cierre la feria.`,
        sound: 'default',
        data: { tipo: 'carrito' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: HORAS_CARRITO * 3600,
        channelId: 'pedidos',
      },
    });
  } catch {
    // Un recordatorio que no se pudo programar no es un error que
    // haya que mostrarle a nadie.
  }
}
