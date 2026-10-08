import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';

import { api } from '../api';
import { C, E, R, T } from '../tema';
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
  /** La dirección del servidor: si cambia, se vuelve a preguntar. */
  direccion?: string;
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

  // Se pregunta de nuevo cada vez que cambia la dirección del
  // servidor: antes se preguntaba una sola vez al abrir, y si en ese
  // momento el servidor no contestaba el botón no aparecía nunca
  // más, aunque después se corrigiera la dirección.
  useEffect(() => {
    let vigente = true;
    api('GET', '/auth/metodos', { sinSesion: true })
      .then((m) => { if (vigente) setMetodos(m); })
      .catch(() => { if (vigente) setMetodos({}); });
    return () => { vigente = false; };
  }, [props.direccion]);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setHayApple).catch(() => {});
    }
  }, []);

  // El botón de Google se muestra si la app trae su identificador,
  // salvo que el servidor diga expresamente que no lo tiene. Que el
  // servidor no conteste no lo esconde: al tocarlo se ve el error.
  const conGoogle = !!idDeEstaPlataforma && metodos.google !== false;
  // Lo mismo con Apple: en un iPhone se muestra salvo que el servidor
  // diga que no lo tiene. Antes, si el servidor no contestaba —el
  // teléfono apuntando a una dirección vieja— el botón desaparecía
  // sin ninguna pista de por qué.
  const conApple = hayApple && metodos.apple !== false;
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
        cuerpo: {
          proveedor: 'apple', idToken: c.identityToken, nombre, dispositivo: dispositivo(),
          // Para poder revocar el permiso si después elimina su cuenta.
          codigoAutorizacion: c.authorizationCode ?? undefined,
        },
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
    <Pressable
      disabled={!pedido || deshabilitado}
      onPress={() => void abrir()}
      accessibilityRole="button"
      accessibilityLabel="Continuar con Google"
      style={({ pressed }) => [
        e.google, pressed && { opacity: 0.8 }, (!pedido || deshabilitado) && { opacity: 0.5 },
      ]}
    >
      <LogoGoogle />
      <Text style={e.googleTexto}>Continuar con Google</Text>
    </Pressable>
  );
}

/**
 * La «G» de Google, con sus cuatro colores.
 *
 * Es el logo oficial y va tal cual, sobre fondo blanco: las normas
 * de marca de Google no dejan recolorearlo ni cambiarle la forma, y
 * es lo que hace que la gente reconozca el botón sin leerlo.
 */
function LogoGoogle({ tamano = 20 }: { tamano?: number }) {
  return (
    <Svg width={tamano} height={tamano} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  );
}

const e = StyleSheet.create({
  google: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: E.m,
    height: 52, borderRadius: R.grande, backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: '#DADCE0',
  },
  googleTexto: {
    fontFamily: T.destacado.fontFamily, fontSize: 16, color: '#1F1F1F',
  },
  caja: {
    marginTop: E.xl, paddingTop: E.l, gap: E.m,
    borderTopWidth: 1, borderTopColor: C.borde,
  },
});
