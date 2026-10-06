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
import IngresoExterno, { type SesionExterna } from './IngresoExterno';

/**
 * Ingreso.
 *
 * Dos pasos y nada más: a dónde mandar el código, y el código. Nadie
 * tiene contraseña que recordar.
 *
 * El teléfono es la identidad de la gente de la feria: feriantes,
 * repartidores y el operador entran con él. El comprador además
 * puede entrar con su correo, con Google o con Apple —le sirve
 * igual y no cuesta un SMS—, y eso le da solo cuenta de comprador.
 */
function Medio({ texto, activo, onPress }: {
  texto: string; activo: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: activo }}
      style={[e.medio, activo && { backgroundColor: C.verde, borderColor: C.verde }]}
    >
      <Text style={[T.apoyo, { color: activo ? '#FFFFFF' : C.texto }]}>{texto}</Text>
    </Pressable>
  );
}

export default function Entrar({ onEntro }: { onEntro: (s: SesionGuardada) => void }) {
  const [paso, setPaso] = useState<'telefono' | 'codigo'>('telefono');
  const [medio, setMedio] = useState<'telefono' | 'correo'>('telefono');
  const [correo, setCorreo] = useState('');
  // Solo para el operador: el servidor la pide después del código.
  const [pideClave, setPideClave] = useState(false);
  const [clave, setClave] = useState('');
  // Vuelve después de meses: se pide además un código a su correo.
  const [pideCorreo, setPideCorreo] = useState<{ correo: string; codigoDev?: string } | null>(null);
  const [codigoCorreo, setCodigoCorreo] = useState('');
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

  const destino = medio === 'correo' ? { correo: correo.trim() } : { telefono };

  /** Guarda la sesión y entra, venga del código, de Google o de Apple. */
  const entrarCon = async (s: SesionExterna, conTelefono?: string) => {
    const sesion: SesionGuardada = {
      token: s.token, rol: s.rol as SesionGuardada['rol'], actorId: s.actorId,
      nombre: s.nombre, telefono: conTelefono,
    };
    fijarToken(s.token);
    await guardarSesion(sesion);
    onEntro(sesion);
  };

  const enviar = async () => {
    setOcupado(true);
    setError(null);
    try {
      const r = await pedirCodigo(destino);
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
      const s = await canjearCodigo(destino, codigo, dispositivo, {
        clave: clave || undefined, codigoCorreo: codigoCorreo || undefined,
      });
      await entrarCon(s, medio === 'telefono' ? telefono : undefined);
    } catch (e: any) {
      // Falta la clave del operador: el código sigue sirviendo, así
      // que no se borra; solo aparece el campo que faltaba.
      if (e instanceof ErrorApi && e.pideCorreo) {
        // El código del SMS estaba bien y sigue sirviendo: falta el
        // que se mandó al correo.
        setError(pideCorreo && codigoCorreo ? e.message : null);
        setPideCorreo((previo) => ({
          correo: e.pideCorreo!.correo,
          codigoDev: e.pideCorreo!.codigoDev ?? previo?.codigoDev,
        }));
        setCodigoCorreo('');
        return;
      }
      if (e instanceof ErrorApi && e.pideClave) {
        setPideClave(true);
        setError(clave ? e.message : null);
        setClave('');
        return;
      }
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
            Tu feria libre, a domicilio
          </Text>
        </View>

        {error ? <Aviso texto={error} /> : null}

        {paso === 'telefono' ? (
          <>
            <View style={e.medios}>
              <Medio texto="Con mi teléfono" activo={medio === 'telefono'}
                     onPress={() => { setMedio('telefono'); setError(null); }} />
              <Medio texto="Con mi correo" activo={medio === 'correo'}
                     onPress={() => { setMedio('correo'); setError(null); }} />
            </View>
            {medio === 'telefono' ? (
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
            ) : (
              <TextInput
                style={e.campo}
                value={correo}
                onChangeText={setCorreo}
                placeholder="tu@correo.cl"
                placeholderTextColor={C.textoSuave}
                keyboardType="email-address"
                autoComplete="email"
                textContentType="emailAddress"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!ocupado}
                onSubmitEditing={enviar}
                returnKeyType="send"
              />
            )}
            <Text style={[T.apoyo, { marginBottom: 20 }]}>
              {medio === 'telefono'
                ? 'Te mandamos un código por mensaje. No hay contraseña que recordar.'
                  + '\nSi es tu primera vez, con esto quedas registrado.'
                : 'Te mandamos un código al correo. Sirve para comprar.'
                  + '\nSi tienes un puesto o repartes, entra con tu teléfono.'}
            </Text>
            <Boton
              titulo={ocupado ? 'ENVIANDO…' : 'ENVIAR CÓDIGO'}
              onPress={enviar}
              deshabilitado={ocupado || (medio === 'telefono'
                ? telefono.replace(/\D/g, '').length < 9
                : !/^\S+@\S+\.\S{2,}$/.test(correo.trim()))}
            />
            <IngresoExterno
              direccion={servidor()}
              deshabilitado={ocupado}
              alEntrar={(s) => void entrarCon(s)}
              alFallar={setError}
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
              Enviado a {medio === 'correo' ? correo.trim() : telefono}. Vence en 5 minutos.
              {medio === 'correo' ? '\nSi no lo ves en un minuto, revisa la carpeta de spam.' : ''}
            </Text>
            {pista ? <Aviso texto={pista} tono="aviso" /> : null}

            {pideCorreo ? (
              <>
                <Text style={[T.seccion, { marginBottom: E.s }]}>Código que llegó a tu correo</Text>
                <TextInput
                  style={[e.campo, e.campoCodigo]}
                  value={codigoCorreo}
                  onChangeText={(t) => setCodigoCorreo(t.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  placeholderTextColor={C.borde}
                  keyboardType="number-pad"
                  maxLength={6}
                  editable={!ocupado}
                  onSubmitEditing={entrar}
                />
                <Text style={[T.apoyo, { marginBottom: 8 }]}>
                  Hace tiempo que no entras. Para confirmar que eres tú, te mandamos otro
                  código a {pideCorreo.correo}. Si ya no tienes ese correo, llama a la feria.
                </Text>
                {pideCorreo.codigoDev ? (
                  <Aviso texto={`Código de prueba del correo: ${pideCorreo.codigoDev}`} tono="aviso" />
                ) : null}
              </>
            ) : null}
            {pideClave ? (
              <>
                <Text style={[T.seccion, { marginBottom: E.s }]}>Tu clave de operador</Text>
                <TextInput
                  style={[e.campo, { fontSize: 18 }]}
                  value={clave}
                  onChangeText={setClave}
                  placeholder="Clave"
                  placeholderTextColor={C.textoSuave}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!ocupado}
                  onSubmitEditing={entrar}
                />
              </>
            ) : null}
            <Boton
              titulo={ocupado ? 'ENTRANDO…' : 'ENTRAR'}
              onPress={entrar}
              deshabilitado={ocupado || codigo.length !== 6 || (pideClave && !clave)
                || (!!pideCorreo && codigoCorreo.length !== 6)}
            />
            <View style={{ marginTop: 10 }}>
              <Boton
                titulo="Cambiar teléfono o correo"
                variante="secundario"
                deshabilitado={ocupado}
                onPress={() => {
                  setPaso('telefono');
                  setPideClave(false);
                  setClave('');
                  setPideCorreo(null);
                  setCodigoCorreo('');
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
  medios: { flexDirection: 'row', gap: E.s, marginBottom: E.m },
  medio: {
    flex: 1, alignItems: 'center', paddingVertical: E.m, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, backgroundColor: C.superficie,
  },
  campoCodigo: {
    fontFamily: FUENTES.tituloFuerte, fontSize: 34, letterSpacing: 10, textAlign: 'center',
  },
});
