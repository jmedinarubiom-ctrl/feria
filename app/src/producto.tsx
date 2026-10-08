import React, { useEffect, useState } from 'react';
import {
  Image, StyleSheet, Text, View,
  type ImageStyle, type StyleProp, type ViewStyle,
} from 'react-native';

import { servidor, direccion } from './api';
import { C, R } from './tema';

/**
 * Dónde está la foto.
 *
 * El catálogo guarda `/fotos/…` para las que viven en el servidor
 * de la feria, sin el dominio. Cada aparato le pone adelante la
 * dirección por la que él llega — que en el teléfono de un feriante
 * es la IP del local, no `localhost`.
 */
export const urlDeFoto = (url?: string | null): string | null =>
  !url ? null : url.startsWith('/') ? direccion(url) : url;

/**
 * La foto de referencia del producto.
 *
 * Viene con el servidor, una por producto del catálogo. No es la
 * foto del puesto —el tomate que llega no es exactamente ese— pero
 * sirve para reconocer lo que se está comprando, que es para lo que
 * está. Si el producto no tiene, el servidor contesta 404 y la
 * pantalla cae al símbolo.
 */
export const urlDeReferencia = (productoId?: string | null): string | null =>
  productoId ? direccion(`/referencia/${encodeURIComponent(productoId)}`) : null;

/**
 * Foto del producto.
 *
 * Mientras el catálogo no tenga fotos muestra el símbolo del
 * producto; si no hay ni símbolo, la manzana de la marca.
 */
export function Foto({
  url, productoId, alto = 120, radio = R.medio, simbolo, style,
}: {
  url?: string | null;
  /** Para caer a la foto de referencia cuando no hay una propia. */
  productoId?: string | null;
  alto?: number;
  radio?: number;
  simbolo?: string | null;
  style?: StyleProp<ImageStyle & ViewStyle>;
}) {
  // Una foto que no carga —se borró del servidor, se cayó la red—
  // dejaba un rectángulo blanco sin explicación. Mejor volver al
  // símbolo, que es lo mismo que ve un producto sin foto.
  const [fallo, setFallo] = useState(false);
  const uri = urlDeFoto(url) ?? urlDeReferencia(productoId);
  useEffect(() => { setFallo(false); }, [uri]);

  if (uri && !fallo) {
    return (
      <Image
        source={{ uri }}
        style={[{ width: '100%', height: alto, borderRadius: radio }, style]}
        resizeMode="cover"
        onError={(e) => {
          console.warn('[foto] no cargó', uri, e.nativeEvent?.error);
          setFallo(true);
        }}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View style={[
      { width: '100%', height: alto, borderRadius: radio, backgroundColor: C.verdeSuave },
      e.centrado, style,
    ]}>
      {simbolo ? (
        <Text style={{ fontSize: alto * 0.44 }}>{simbolo}</Text>
      ) : (
        <Image
          source={require('../assets/logo-marca.png')}
          style={{ width: alto * 0.42, height: alto * 0.42, opacity: 0.3 }}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      )}
    </View>
  );
}

const e = StyleSheet.create({
  centrado: { alignItems: 'center', justifyContent: 'center' },
});
