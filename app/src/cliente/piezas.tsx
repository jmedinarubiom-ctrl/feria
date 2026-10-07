import React from 'react';
import {
  Alert, Animated, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type ImageStyle, type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, E, FUENTES, R, T } from '../tema';
import { Icono } from '../iconos';
import { useRecurso } from './cargar';
import { useCliente } from './estado';

/**
 * Alto de la barra de pestañas sin el margen del indicador de inicio.
 *
 * La barra es propia, así que la navegación no le descuenta el
 * espacio a las pantallas: lo pide cada una con `useRellenoPestanas`.
 * Sin esto, la última fila de cualquier lista queda tapada.
 */
export const ALTO_PESTANAS = 55;

export function useRellenoPestanas(): number {
  const inset = useSafeAreaInsets();
  return ALTO_PESTANAS + Math.max(inset.bottom, E.s);
}

/**
 * Piezas visuales de la app del cliente.
 *
 * Son las del mockup: fotos de producto, calificación con estrella,
 * contador de cantidad y las píldoras de filtro.
 */

export function Estrella({ valor, reseñas }: { valor: number; reseñas?: number }) {
  return (
    <View style={e.fila}>
      <Text style={{ color: C.ambar, fontSize: 13 }}>★</Text>
      <Text style={[T.micro, { color: C.texto }]}>
        {valor.toFixed(1)}
        {reseñas != null ? <Text style={T.micro}> ({reseñas})</Text> : null}
      </Text>
    </View>
  );
}

/** Contador de cantidad: − valor + */
export function Contador({
  valor, onCambio, unidad, grande,
}: {
  valor: number;
  onCambio: (v: number) => void;
  unidad?: string;
  grande?: boolean;
}) {
  return (
    <View style={[e.contador, grande && e.contadorGrande]}>
      <Pressable onPress={() => onCambio(valor - 1)} hitSlop={8} style={e.botonContador}>
        <Text style={[e.signo, grande && { fontSize: 22 }]}>−</Text>
      </Pressable>
      <Text style={[grande ? T.destacado : T.cifraChica, { minWidth: 48, textAlign: 'center' }]}>
        {valor}{unidad ? ` ${unidad}` : ''}
      </Text>
      <Pressable onPress={() => onCambio(valor + 1)} hitSlop={8} style={e.botonContador}>
        <Text style={[e.signo, grande && { fontSize: 22 }]}>+</Text>
      </Pressable>
    </View>
  );
}

/** Botón redondo de «agregar», el que va sobre las tarjetas del catálogo. */
export function MasRedondo({ onPress }: { onPress: () => void }) {
  // Un rebote corto al agregar: sin él, tocar el «+» no se siente
  // como que pasó algo hasta mirar el número del carro.
  const escala = React.useRef(new Animated.Value(1)).current;
  const tocar = () => {
    Animated.sequence([
      Animated.timing(escala, { toValue: 1.25, duration: 90, useNativeDriver: true }),
      Animated.spring(escala, { toValue: 1, friction: 4, useNativeDriver: true }),
    ]).start();
    onPress();
  };
  return (
    <Pressable onPress={tocar} hitSlop={8} accessibilityLabel="Agregar al carrito">
      <Animated.View style={[e.mas, { transform: [{ scale: escala }] }]}>
        <Text style={{ color: '#FFFFFF', fontSize: 18, lineHeight: 20 }}>+</Text>
      </Animated.View>
    </Pressable>
  );
}

