import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Platform, Pressable, StatusBar, StyleSheet, Text, View,
} from 'react-native';

import { api, fijarToken, fijarServidor, buscarServidor, cuandoExpireLaSesion, ErrorApi } from './src/api';
import {
  leerSesion, guardarSesion, borrarSesion, leerServidor, type SesionGuardada,
} from './src/almacen';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Fredoka_500Medium, Fredoka_600SemiBold } from '@expo-google-fonts/fredoka';
import { Nunito_400Regular, Nunito_700Bold } from '@expo-google-fonts/nunito';

import { C, E, R, T } from './src/tema';
import { Fondo } from './src/Fondo';
import { Cabecera, Cargando } from './src/ui';
import { activarPush, alTocarNotificacion, type EstadoPush } from './src/notificaciones';
import Entrar from './src/pantallas/Entrar';
import ConTerminos from './src/Terminos';
import AppCliente from './src/cliente/Navegador';
import Feriante from './src/pantallas/Feriante';
import Operador from './src/pantallas/Operador';
import Repartidor from './src/pantallas/Repartidor';

/**
 * La sesión decide qué app es.
 *
 * Feriante, repartidor y operador entran con su teléfono, y el rol
 * lo dice el servidor: nadie elige de qué lado del mostrador está.
 * El cliente entra igual que todos; un número nuevo queda registrado
 * como cliente la primera vez que confirma su código.
 */

type Estado =
  | { fase: 'cargando' }
  | { fase: 'fuera' }
  | { fase: 'dentro'; sesion: SesionGuardada };

export default function App() {
  return (
    <SafeAreaProvider>
      <Raiz />
    </SafeAreaProvider>
  );
}

