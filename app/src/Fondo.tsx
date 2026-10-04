import React from 'react';
import { Image, StyleSheet, useWindowDimensions, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { C } from './tema';

/**
 * El fondo de la app.
 *
 * Dos lavados de color muy tenues sobre el neutro: verde desde
 * arriba y granate desde la esquina superior derecha, los dos de la
 * marca. Dan profundidad sin ensuciar el contenido.
 *
 * Las opacidades son deliberadamente bajas. Esta app se usa en la
 * calle a las nueve de la mañana; cualquier cosa más fuerte le come
 * contraste al texto justo cuando más falta hace.
 *
 * La pantalla de oferta se exceptúa y pinta su propio fondo liso:
 * ahí se decide en segundos y nada puede competir con el monto.
 */
export function Fondo() {
  const { width } = useWindowDimensions();
  // La manzana ocupa más que el ancho de pantalla y se sale por
  // arriba y por la derecha: se reconoce la forma sin que se lea
  // como un dibujo puesto ahí.
  const manzana = width * 1.15;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: C.fondo }]} />

      {/* Verde desde el borde superior */}
      <LinearGradient
        colors={[C.verde + '1C', C.verde + '00']}
        locations={[0, 1]}
        style={[StyleSheet.absoluteFill, { height: '55%' }]}
      />

      {/* La marca, enorme y casi invisible, mordiendo la esquina */}
      <Image
        source={require('../assets/logo-marca.png')}
        style={{
          position: 'absolute',
          top: -manzana * 0.34,
          right: -manzana * 0.30,
          width: manzana,
          height: manzana * (302 / 266),
          opacity: 0.055,
          transform: [{ rotate: '14deg' }],
        }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />

      {/* Granate en diagonal desde la esquina superior derecha */}
      <LinearGradient
        colors={[C.marca + '12', C.marca + '00']}
        start={{ x: 1, y: 0 }}
        end={{ x: 0.1, y: 0.6 }}
        style={[StyleSheet.absoluteFill, { height: '60%' }]}
      />

      {/* Un respiro claro abajo, para que el contenido no quede
          flotando sobre un gris plano al final del scroll. */}
      <LinearGradient
        colors={['#FFFFFF00', '#FFFFFF80']}
        style={[StyleSheet.absoluteFill, { top: '60%' }]}
      />
    </View>
  );
}
