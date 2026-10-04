import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';


import { C, E, R, T, clp } from '../tema';
import { Cargando, NoCargo } from '../ui';
import { useRecurso } from './cargar';
import { MasRedondo, Pildoras } from './piezas';
import { Foto } from '../producto';
import { simboloProducto } from '../simbolos';
import { useCliente } from './estado';

/** Grilla de productos de un rubro, con filtro y barra de carrito. */
export default function Categoria({
  rubroId, nombre, navegar, volver,
}: {
  rubroId: string;
  nombre: string;
  navegar: (p: string, args?: any) => void;
  volver: () => void;
}) {
  const { datos: catalogo, error, recargar } = useRecurso<any[]>('/catalogo');
  const [filtro, setFiltro] = useState<string>(rubroId);
  const { carro, agregar, unidades } = useCliente();
  const inset = useSafeAreaInsets();

  if (error) return <NoCargo error={error} onReintentar={recargar} />;
  if (!catalogo) return <Cargando />;

  const opciones = [
    { id: 'todos', texto: 'Todos' },
    ...catalogo.map((r: any) => ({ id: r.id, texto: r.nombre })),
  ];
  const productos = catalogo
    .filter((r: any) => filtro === 'todos' || r.id === filtro)
    .flatMap((r: any) => r.productos);

  // El carro puede tener cosas de otros rubros, así que el total se
  // calcula sobre el catálogo entero y no sobre lo que se ve en pantalla.
  const todos = catalogo.flatMap((r: any) => r.productos);
  const total = Object.entries(carro).reduce((acc, [id, cant]) => {
    const p = todos.find((x: any) => x.id === id);
    return acc + (p ? p.precio_venta * cant : 0);
  }, 0);

  return (
    <View style={e.pantalla}>
      <View style={e.cabecera}>
        <Pressable onPress={volver} hitSlop={10} style={e.atras}>
          <Text style={e.flecha}>‹</Text>
        </Pressable>
        <Text style={[T.encabezado, { flex: 1 }]}>{nombre}</Text>
      </View>

      <View style={{ paddingLeft: E.l, paddingBottom: E.m }}>
        <Pildoras opciones={opciones} valor={filtro} onCambio={setFiltro} />
      </View>

      <ScrollView
        contentContainerStyle={[
          e.relleno,
          { paddingBottom: unidades > 0 ? 100 + inset.bottom : E.xxl },
        ]}
      >
        <View style={e.grilla}>
          {productos.map((p: any) => (
            <Pressable
              key={p.id}
              onPress={() => navegar('Producto', { producto: p })}
              style={({ pressed }) => [e.tarjeta, pressed && { opacity: 0.85 }]}
            >
              <Foto
                url={p.imagen_url}
                productoId={p.id}
                alto={104}
                radio={R.chico}
                simbolo={simboloProducto(p)}
              />
              <Text style={[T.cuerpo, { marginTop: E.s }]} numberOfLines={1}>{p.nombre}</Text>
              <Text style={T.micro} numberOfLines={1}>{p.formato}</Text>
              <View style={e.precioFila}>
                <Text style={[T.cifraChica, { color: C.verde }]}>{clp(p.precio_venta)}</Text>
                <MasRedondo onPress={() => agregar(p.id)} />
              </View>
              {carro[p.id] ? (
                <Text style={[T.micro, { color: C.verdeOscuro }]}>
                  {carro[p.id]} en el carro
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {unidades > 0 ? (
        <Pressable
          onPress={() => navegar('Carrito')}
          style={[e.barraCarro, { bottom: Math.max(inset.bottom, E.l) }]}
        >
          <Text style={e.carroIcono}>🧺</Text>
          <View style={{ flex: 1 }}>
            <Text style={[T.micro, { color: 'rgba(255,255,255,0.85)' }]}>
              {unidades} {unidades === 1 ? 'producto' : 'productos'}
            </Text>
            <Text style={[T.destacado, { color: '#FFFFFF' }]}>{clp(total)}</Text>
          </View>
          <Text style={[T.destacado, { color: '#FFFFFF' }]}>Ver carrito ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  cabecera: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    paddingHorizontal: E.l, paddingTop: E.m, paddingBottom: E.m,
  },
  atras: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  flecha: { fontSize: 26, color: C.texto, lineHeight: 28 },
  relleno: { padding: E.l, paddingTop: 0 },
  grilla: { flexDirection: 'row', flexWrap: 'wrap', gap: E.m },
  tarjeta: {
    flexGrow: 1, flexBasis: '45%',
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.s + 2,
  },
  precioFila: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginTop: E.s,
  },
  barraCarro: {
    position: 'absolute', left: E.l, right: E.l,
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    backgroundColor: C.verde, borderRadius: R.enorme,
    paddingHorizontal: E.l, paddingVertical: E.m,
    shadowColor: C.sombra, shadowOpacity: 0.2,
    shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6,
    userSelect: 'none',
  },
  carroIcono: { fontSize: 20 },
});
