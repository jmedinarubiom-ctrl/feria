import React, { useState } from 'react';
import {
  Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { C, E, R, T, clp } from '../tema';
import { Cargando, NoCargo } from '../ui';
import { useRecurso } from './cargar';
import { useCliente } from './estado';
import { MasRedondo, useRellenoPestanas } from './piezas';
import { Foto } from '../producto';
import { simboloProducto } from '../simbolos';
import { Icono, iconoDeRubro } from '../iconos';

/**
 * Inicio del cliente: saludo, buscador, rubros y el estado de la feria.
 *
 * El mockup tiene acá un listado de «ferias cercanas» para elegir.
 * Nuestro modelo trabaja con una sola feria y el cliente nunca elige
 * puesto —de eso se encarga el broadcast—, así que ese bloque pasó a
 * mostrar la feria y si está tomando pedidos.
 */
const BASICOS = ['p-tomate', 'p-papa', 'p-cebolla', 'p-palta', 'p-limon', 'p-platano', 'p-huevos', 'p-lechuga'];

export default function Inicio({ navegar }: { navegar: (p: string, args?: any) => void }) {
  const { datos: catalogo, error, recargar } = useRecurso<any[]>('/catalogo');
  const { feriaId } = useCliente();
  const { datos: feria } = useRecurso<any>(`/feria/estado?feria=${encodeURIComponent(feriaId)}`);
  const [busqueda, setBusqueda] = useState('');
  const { perfil, unidades, agregar } = useCliente();
  const relleno = useRellenoPestanas();

  if (error) return <NoCargo error={error} onReintentar={recargar} />;
  if (!catalogo) return <Cargando />;

  const productos = catalogo.flatMap((r: any) =>
    r.productos.map((p: any) => ({ ...p, rubro: r.nombre })));
  // Lo que casi todo el mundo lleva de la feria, para partir el
  // pedido sin entrar rubro por rubro.
  const basicos = BASICOS
    .map((id) => productos.find((p: any) => p.id === id))
    .filter(Boolean);
  const encontrados = busqueda.trim()
    ? productos.filter((p: any) =>
        p.nombre.toLowerCase().includes(busqueda.trim().toLowerCase()))
    : [];

  return (
    <ScrollView
      style={e.pantalla}
      contentContainerStyle={[e.relleno, { paddingBottom: relleno + E.l }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={e.saludo}>
        <View style={{ flex: 1 }}>
          <Text style={T.titulo}>
            Hola{perfil.nombre ? `, ${perfil.nombre.split(' ')[0]}` : ''}
          </Text>
          <Text style={T.apoyo}>¿Qué te gustaría comprar hoy?</Text>
        </View>
        {/* El carro se llega también desde acá: la pestaña de abajo
            lleva el número, pero el gesto natural es el de arriba. */}
        <Pressable onPress={() => navegar('Carrito')} style={e.avatar} hitSlop={6}>
          <Icono nombre="canasto" tamano={20} color={C.verdeOscuro} />
          {unidades > 0 ? (
            <View style={e.globo}><Text style={e.globoTexto}>{unidades}</Text></View>
          ) : null}
        </Pressable>
        <Pressable onPress={() => navegar('Perfil')} style={e.avatar}>
          <Text style={e.inicial}>
            {(perfil.nombre || '?').trim().charAt(0).toUpperCase()}
          </Text>
        </Pressable>
      </View>

      <View style={e.buscador}>
        <Icono nombre="buscar" tamano={18} color={C.textoSuave} />
        <TextInput
          style={e.campoBusqueda}
          value={busqueda}
          onChangeText={setBusqueda}
          placeholder="Buscar productos"
          placeholderTextColor={C.textoSuave}
          returnKeyType="search"
        />
      </View>

      {encontrados.length > 0 ? (
        <View style={e.resultados}>
          {encontrados.slice(0, 8).map((p: any) => (
            <Pressable
              key={p.id}
              onPress={() => { setBusqueda(''); navegar('Producto', { producto: p }); }}
              style={e.resultado}
            >
              <Text style={{ fontSize: 18 }}>{simboloProducto(p) ?? '•'}</Text>
              <Text style={[T.cuerpo, { flex: 1 }]} numberOfLines={1}>{p.nombre}</Text>
              <Text style={[T.cifraChica, { color: C.verde }]}>{clp(p.precio_venta)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Portada */}
      <View style={e.portada}>
        <Image
          source={require('../../assets/logo-marca.png')}
          style={e.portadaManzana}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
        <Text style={[T.encabezado, { color: '#FFFFFF' }]}>Productos frescos de la feria</Text>
        <Text style={[T.apoyo, { color: 'rgba(255,255,255,0.85)' }]}>
          Precio fijo, sin importar el puesto
        </Text>
      </View>

      <Text style={[T.seccion, { marginBottom: E.m }]}>Rubros</Text>
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={e.carril} contentContainerStyle={e.grilla}
      >
        {catalogo.map((r: any) => (
          <Pressable
            key={r.id}
            onPress={() => navegar('Categoria', { rubroId: r.id, nombre: r.nombre })}
            style={({ pressed }) => [e.rubro, pressed && { opacity: 0.7 }]}
          >
            <View style={[e.rubroIcono, { backgroundColor: iconoDeRubro(r.id).fondo }]}>
              <Icono nombre={iconoDeRubro(r.id).icono} tamano={24} color={iconoDeRubro(r.id).color} />
            </View>
            <Text style={[T.micro, { color: C.texto, textAlign: 'center' }]} numberOfLines={2}>
              {r.nombre}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {basicos.length ? (
        <>
          <Text style={[T.seccion, { marginBottom: E.m }]}>Lo de siempre</Text>
          <ScrollView
            horizontal showsHorizontalScrollIndicator={false}
            style={e.carril} contentContainerStyle={e.grilla}
          >
            {basicos.map((p: any) => (
              <Pressable
                key={p.id}
                onPress={() => navegar('Producto', { producto: p })}
                style={({ pressed }) => [e.basico, pressed && { opacity: 0.85 }]}
              >
                <Foto url={p.imagen_url} productoId={p.id} alto={92} radio={R.chico}
                      simbolo={simboloProducto(p)} />
                <Text style={[T.cuerpo, { marginTop: E.s }]} numberOfLines={1}>{p.nombre}</Text>
                <Text style={T.micro} numberOfLines={1}>{p.formato}</Text>
                <View style={e.basicoPie}>
                  <Text style={[T.cifraChica, { color: C.verde }]}>{clp(p.precio_venta)}</Text>
                  <MasRedondo onPress={() => agregar(p.id)} />
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </>
      ) : null}

      <Text style={[T.seccion, { marginBottom: E.m }]}>Tu feria</Text>
      <Pressable onPress={() => navegar('Feria')} style={e.tarjetaFeria}>
        <View style={e.miniFoto}>
          <Image
            source={require('../../assets/logo-marca.png')}
            style={{ width: 34, height: 34 }}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={T.encabezado}>{feria?.nombre ?? 'Tu feria'}</Text>
          <Text style={[T.micro, {
            color: feria?.aceptandoPedidos ? C.verde : C.naranja,
          }]}>
            {feria
              ? feria.aceptandoPedidos ? 'Abierta ahora' : 'Cerrada'
              : '…'}
          </Text>
        </View>
        <Icono nombre="adelante" tamano={20} color={C.textoSuave} />
      </Pressable>
    </ScrollView>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  relleno: { padding: E.l },
  saludo: { flexDirection: 'row', alignItems: 'center', gap: E.m, marginBottom: E.l },
  avatar: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: C.verdeSuave,
    alignItems: 'center', justifyContent: 'center',
  },
  inicial: { fontFamily: T.destacado.fontFamily, color: C.verdeOscuro, fontSize: 17 },
  globo: {
    position: 'absolute', top: -2, right: -2,
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: C.marca, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: C.fondo,
  },
  globoTexto: {
    color: '#FFFFFF', fontFamily: T.destacado.fontFamily, fontSize: 10, lineHeight: 13,
  },

  buscador: {
    flexDirection: 'row', alignItems: 'center', gap: E.s,
    backgroundColor: C.superficie, borderRadius: R.pastilla,
    borderWidth: 1, borderColor: C.borde,
    paddingHorizontal: E.l, marginBottom: E.l,
  },
  lupa: { color: C.textoSuave, fontSize: 18 },
  campoBusqueda: {
    flex: 1, paddingVertical: E.m,
    fontFamily: T.cuerpo.fontFamily, fontSize: 15, color: C.texto,
  },
  resultados: {
    backgroundColor: C.superficie, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, marginBottom: E.l, overflow: 'hidden',
  },
  resultado: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: E.l, paddingVertical: E.m,
    borderBottomWidth: 1, borderBottomColor: C.linea,
  },

  portada: {
    backgroundColor: C.verde, borderRadius: R.enorme,
    padding: E.xl, marginBottom: E.xl, overflow: 'hidden',
  },
  portadaManzana: {
    position: 'absolute', right: -24, top: -18,
    width: 150, height: 150, opacity: 0.18,
  },

  // Un carril que se desliza: cinco rubros en una grilla dejaban el
  // último solo en su fila, del doble de ancho que los demás.
  carril: { marginHorizontal: -E.l, marginBottom: E.xl, flexGrow: 0 },
  grilla: { flexDirection: 'row', gap: E.m, paddingHorizontal: E.l },
  rubro: {
    width: 96, alignItems: 'center', gap: E.s,
    paddingVertical: E.m, paddingHorizontal: E.xs,
    backgroundColor: C.superficie, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, userSelect: 'none',
  },
  rubroIcono: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: C.verdeSuave,
    alignItems: 'center', justifyContent: 'center',
  },

  basico: {
    width: 148, padding: E.s, backgroundColor: C.superficie, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde,
  },
  basicoPie: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: E.xs,
  },
  tarjetaFeria: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.m,
  },
  miniFoto: {
    width: 56, height: 56, borderRadius: R.chico, backgroundColor: C.verdeSuave,
    alignItems: 'center', justifyContent: 'center',
  },
  flecha: { color: C.textoSuave, fontSize: 22 },
});
