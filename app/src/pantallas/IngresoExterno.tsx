import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';

import { api } from '../api';
import { C, E, T } from '../tema';
import { Boton } from '../ui';

// Cierra la ventana de Google cuando vuelve a la app (en web).
WebBrowser.maybeCompleteAuthSession();

/**
 * Los identificadores de la app en Google Cloud, uno por
 * plataforma. Sin ellos no hay botón: se ponen en `eas.json`
 * cuando exista el proyecto (ver DESPLEGAR.md).
 */
const GOOGLE = {
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
};
const idDeEstaPlataforma = Platform.select({
  ios: GOOGLE.iosClientId, android: GOOGLE.androidClientId, default: GOOGLE.webClientId,
});

export type SesionExterna = { token: string; rol: string; actorId: string; nombre: string };

type Props = {
  alEntrar: (s: SesionExterna) => void;
  alFallar: (mensaje: string) => void;
  deshabilitado?: boolean;
};

const dispositivo = () => `${Platform.OS} · ${Platform.Version}`;

/**
 * «Entrar con Google» y «Entrar con Apple», para el comprador.
 *
 * Solo aparece lo que de verdad funciona: el servidor dice qué
 * tiene configurado (`/auth/metodos`) y Apple además solo existe en
 * iPhone. La app nunca decide quién es la persona: le pide el token
 * a Google o a Apple y se lo pasa al servidor, que comprueba la firma.
 */
export default function IngresoExterno(props: Props) {
  const [metodos, setMetodos] = useState<{ google?: boolean; apple?: boolean }>({});
  const [hayApple, setHayApple] = useState(false);

  useEffect(() => {
    api('GET', '/auth/metodos', { sinSesion: true }).then(setMetodos).catch(() => {});
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setHayApple).catch(() => {});
    }
  }, []);

  const conGoogle = !!metodos.google && !!idDeEstaPlataforma;
  const conApple = !!metodos.apple && hayApple;
  if (!conGoogle && !conApple) return null;

  return (
    <View style={e.caja}>
      <Text style={[T.micro, { textAlign: 'center' }]}>o entra para comprar con</Text>
      {conApple ? <BotonApple {...props} /> : null}
      {conGoogle ? <BotonGoogle {...props} /> : null}
    </View>
  );
}

function BotonApple({ alEntrar, alFallar }: Props) {
  const entrar = async () => {
    try {
      const c = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!c.identityToken) throw new Error('Apple no entregó la identificación.');
      // Apple da el nombre solo la primera vez, y fuera del token.
      const nombre = [c.fullName?.givenName, c.fullName?.familyName].filter(Boolean).join(' ');
      alEntrar(await api('POST', '/auth/externo', {
        sinSesion: true,
        cuerpo: { proveedor: 'apple', idToken: c.identityToken, nombre, dispositivo: dispositivo() },
      }));
    } catch (err: any) {
      // Cerrar la hoja de Apple no es un error que haya que mostrar.
      if (err?.code !== 'ERR_REQUEST_CANCELED') alFallar(err.message ?? 'No se pudo entrar con Apple.');
    }
  };

  return (
    <AppleAuthentication.AppleAuthenticationButton
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
      cornerRadius={14}
      style={{ height: 52 }}
      onPress={entrar}
    />
  );
}

/**
 * Va en su propio componente porque el hook de Google exige los
 * identificadores: llamarlo sin ellos revienta, así que solo se
 * monta cuando existen.
 */
function BotonGoogle({ alEntrar, alFallar, deshabilitado }: Props) {
  const [pedido, respuesta, abrir] = Google.useIdTokenAuthRequest(GOOGLE);

  useEffect(() => {
    if (respuesta?.type === 'error') {
      alFallar(respuesta.error?.message ?? 'No se pudo entrar con Google.');
    }
    if (respuesta?.type !== 'success') return;
    const idToken = respuesta.params?.id_token;
    if (!idToken) return alFallar('Google no entregó la identificación.');
    api('POST', '/auth/externo', {
      sinSesion: true,
      cuerpo: { proveedor: 'google', idToken, dispositivo: dispositivo() },
    }).then(alEntrar).catch((err: any) => alFallar(err.message));
  }, [respuesta]);

  return (
    <Boton
      titulo="Entrar con Google"
      variante="secundario"
      deshabilitado={!pedido || deshabilitado}
      onPress={() => void abrir()}
    />
  );
}

const e = StyleSheet.create({
  caja: {
    marginTop: E.xl, paddingTop: E.l, gap: E.m,
    borderTopWidth: 1, borderTopColor: C.borde,
  },
});
