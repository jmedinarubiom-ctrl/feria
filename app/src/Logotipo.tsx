import React from 'react';
import { Image, StyleSheet, View } from 'react-native';

/**
 * El logotipo.
 *
 * Es el archivo original recortado y con el fondo transparente —ver
 * `herramientas/preparar-logo.ts`—, no un dibujo aproximado: la
 * manzana lleva frutas y verduras adentro y redibujarla a mano
 * daría algo parecido pero distinto, que es peor que usar la marca
 * de verdad.
 */

/** Relación de aspecto de los recortes, para no deformarlos. */
const PROPORCION_COMPLETO = 284 / 489;
const PROPORCION_MARCA = 266 / 302;

/** Solo la manzana, sin el texto. */
export function Manzana({ tamano }: { tamano: number }) {
  return (
    <Image
      source={require('../assets/logo-marca.png')}
      style={{ width: tamano * PROPORCION_MARCA, height: tamano }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  );
}

export function Logotipo({
  tamano = 180,
  orientacion = 'vertical',
}: {
  tamano?: number;
  orientacion?: 'vertical' | 'compacto';
}) {
  if (orientacion === 'compacto') {
    return (
      <View style={e.centrado}>
        <Manzana tamano={tamano} />
      </View>
    );
  }
  return (
    <View style={e.centrado}>
      <Image
        source={require('../assets/logo.png')}
        style={{ width: tamano * PROPORCION_COMPLETO, height: tamano }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const e = StyleSheet.create({
  centrado: { alignItems: 'center' },
});
