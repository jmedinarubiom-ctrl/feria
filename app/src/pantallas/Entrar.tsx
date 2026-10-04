import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';

import {
  pedirCodigo, canjearCodigo, fijarToken, ErrorApi, servidor, fijarServidor, BASE_AUTO,
} from '../api';
import { leerServidor, guardarServidor } from '../almacen';
import { guardarSesion, type SesionGuardada } from '../almacen';
import { C, E, FUENTES, R, T } from '../tema';
import { Aviso, Boton } from '../ui';
import { Logotipo } from '../Logotipo';

/**
 * Ingreso por SMS.
 *
 * Dos pasos y nada más: número y código. El feriante no tiene
 * contraseña que recordar ni cuenta que crear — su teléfono ya es
 * su identidad en la feria.
 */
export default function Entrar({ onEntro }: { onEntro: (s: SesionGuardada) => void }) {
  const [paso, setPaso] = useState<'telefono' | 'codigo'>('telefono');
  const [cambiandoServidor, setCambiandoServidor] = useState(false);
  const [otroServidor, setOtroServidor] = useState('');

  // Una dirección guardada de antes manda sobre la automática.
  useEffect(() => {
    void leerServidor().then((v) => {
      if (v) { fijarServidor(v); setOtroServidor(v); }
    });
  }, []);
  const [telefono, setTelefono] = useState('');
  const [codigo, setCodigo] = useState('');
  const [pista, setPista] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const campoCodigo = useRef<TextInput>(null);

  const enviar = async () => {
    setOcupado(true);
    setError(null);
    try {
      const r = await pedirCodigo(telefono);
      setPaso('codigo');
      // Sin proveedor de SMS configurado no hay forma de recibirlo,
      // así que el servidor lo devuelve para poder probar.
      setPista(r.codigoDev ? `Código de prueba: ${r.codigoDev}` : null);
      setTimeout(() => campoCodigo.current?.focus(), 250);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setOcupado(false);
    }
  };

  const entrar = async () => {
    setOcupado(true);
    setError(null);
    try {
      const dispositivo = `${Platform.OS} · ${Platform.Version}`;
      const s = await canjearCodigo(telefono, codigo, dispositivo);
      const sesion: SesionGuardada = {
        token: s.token, rol: s.rol, actorId: s.actorId, nombre: s.nombre,
      };
      fijarToken(s.token);
      await guardarSesion(sesion);
      onEntro(sesion);
    } catch (e: any) {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo entrar.');
      setCodigo('');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={e.pantalla}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={e.contenido} keyboardShouldPersistTaps="handled">
        <View style={{ marginBottom: 44, alignItems: 'center' }}>
          <Logotipo tamano={210} />
          <Text style={[T.apoyo, { marginTop: 8 }]}>
            Feria Av. Argentina · Valparaíso
          </Text>
        </View>

        {error ? <Aviso texto={error} /> : null}

        {paso === 'telefono' ? (
          <>
            <Text style={[T.seccion, { marginBottom: E.s }]}>Tu teléfono</Text>
            <TextInput
              style={e.campo}
              value={telefono}
              onChangeText={setTelefono}
              placeholder="+56 9 1234 5678"
              placeholderTextColor={C.textoSuave}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              editable={!ocupado}
              onSubmitEditing={enviar}
              returnKeyType="send"
            />
            <Text style={[T.apoyo, { marginBottom: 20 }]}>
              Te mandamos un código por mensaje. No hay contraseña que recordar.
            </Text>
            <Boton
              titulo={ocupado ? 'ENVIANDO…' : 'ENVIAR CÓDIGO'}
              onPress={enviar}
              deshabilitado={ocupado || telefono.replace(/\D/g, '').length < 9}
            />
          </>
        ) : (
          <>
            <Text style={[T.seccion, { marginBottom: E.s }]}>Código que te llegó</Text>
            <TextInput
              ref={campoCodigo}
              style={[e.campo, e.campoCodigo]}
              value={codigo}
              onChangeText={(t) => setCodigo(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor={C.borde}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              editable={!ocupado}
              onSubmitEditing={entrar}
            />
            <Text style={[T.apoyo, { marginBottom: 8 }]}>
              Enviado a {telefono}. Vence en 5 minutos.
            </Text>
            {pista ? <Aviso texto={pista} tono="aviso" /> : null}

            <Boton
              titulo={ocupado ? 'ENTRANDO…' : 'ENTRAR'}
              onPress={entrar}
              deshabilitado={ocupado || codigo.length !== 6}
            />
            <View style={{ marginTop: 10 }}>
              <Boton
                titulo="Usar otro número"
                variante="secundario"
                deshabilitado={ocupado}
                onPress={() => {
                  setPaso('telefono');
                  setCodigo('');
                  setPista(null);
                  setError(null);
                }}
              />
            </View>
          </>
        )}

        {/* La dirección del servidor: tiene que estar a la vista
            —cuando algo no carga, es el primer dato que hace falta—
            pero sin competir con lo que la persona vino a hacer.
            Tocándola se puede corregir, que es lo que salva cuando
            el APK quedó apuntando a una IP vieja. */}
        <Pressable onPress={() => setCambiandoServidor((v) => !v)} hitSlop={10}>
          <Text style={[T.micro, {
            fontSize: 10, marginTop: E.xxl, textAlign: 'center', opacity: 0.5,
          }]}>
            {servidor()}
          </Text>
        </Pressable>

        {cambiandoServidor ? (
          <View style={{ marginTop: E.m, gap: E.s }}>
            <TextInput
              style={[e.campo, { fontSize: 15 }]}
              value={otroServidor}
              onChangeText={setOtroServidor}
              placeholder="192.168.1.26  ·  o https://tu-dominio.cl"
              placeholderTextColor={C.textoSuave}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Boton
              titulo="USAR ESTA DIRECCIÓN"
              onPress={async () => {
                const v = otroServidor.trim();
                fijarServidor(v || null);
                await guardarServidor(v || null);
                setCambiandoServidor(false);
                setError(null);
              }}
            />
            <Boton
              titulo="Volver a la automática"
              variante="secundario"
              onPress={async () => {
                fijarServidor(null);
                await guardarServidor(null);
                setOtroServidor('');
                setCambiandoServidor(false);
              }}
            />
            <Text style={[T.micro, { textAlign: 'center' }]}>
              Automática: {BASE_AUTO}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: 'transparent' },
  contenido: { padding: E.xl, paddingTop: 56, flexGrow: 1, justifyContent: 'center' },
  campo: {
    backgroundColor: C.superficie,
    borderWidth: 1.5, borderColor: C.borde, borderRadius: R.grande,
    paddingHorizontal: E.l + 2, paddingVertical: E.l,
    fontFamily: FUENTES.cuerpo, fontSize: 20, color: C.texto, marginBottom: E.s,
  },
  campoCodigo: {
    fontFamily: FUENTES.tituloFuerte, fontSize: 34, letterSpacing: 10, textAlign: 'center',
  },
});
