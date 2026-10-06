import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { api } from '../api';
import { C, E, R, T } from '../tema';
import { Boton } from '../ui';
import { Campo } from './piezas';
import { useCliente } from './estado';

/**
 * El teléfono de la cuenta.
 *
 * Un número confirmado no es un campo de texto: no se cambia
 * escribiendo otro encima. Para ponerlo o cambiarlo hay que recibir
 * un código EN ese número. Así el teléfono de un pedido es de quien
 * dice ser, y nadie se queda con la cuenta de otro cambiándole el
 * número.
 */
export default function TelefonoCuenta() {
  const { telefonoVerificado, refrescarCuenta } = useCliente();
  const [abierto, setAbierto] = useState(false);
  const [numero, setNumero] = useState('');
  const [codigo, setCodigo] = useState('');
  const [paso, setPaso] = useState<'numero' | 'codigo'>('numero');
  const [pista, setPista] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cerrar = () => {
    setAbierto(false); setPaso('numero'); setNumero(''); setCodigo(''); setPista(null);
  };

  const pedir = async () => {
    setOcupado(true);
    try {
      const r = await api('POST', '/cliente/telefono/codigo', { cuerpo: { telefono: numero } });
      setPista(r.codigoDev ? `Código de prueba: ${r.codigoDev}` : null);
      setPaso('codigo');
    } catch (err: any) {
      Alert.alert('No se pudo mandar el código', err.message);
    } finally {
      setOcupado(false);
    }
  };

  const confirmar = async () => {
    setOcupado(true);
    try {
      await api('POST', '/cliente/telefono/confirmar', { cuerpo: { telefono: numero, codigo } });
      await refrescarCuenta();
      cerrar();
    } catch (err: any) {
      Alert.alert('No se pudo confirmar', err.message);
      setCodigo('');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <View style={e.caja}>
      <Text style={T.micro}>TELÉFONO DE LA CUENTA</Text>
      {telefonoVerificado ? (
        <Text style={[T.destacado, { marginTop: 2 }]}>
          {telefonoVerificado} <Text style={{ color: C.verdeOscuro }}>· confirmado ✓</Text>
        </Text>
      ) : (
        <Text style={[T.apoyo, { marginTop: 2 }]}>
          Todavía no confirmas un número. Confírmalo para que tus pedidos lleven un teléfono
          que sabemos que es tuyo.
        </Text>
      )}

      {!abierto ? (
        <View style={{ marginTop: E.s }}>
          <Boton
            titulo={telefonoVerificado ? 'Cambiar número' : 'Confirmar mi número'}
            variante="secundario"
            onPress={() => setAbierto(true)}
          />
        </View>
      ) : paso === 'numero' ? (
        <View style={{ marginTop: E.m, gap: E.s }}>
          <Campo
            etiqueta={telefonoVerificado ? 'Número nuevo' : 'Tu número'}
            value={numero}
            onChangeText={setNumero}
            placeholder="+56 9 1234 5678"
            keyboardType="phone-pad"
            ayuda="Te mandamos un código por mensaje a ese número."
          />
          <Boton
            titulo={ocupado ? 'ENVIANDO…' : 'ENVIAR CÓDIGO'}
            onPress={pedir}
            deshabilitado={ocupado || numero.replace(/\D/g, '').length < 9}
          />
          <Boton titulo="Cancelar" variante="secundario" onPress={cerrar} />
        </View>
      ) : (
        <View style={{ marginTop: E.m, gap: E.s }}>
          <Campo
            etiqueta={`Código que llegó a ${numero}`}
            value={codigo}
            onChangeText={(t) => setCodigo(t.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            keyboardType="number-pad"
          />
          {pista ? <Text style={[T.micro, { color: C.naranja }]}>{pista}</Text> : null}
          <Boton
            titulo={ocupado ? 'CONFIRMANDO…' : 'CONFIRMAR'}
            onPress={confirmar}
            deshabilitado={ocupado || codigo.length !== 6}
          />
          <Boton titulo="Cancelar" variante="secundario" onPress={cerrar} />
        </View>
      )}
    </View>
  );
}

const e = StyleSheet.create({
  caja: {
    backgroundColor: C.fondo, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, padding: E.m,
  },
});