function Raiz() {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const [push, setPush] = useState<EstadoPush | null>(null);
  const [fuentesListas] = useFonts({
    Fredoka_500Medium, Fredoka_600SemiBold, Nunito_400Regular, Nunito_700Bold,
  });

  const salir = useCallback(async (avisarAlServidor: boolean) => {
    if (avisarAlServidor) await api('POST', '/auth/salir').catch(() => {});
    fijarToken(null);
    await borrarSesion();
    setEstado({ fase: 'fuera' });
  }, []);

  useEffect(() => {
    // Si el servidor rechaza el token —venció, o lo revocaron desde
    // otro teléfono— la app vuelve al ingreso sin quedarse colgada.
    cuandoExpireLaSesion(() => {
      void borrarSesion();
      setEstado({ fase: 'fuera' });
    });

    void (async () => {
      // La dirección elegida a mano va ANTES de la primera petición.
      // Se aplicaba recién al mostrar la pantalla de ingreso: con la
      // sesión guardada, la consulta de abajo salía a la dirección
      // automática, fallaba, y la app echaba al usuario en cada
      // arranque.
      const elegido = await leerServidor();
      if (elegido) fijarServidor(elegido);
      else await buscarServidor();

      const guardada = await leerSesion();
      if (!guardada) return setEstado({ fase: 'fuera' });

      fijarToken(guardada.token);
      try {
        // El token puede haber sido revocado desde el servidor.
        const yo = await api('GET', '/auth/yo');
        setEstado({ fase: 'dentro', sesion: { ...guardada, rol: yo.rol, actorId: yo.actorId } });
      } catch (e) {
        // Solo un «no» del servidor borra la sesión. Antes cualquier
        // error la borraba: abrir la app sin señal —en la feria, lo
        // normal— dejaba al feriante afuera y pidiendo código de
        // nuevo. Sin red se entra con lo guardado; las pantallas
        // reintentan solas.
        if (e instanceof ErrorApi && e.estado === 401) {
          fijarToken(null);
          await borrarSesion();
          setEstado({ fase: 'fuera' });
        } else {
          fijarToken(guardada.token);
          setEstado({ fase: 'dentro', sesion: guardada });
        }
      }
    })();
  }, []);

  // El permiso se pide recién cuando la persona ya entró y sabe
  // para qué sirve, no en la pantalla de bienvenida.
  useEffect(() => {
    // El cliente no recibe ofertas ni viajes: no se le pide permiso
    // de notificaciones para nada.
    if (estado.fase !== 'dentro' || estado.sesion.rol === 'cliente') return;
    void activarPush(estado.sesion.rol).then(setPush).catch(() =>
      setPush({ estado: 'no-disponible', motivo: 'No se pudo activar.' }));
    return alTocarNotificacion(() => {});
  }, [estado.fase, estado.fase === 'dentro' ? estado.sesion.rol : null]);

  // Sin las fuentes cargadas el texto salta de una familia a otra
  // al aparecer, que se ve peor que esperar medio segundo.
  if (estado.fase === 'cargando' || !fuentesListas) {
    return (
      <View style={{ flex: 1 }}>
        <Fondo />
        <SafeAreaView style={e.raiz}><Cargando /></SafeAreaView>
      </View>
    );
  }

  if (estado.fase === 'fuera') {
    return (
      <View style={{ flex: 1 }}>
        <Fondo />
        <SafeAreaView style={e.raiz}>
        <StatusBar barStyle="dark-content" backgroundColor={C.fondo} />
        <Entrar onEntro={async (s) => {
          await guardarSesion(s);
          setEstado({ fase: 'dentro', sesion: s });
        }} />
        </SafeAreaView>
      </View>
    );
  }

  // La app del cliente trae su propia navegación, su propio fondo y
  // su propia barra: no va dentro del marco de los roles de la feria.
  // El cliente entra con su teléfono igual que todos; lo que cambia
  // es la app que ve.
  if (estado.sesion.rol === 'cliente') {
    return (
      <>
        <StatusBar barStyle="dark-content" backgroundColor={C.superficie} />
        <ConTerminos onSalir={() => void salir(true)}>
          <AppCliente
            telefono={estado.sesion.telefono ?? ''}
            cuentaId={estado.sesion.actorId}
            alEliminarCuenta={() => void salir(false)}
            onSalir={() => Alert.alert('Cerrar sesión', '¿Salir de tu cuenta?', [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Salir', style: 'destructive', onPress: () => void salir(true) },
            ])}
          />
        </ConTerminos>
      </>
    );
  }

  const { sesion } = estado;
  return (
    <View style={{ flex: 1, backgroundColor: C.fondo }}>
      <SafeAreaView style={e.raiz} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={C.fondo} />
      <Cabecera
        nombre={sesion.nombre}
        subtitulo={ROLES[sesion.rol] ?? sesion.rol}
        onSalir={() => Alert.alert('Cerrar sesión', `¿Salir de la cuenta de ${sesion.nombre}?`, [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Salir acá', style: 'destructive', onPress: () => void salir(true) },
          {
            // Para el teléfono que se perdió o se vendió: el token
            // de ese aparato vale 90 días y sin esto no hay forma
            // de cortarlo desde otro lado.
            text: 'Salir de todos',
            style: 'destructive',
            onPress: () => Alert.alert(
              'Cerrar todas las sesiones',
              'Vas a tener que entrar de nuevo en todos tus teléfonos. '
              + 'Sirve si perdiste uno.',
              [
                { text: 'Cancelar', style: 'cancel' },
                {
                  text: 'Cerrar todas',
                  style: 'destructive',
                  onPress: () => void (async () => {
                    await api('POST', '/auth/salir-de-todos').catch(() => {});
                    await salir(false);
                  })(),
                },
              ]),
          },
        ])}
      />
      {push && push.estado !== 'listo' ? (
        <Pressable
          onPress={() => Alert.alert(
            'Notificaciones apagadas',
            push.estado === 'sin-permiso'
              ? 'Sin permiso de notificaciones solo te vas a enterar de los pedidos con la app abierta. Se activa desde los ajustes del teléfono.'
              : push.motivo)}
          style={e.avisoPush}
        >
          <Text style={[T.micro, { color: C.naranja, textAlign: 'center' }]}>
            Notificaciones apagadas · solo ves pedidos con la app abierta
          </Text>
        </Pressable>
      ) : null}

      {sesion.rol === 'feriante' ? (
        <ConTerminos onSalir={() => void salir(true)}>
          <Feriante ferianteId={sesion.actorId} />
        </ConTerminos>
      ) : null}
      {sesion.rol === 'repartidor' ? (
        <ConTerminos onSalir={() => void salir(true)}>
          <Repartidor repartidorId={sesion.actorId} />
        </ConTerminos>
      ) : null}
      {sesion.rol === 'operador' ? <Operador /> : null}
      </SafeAreaView>
    </View>
  );
}

const ROLES: Record<string, string> = {
  feriante: 'Puesto de la feria',
  repartidor: 'Reparto',
  operador: 'Operación',
};

const e = StyleSheet.create({
  raiz: {
    flex: 1,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0,
  },
  avisoPush: {
    marginHorizontal: E.l, marginBottom: E.s,
    backgroundColor: C.naranjaSuave, borderRadius: R.chico,
    paddingVertical: E.s, paddingHorizontal: E.m,
  },
});
