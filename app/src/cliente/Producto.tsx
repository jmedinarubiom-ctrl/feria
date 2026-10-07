import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, E, R, T, clp } from '../tema';
import { Boton } from '../ui';
import { Contador, EnFeria } from './piezas';
import { Foto } from '../producto';
import { simboloProducto } from '../simbolos';
import { useCliente } from './estado';
import { Icono } from '../iconos';

/**
 * Detalle del producto.
 *
 * El mockup muestra acá el puesto que lo vende. En nuestro modelo el
 * cliente no elige puesto —el pedido se ofrece a todos los del rubro
 * y lo toma el primero que acepta—, así que ese bloque informa el
 * precio fijo de plataforma y el horario de entrega.
 */
export default function Producto({
  producto, navegar, volver,
}: {
  producto: any;
  navegar: (p: string, args?: any) => void;
  volver: () => void;
}) {
  const { agregar } = useCliente();
  const [cantidad, setCantidad] = useState(1);
  const inset = useSafeAreaInsets();

  return (
    <View style={e.pantalla}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: 100 + inset.bottom }}>
        <View>
          <Foto
            url={producto.imagen_url}
            productoId={producto.id}
            alto={300}
            radio={0}
            simbolo={simboloProducto(producto)}
          />
          <Pressable onPress={volver} style={[e.flotanteIzq]} hitSlop={10}>
            <Icono nombre="atras" tamano={22} color={C.texto} />
          </Pressable>
        </View>

        <View style={e.cuerpo}>
          <EnFeria prefijo="Disponible en" />
          <Text style={[T.titulo, { marginTop: E.xs }]}>{producto.nombre}</Text>
          <Text style={[T.cifraMedia, { color: C.verde, marginTop: E.xs }]}>
            {clp(producto.precio_venta)}
            <Text style={T.apoyo}>  {producto.formato}</Text>
          </Text>

          <Text style={[T.cuerpo, { marginTop: E.l }]}>
            Fresco del día, comprado en la feria la misma mañana de la entrega.
          </Text>

          <View style={e.datos}>
            <View style={e.dato}>
              <Text style={T.seccion}>Precio</Text>
              <Text style={[T.destacado, { marginTop: 2 }]}>Fijo de plataforma</Text>
              <Text style={T.micro}>Igual en todos los puestos</Text>
            </View>
            <View style={e.dato}>
              <Text style={T.seccion}>Entrega</Text>
              <Text style={[T.destacado, { marginTop: 2 }]}>El mismo día</Text>
              <Text style={T.micro}>Dentro del horario de feria</Text>
            </View>
          </View>

          <View style={{ marginTop: E.xl, alignItems: 'center' }}>
            <Contador valor={cantidad} onCambio={(v) => setCantidad(Math.max(1, v))} grande />
          </View>
        </View>
      </ScrollView>

      <View style={[e.pie, { bottom: 0, paddingBottom: Math.max(inset.bottom, E.l) }]}>
        <Boton
          titulo={`AGREGAR · ${clp(producto.precio_venta * cantidad)}`}
          onPress={() => { agregar(producto.id, cantidad); volver(); }}
        />
      </View>
    </View>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  flotanteIzq: {
    position: 'absolute', top: E.m, left: E.l,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  flecha: { fontSize: 26, color: C.texto, lineHeight: 28 },
  cuerpo: {
    backgroundColor: C.superficie,
    borderTopLeftRadius: R.enorme, borderTopRightRadius: R.enorme,
    marginTop: -E.xl, padding: E.xl,
    // Que la hoja blanca llegue hasta abajo aunque el texto sea corto.
    flexGrow: 1,
  },
  datos: { flexDirection: 'row', gap: E.m, marginTop: E.l },
  dato: {
    flex: 1, backgroundColor: C.fondo, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, padding: E.m,
  },
  pie: {
    position: 'absolute', left: 0, right: 0,
    paddingHorizontal: E.l, paddingTop: E.m,
    backgroundColor: C.fondo,
    borderTopWidth: 1, borderTopColor: C.borde,
  },
});
