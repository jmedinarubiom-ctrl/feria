import React, { useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';

import * as ImagePicker from 'expo-image-picker';

import { api, useTablero } from '../api';
import { C, E, FUENTES, R, T, clp } from '../tema';
import { Aviso, Boton, Cargando, Fila, Seccion, Tarjeta } from '../ui';
import { Foto } from '../producto';
import { simboloProducto } from '../simbolos';

/**
 * Administración del catálogo.
 *
 * Los precios de feria cambian todas las semanas, así que esta
 * pantalla se usa parado en la calle un viernes. La prioridad es
 * ver el margen mientras se escribe y guardar de a un producto, no
 * llenar un formulario largo y apretar «guardar todo».
 */
export default function Catalogo() {
  const { datos, error, cargando, recargar } =
    useTablero('/operador/catalogo', 'operador', 'operador');
  type Borrador = { venta: string; costo: string };
  const [borradores, setBorradores] = useState<Record<string, Borrador>>({});
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [agregando, setAgregando] = useState(false);

  if (cargando) return <Cargando />;
  if (error) return <View style={e.pantalla}><View style={e.relleno}><Aviso texto={error} /></View></View>;

  const editar = (id: string, campo: keyof Borrador, valor: string, actual: any) => {
    // Los precios son números; la foto es una dirección y va tal cual.
    const limpio = valor.replace(/\D/g, '').slice(0, 7);
    setBorradores((b) => ({
      ...b,
      [id]: {
        venta: b[id]?.venta ?? String(actual.precio_venta),
        costo: b[id]?.costo ?? String(actual.precio_costo),
        [campo]: limpio,
      },
    }));
  };

  const guardar = async (p: any) => {
    const b = borradores[p.id];
    if (!b) return;
    setOcupado(p.id);
    try {
      await api('POST', `/operador/productos/${p.id}`, {
        cuerpo: { precioVenta: Number(b.venta), precioCosto: Number(b.costo) },
      });
      setBorradores(({ [p.id]: _, ...resto }) => resto);
      await recargar();
    } catch (err: any) {
      Alert.alert('No se pudo guardar', err.message);
    } finally {
      setOcupado(null);
    }
  };

  /**
   * Saca o elige la foto y la sube.
   *
   * El operador está parado en el puesto con el producto adelante:
   * lo natural es la cámara. El carrete queda para cuando ya la
   * sacó antes.
   */
  const cargarFoto = async (p: any, desde: 'camara' | 'carrete') => {
    const permiso = desde === 'camara'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permiso.granted) {
      return Alert.alert('Sin permiso',
        'Se activa desde los ajustes del teléfono, en los permisos de Feria.');
    }

    const abrir = desde === 'camara'
      ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    const r = await abrir({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      // Una foto de catálogo se ve a 100 px: no hace falta mandar
      // los cuatro megapíxeles de la cámara por la red de la feria.
      quality: 0.6,
      base64: true,
    });
    if (r.canceled || !r.assets?.[0]?.base64) return;

    setOcupado(p.id);
    try {
      const { camino } = await api('POST', '/operador/fotos', {
        cuerpo: { datos: r.assets[0].base64 },
      });
      await api('POST', `/operador/productos/${p.id}`, { cuerpo: { imagenUrl: camino } });
      await recargar();
    } catch (err: any) {
      Alert.alert('No se pudo subir la foto', err.message);
    } finally {
      setOcupado(null);
    }
  };

  const elegirFoto = (p: any) => Alert.alert('Foto del producto', p.nombre, [
    { text: 'Sacar una foto', onPress: () => void cargarFoto(p, 'camara') },
    { text: 'Elegir del carrete', onPress: () => void cargarFoto(p, 'carrete') },
    ...(p.imagen_url
      ? [{
          text: 'Sacar la foto',
          style: 'destructive' as const,
          onPress: () => void accionFoto(p, ''),
        }]
      : []),
    { text: 'Cancelar', style: 'cancel' as const },
  ]);

  const accionFoto = async (p: any, url: string) => {
    setOcupado(p.id);
    try {
      await api('POST', `/operador/productos/${p.id}`, { cuerpo: { imagenUrl: url } });
      await recargar();
    } catch (err: any) {
      Alert.alert('No se pudo', err.message);
    } finally {
      setOcupado(null);
    }
  };

  const alternar = async (p: any) => {
    setOcupado(p.id);
    try {
      await api('POST', `/operador/productos/${p.id}`, { cuerpo: { activo: !p.activo } });
      await recargar();
    } catch (err: any) {
      Alert.alert('No se pudo cambiar', err.message);
    } finally {
      setOcupado(null);
    }
  };

  return (
    <KeyboardAvoidingView
      style={e.pantalla}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={e.relleno} keyboardShouldPersistTaps="handled">
        <Text style={[T.apoyo, { marginBottom: E.l }]}>
          Toca un precio para cambiarlo. El margen se recalcula mientras escribes.
        </Text>

        {agregando ? (
          <NuevoProducto
            rubros={datos.todosLosRubros}
            onListo={async () => { setAgregando(false); await recargar(); }}
            onCancelar={() => setAgregando(false)}
          />
        ) : (
          <View style={{ marginBottom: E.xl }}>
            <Boton titulo="+ AGREGAR PRODUCTO" variante="secundario"
                   onPress={() => setAgregando(true)} />
          </View>
        )}

        {datos.rubros.map((rubro: any) => (
          <Seccion
            key={rubro.id}
            titulo={rubro.nombre}
            accesorio={
              <Text style={T.micro}>
                {rubro.activos} activos · margen {(rubro.tasaMargen * 100).toFixed(0)}%
              </Text>
            }
          >
            {rubro.productos.map((p: any, i: number) => {
              const b = borradores[p.id];
              const venta = Number(b?.venta ?? p.precio_venta) || 0;
              const costo = Number(b?.costo ?? p.precio_costo) || 0;
              const margen = venta - costo;
              const tasa = venta > 0 ? margen / venta : 0;
              const sucio = !!b && (venta !== p.precio_venta || costo !== p.precio_costo);

              return (
                <Fila key={p.id} ultima={i === rubro.productos.length - 1}
                      style={!p.activo && { opacity: 0.45 }}>
                  <View style={e.entre}>
                    {/* Tocar la foto la cambia: es el gesto que la
                        gente ya busca, y evita un botón más en una
                        fila que ya tiene seis cosas. */}
                    <Pressable
                      onPress={() => elegirFoto(p)}
                      disabled={ocupado === p.id}
                      accessibilityLabel={`Cambiar la foto de ${p.nombre}`}
                    >
                      <Foto
                        url={p.imagen_url}
                        alto={46}
                        radio={R.chico}
                        productoId={p.id}
                        simbolo={simboloProducto(p)}
                        style={{ width: 46 }}
                      />
                    </Pressable>
                    <View style={{ flex: 1 }}>
                      <Text style={T.encabezado}>{p.nombre}</Text>
                      <Text style={T.apoyo}>{p.formato}</Text>
                    </View>
                    <Switch
                      value={!!p.activo}
                      disabled={ocupado === p.id}
                      trackColor={{ true: C.verde, false: C.superficieAlta }}
                      thumbColor="#FFFFFF"
                      ios_backgroundColor={C.superficieAlta}
                      onValueChange={() => alternar(p)}
                    />
                  </View>

                  <View style={e.precios}>
                    <Campo etiqueta="Le cobras" valor={b?.venta ?? String(p.precio_venta)}
                           onCambio={(v) => editar(p.id, 'venta', v, p)} />
                    <Campo etiqueta="Le pagas" valor={b?.costo ?? String(p.precio_costo)}
                           onCambio={(v) => editar(p.id, 'costo', v, p)} />
                    <View style={{ flex: 1 }}>
                      <Text style={T.seccion}>Margen</Text>
                      <Text style={[T.cifraChica, {
                        marginTop: E.s,
                        color: margen <= 0 ? C.rojo : tasa < 0.2 ? C.naranja : C.verdeOscuro,
                      }]}>
                        {clp(margen)}
                      </Text>
                      <Text style={T.micro}>{(tasa * 100).toFixed(0)}%</Text>
                    </View>
                  </View>

                  {margen <= 0 ? (
                    <View style={{ marginTop: E.m }}>
                      <Aviso texto="Vendiendo bajo el costo: pierdes en cada unidad." />
                    </View>
                  ) : null}

                  {sucio ? (
                    <View style={e.acciones}>
                      <View style={{ flex: 1 }}>
                        <Boton
                          titulo={ocupado === p.id ? 'GUARDANDO…' : 'GUARDAR'}
                          onPress={() => guardar(p)}
                          deshabilitado={ocupado === p.id || margen < 0}
                        />
                      </View>
                      <Pressable
                        onPress={() => setBorradores(({ [p.id]: _, ...r }) => r)}
                        style={e.descartar}
                      >
                        <Text style={T.apoyo}>Descartar</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </Fila>
              );
            })}
          </Seccion>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Campo({ etiqueta, valor, onCambio }: {
  etiqueta: string; valor: string; onCambio: (v: string) => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={T.seccion}>{etiqueta}</Text>
      <TextInput style={e.campo} value={valor} onChangeText={onCambio}
                 keyboardType="number-pad" selectTextOnFocus />
    </View>
  );
}

function NuevoProducto({ rubros, onListo, onCancelar }: {
  rubros: any[]; onListo: () => void; onCancelar: () => void;
}) {
  const [rubroId, setRubroId] = useState(rubros[0]?.id ?? '');
  const [nombre, setNombre] = useState('');
  const [formato, setFormato] = useState('');
  const [venta, setVenta] = useState('');
  const [costo, setCosto] = useState('');
  const [imagen, setImagen] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const guardar = async () => {
    setOcupado(true);
    try {
      await api('POST', '/operador/productos', {
        cuerpo: {
          rubroId, nombre, formato,
          precioVenta: Number(venta), precioCosto: Number(costo),
          imagenUrl: imagen,
        },
      });
      onListo();
    } catch (err: any) {
      Alert.alert('No se pudo agregar', err.message);
    } finally {
      setOcupado(false);
    }
  };

  const listo = nombre.trim() && formato.trim() && Number(venta) > 0 && Number(costo) > 0;

  return (
    <Tarjeta style={{ marginBottom: E.xl, borderColor: C.verde + '55' }}>
      <Text style={T.seccion}>Producto nuevo</Text>

      <View style={e.rubros}>
        {rubros.map((r: any) => (
          <Pressable
            key={r.id}
            onPress={() => setRubroId(r.id)}
            style={[e.rubro, rubroId === r.id && {
              borderColor: C.verde, backgroundColor: C.verdeSuave,
            }]}
          >
            <Text style={[T.micro, { color: rubroId === r.id ? C.verdeOscuro : C.textoSuave }]}>
              {r.nombre}
            </Text>
          </Pressable>
        ))}
      </View>

      <TextInput style={e.campoAncho} value={nombre} onChangeText={setNombre}
                 placeholder="Nombre — ej. Choclo" placeholderTextColor={C.textoSuave} />
      <TextInput style={e.campoAncho} value={formato} onChangeText={setFormato}
                 placeholder="Formato — ej. Docena" placeholderTextColor={C.textoSuave} />

      <TextInput style={e.campoAncho} value={imagen} onChangeText={setImagen}
                 placeholder="Foto — https://… (opcional)" placeholderTextColor={C.textoSuave}
                 autoCapitalize="none" autoCorrect={false} keyboardType="url" />

      <View style={e.precios}>
        <Campo etiqueta="Le cobras" valor={venta}
               onCambio={(v) => setVenta(v.replace(/\D/g, ''))} />
        <Campo etiqueta="Le pagas" valor={costo}
               onCambio={(v) => setCosto(v.replace(/\D/g, ''))} />
      </View>

      <View style={{ marginTop: E.l, gap: E.s }}>
        <Boton titulo={ocupado ? 'GUARDANDO…' : 'AGREGAR'} onPress={guardar}
               deshabilitado={!listo || ocupado} />
        <Boton titulo="Cancelar" variante="secundario" onPress={onCancelar} />
      </View>
    </Tarjeta>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: 'transparent' },
  relleno: { padding: E.l, paddingBottom: E.xxxl },
  entre: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: E.m,
  },
  precios: { flexDirection: 'row', gap: E.m, marginTop: E.m, alignItems: 'flex-start' },
  acciones: { marginTop: E.m, flexDirection: 'row', gap: E.s },
  campo: {
    backgroundColor: C.superficieAlta, borderWidth: 1, borderColor: C.borde,
    borderRadius: R.chico, paddingHorizontal: E.m, paddingVertical: E.s + 2,
    fontFamily: FUENTES.cuerpoFuerte, fontSize: 17, color: C.texto, marginTop: E.xs,
  },
  campoAncho: {
    backgroundColor: C.superficieAlta, borderWidth: 1, borderColor: C.borde,
    borderRadius: R.medio, paddingHorizontal: E.m + 2, paddingVertical: E.m,
    fontFamily: FUENTES.cuerpo, fontSize: 16, color: C.texto, marginTop: E.s,
  },
  rubros: { flexDirection: 'row', flexWrap: 'wrap', gap: E.s, marginTop: E.s },
  rubro: {
    borderWidth: 1, borderColor: C.borde, borderRadius: R.pastilla,
    paddingHorizontal: E.m, paddingVertical: 6, userSelect: 'none',
  },
  descartar: { justifyContent: 'center', paddingHorizontal: E.m, userSelect: 'none' },
});
