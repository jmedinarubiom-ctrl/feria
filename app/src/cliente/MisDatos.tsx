import React, { useState } from 'react';
import { Alert, Linking, Share, StyleSheet, Text, View } from 'react-native';

import { api, servidor } from '../api';
import { C, E, R, T } from '../tema';
import { Boton } from '../ui';

/**
 * Lo que la persona puede hacer con sus propios datos: leer qué se
 * guarda, llevarse una copia e irse.
 */
export default function MisDatos({ alEliminarCuenta }: { alEliminarCuenta: () => void }) {
  const [ocupado, setOcupado] = useState(false);

  const descargar = async () => {
    setOcupado(true);
    try {
      const datos = await api('GET', '/cliente/mis-datos');
      // Como texto para compartir: se lo manda a sí mismo por correo
      // o lo guarda en sus notas, sin permisos de archivos.
      await Share.share({
        title: 'Mis datos en la Feria',
        message: JSON.stringify(datos, null, 2),
      });
    } catch (err: any) {
      Alert.alert('No se pudo preparar la copia', err.message);
    } finally {
      setOcupado(false);
    }
  };

  const eliminar = () => Alert.alert(
    'Eliminar mi cuenta',
    'Se borran tu nombre, teléfono, correo y direcciones. De tus pedidos queda solo '
    + 'el monto, sin tus datos. No se puede deshacer.',
    [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        // Dos preguntas: es lo único de la app que no tiene vuelta.
        onPress: () => Alert.alert('¿Seguro?', 'Tu cuenta se elimina ahora.', [
          { text: 'No', style: 'cancel' },
          {
            text: 'Sí, eliminar',
            style: 'destructive',
            onPress: async () => {
              setOcupado(true);
              try {
                await api('POST', '/cliente/eliminar-cuenta', { cuerpo: { confirmo: 'ELIMINAR' } });
                alEliminarCuenta();
              } catch (err: any) {
                Alert.alert('No se pudo eliminar', err.message);
                setOcupado(false);
              }
            },
          },
        ]),
      },
    ]);

  return (
    <View style={e.bloque}>
      <Text style={T.destacado}>Tus datos</Text>
      <Text style={[T.micro, { marginTop: 2, marginBottom: E.m }]}>
        Qué guardamos, para qué, y cómo llevártelo o borrarlo.
      </Text>
      <View style={{ gap: E.s }}>
        <Boton titulo="Términos y privacidad" variante="secundario"
               onPress={() => void Linking.openURL(`${servidor()}/legal/privacidad`)} />
        <Boton titulo="Descargar una copia de mis datos" variante="secundario"
               onPress={descargar} deshabilitado={ocupado} />
        <Boton
          titulo="Cerrar sesión en todos mis dispositivos"
          variante="secundario"
          deshabilitado={ocupado}
          onPress={() => Alert.alert(
            'Cerrar todas las sesiones',
            'Sirve si perdiste un teléfono o entraste en uno ajeno. Vas a tener que entrar de nuevo.',
            [
              { text: 'Cancelar', style: 'cancel' },
              {
                text: 'Cerrar todas',
                style: 'destructive',
                onPress: async () => {
                  await api('POST', '/auth/salir-de-todos').catch(() => {});
                  alEliminarCuenta();
                },
              },
            ])}
        />
        <Boton titulo="Eliminar mi cuenta" variante="peligro"
               onPress={eliminar} deshabilitado={ocupado} />
      </View>
    </View>
  );
}

const e = StyleSheet.create({
  bloque: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
});