/** Píldoras de filtro: Todos · Frutas · Verduras */
export function Pildoras<T extends string>({
  opciones, valor, onCambio,
}: {
  opciones: Array<{ id: T; texto: string }>;
  valor: T;
  onCambio: (v: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={e.pildoras}
    >
      {opciones.map((o) => {
        const activa = o.id === valor;
        return (
          <Pressable
            key={o.id}
            onPress={() => onCambio(o.id)}
            style={[e.pildora, activa && { backgroundColor: C.verde, borderColor: C.verde }]}
          >
            <Text style={[T.micro, {
              color: activa ? '#FFFFFF' : C.textoSuave,
              fontFamily: T.destacado.fontFamily,
            }]}>
              {o.texto}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Campo de texto con rótulo arriba, el del formulario de entrega. */
export function Campo({
  etiqueta, ayuda, ...props
}: { etiqueta: string; ayuda?: string } & TextInputProps) {
  return (
    <View style={{ gap: E.xs }}>
      <Text style={T.seccion}>{etiqueta}</Text>
      <TextInput
        {...props}
        style={e.campo}
        placeholderTextColor={C.textoSuave}
      />
      {ayuda ? <Text style={T.micro}>{ayuda}</Text> : null}
    </View>
  );
}

/**
 * Marcar el teléfono.
 *
 * En un aparato sin app de llamadas —un simulador, una tablet— esto
 * rechaza la promesa y la app muestra un error rojo encima de todo.
 * Mejor mostrar el número para que se pueda copiar.
 */
export function llamar(numero: string): void {
  Linking.openURL(`tel:${numero.replace(/\s/g, '')}`).catch(() => {
    Alert.alert('Llamanos', numero);
  });
}

/** Pasos de un pedido en curso, como la línea del mockup. */
export function Pasos({ pasos, actual }: { pasos: string[]; actual: number }) {
  return (
    <View style={e.pasos}>
      {pasos.map((p, i) => (
        <View key={p} style={e.paso}>
          <View style={e.pasoLinea}>
            <View style={[e.lineaIzq, i === 0 && e.invisible,
                          i <= actual && i > 0 && { backgroundColor: C.verde }]} />
            <View style={[
              e.circulo,
              i < actual && { backgroundColor: C.verde, borderColor: C.verde },
              i === actual && { borderColor: C.verde, backgroundColor: C.superficie },
            ]}>
              {i < actual ? <Text style={e.tilde}>✓</Text> : null}
            </View>
            <View style={[e.lineaDer, i === pasos.length - 1 && e.invisible,
                          i < actual && { backgroundColor: C.verde }]} />
          </View>
          <Text style={[T.micro, {
            textAlign: 'center',
            color: i <= actual ? C.texto : C.textoSuave,
          }]}>
            {p}
          </Text>
        </View>
      ))}
    </View>
  );
}

const e = StyleSheet.create({
  enFeria: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: 3 },

  contador: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: C.borde, borderRadius: R.pastilla,
    paddingHorizontal: E.s, paddingVertical: 2, alignSelf: 'flex-start',
    backgroundColor: C.superficie,
  },
  contadorGrande: { paddingHorizontal: E.m, paddingVertical: E.s },
  botonContador: { paddingHorizontal: E.s, paddingVertical: 2, userSelect: 'none' },
  signo: { color: C.verde, fontSize: 18, lineHeight: 22 },

  mas: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: C.verde,
    alignItems: 'center', justifyContent: 'center', userSelect: 'none',
  },

  pildoras: { flexDirection: 'row', gap: E.s, paddingRight: E.l },
  pildora: {
    paddingHorizontal: E.l, paddingVertical: E.s,
    borderRadius: R.pastilla, borderWidth: 1, borderColor: C.borde,
    backgroundColor: C.superficie, userSelect: 'none',
  },

  campo: {
    backgroundColor: C.superficie,
    borderWidth: 1, borderColor: C.borde, borderRadius: R.medio,
    paddingHorizontal: E.l, paddingVertical: E.m,
    fontFamily: FUENTES.cuerpo, fontSize: 16, color: C.texto,
  },

  pasos: { flexDirection: 'row' },
  paso: { flex: 1, alignItems: 'center', gap: E.xs },
  pasoLinea: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  lineaIzq: { flex: 1, height: 2, backgroundColor: C.borde },
  lineaDer: { flex: 1, height: 2, backgroundColor: C.borde },
  invisible: { backgroundColor: 'transparent' },
  circulo: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: C.borde, backgroundColor: C.superficie,
    alignItems: 'center', justifyContent: 'center',
  },
  tilde: { color: '#FFFFFF', fontSize: 12, lineHeight: 14 },
});

/**
 * En qué feria se está comprando.
 *
 * El pedido sale de una feria concreta, con su horario y sus
 * puestos. Si eso no está a la vista en cada paso, alguien termina
 * pidiendo a una feria que no es la suya y se entera al pagar.
 */
export function useFeriaActual() {
  const { feriaId } = useCliente();
  const { datos } = useRecurso<any>(`/feria/estado?feria=${encodeURIComponent(feriaId)}`);
  return datos as null | {
    id: string; nombre: string; comuna?: string; aceptandoPedidos?: boolean;
  };
}

/** La feria en una línea: va bajo el título de cada paso de la compra. */
export function EnFeria({ nombre, prefijo = 'Comprando en', onPress, claro }: {
  /** Si no viene, se usa la feria elegida. */
  nombre?: string | null;
  prefijo?: string;
  onPress?: () => void;
  /** Sobre un fondo oscuro. */
  claro?: boolean;
}) {
  const actual = useFeriaActual();
  const texto = nombre ?? actual?.nombre;
  if (!texto) return null;
  const color = claro ? '#FFFFFF' : C.verdeOscuro;
  const fila = (
    <View style={e.enFeria}>
      <Icono nombre="feria" tamano={15} color={color} />
      <Text style={[T.micro, { color, flexShrink: 1 }]} numberOfLines={1}>
        {prefijo} <Text style={{ fontFamily: T.destacado.fontFamily, color }}>{texto}</Text>
      </Text>
    </View>
  );
  return onPress ? <Pressable onPress={onPress} hitSlop={8}>{fila}</Pressable> : fila;
}
