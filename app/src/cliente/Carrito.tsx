import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '../api';
import { C, E, R, T, clp } from '../tema';
import { Boton, Cargando, Vacio } from '../ui';
import { Contador, EnFeria } from './piezas';
import { Foto } from '../producto';
import { simboloProducto } from '../simbolos';
import { useCliente } from './estado';
import { Icono } from '../iconos';
import { activarPush } from '../notificaciones';

/** El carro, con la cotización que hace el servidor. */
export default function Carrito({
  navegar, volver,
}: {
  navegar: (p: string, args?: any) => void;
  volver: () => void;
}) {
  const { carro, fijarCantidad, vaciar, unidades, feriaId } = useCliente();

  // Con productos en el carrito tiene sentido pedir permiso para
  // avisar: «tu carrito te espera», «tu pedido va en camino». Antes
  // se pedía recién en el seguimiento, y quien dejaba el carrito a
  // medias nunca llegaba ahí.
  const hayProductos = unidades > 0;
  useEffect(() => {
    if (hayProductos) void activarPush('cliente').catch(() => {});
  }, [hayProductos]);
  const inset = useSafeAreaInsets();
  const [catalogo, setCatalogo] = useState<any[] | null>(null);
  const [cotizacion, setCotizacion] = useState<any>(null);
  const [feria, setFeria] = useState<any>(null);

  useEffect(() => {
    api('GET', '/catalogo').then(setCatalogo).catch(() => {});
    api('GET', `/feria/estado?feria=${encodeURIComponent(feriaId)}`).then(setFeria).catch(() => {});
  }, [feriaId]);

  const productos = (catalogo ?? []).flatMap((r: any) => r.productos);
  const lineas = Object.entries(carro)
    .map(([id, cantidad]) => ({ p: productos.find((x: any) => x.id === id), cantidad }))
    .filter((l) => l.p);
  const totalProductos = lineas.reduce((a, l) => a + l.p.precio_venta * l.cantidad, 0);

  // La cotización la hace el servidor: el despacho y el mínimo son
  // una sola regla y duplicarla acá sería la forma más fácil de que
  // un día no coincidan.
  useEffect(() => {
    if (totalProductos === 0) return setCotizacion(null);
    let vigente = true;
    api('GET', `/cotizar/${totalProductos}`)
      .then((c) => { if (vigente) setCotizacion(c); })
      .catch(() => {});
    return () => { vigente = false; };
  }, [totalProductos]);

  if (!catalogo) return <Cargando />;

  const cerrada = feria && !feria.aceptandoPedidos;

  return (
    <View style={e.pantalla}>
      <View style={e.cabecera}>
        <Pressable onPress={volver} hitSlop={10} style={e.atras}>
          <Icono nombre="atras" tamano={22} color={C.texto} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={T.encabezado}>Tu carrito</Text>
          <EnFeria />
        </View>
        {unidades > 0 ? (
          <Pressable onPress={vaciar} hitSlop={10}>
            <Text style={[T.micro, { color: C.rojo }]}>Vaciar</Text>
          </Pressable>
        ) : null}
      </View>

      {unidades === 0 ? (
        <View style={{ padding: E.l }}>
          <Vacio texto="Tu carrito está vacío. Agrega productos de la feria." />
          <View style={{ marginTop: E.l }}>
            <Boton titulo="Ver la feria" variante="secundario" onPress={volver} />
          </View>
        </View>
      ) : (
        <>
          <ScrollView
            contentContainerStyle={[e.relleno, { paddingBottom: 110 + inset.bottom }]}
          >
            <View style={e.lista}>
              {lineas.map((l, i) => (
                <View key={l.p.id} style={[e.linea, i < lineas.length - 1 && e.conLinea]}>
                  <Foto
                    url={l.p.imagen_url}
                    alto={60}
                    radio={R.chico}
                    productoId={l.p.id}
                    simbolo={simboloProducto(l.p)}
                    style={{ width: 60 }}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={T.destacado} numberOfLines={1}>{l.p.nombre}</Text>
                    <Text style={T.micro}>{l.p.formato}</Text>
                    <Text style={[T.cifraChica, { color: C.verde }]}>
                      {clp(l.p.precio_venta * l.cantidad)}
                    </Text>
                  </View>
                  <Contador
                    valor={l.cantidad}
                    onCambio={(v) => fijarCantidad(l.p.id, v)}
                  />
                </View>
              ))}
            </View>

            {cotizacion ? (
              <View style={e.resumen}>
                <Text style={T.seccion}>Resumen</Text>
                <Linea etiqueta={`${unidades} ${unidades === 1 ? 'producto' : 'productos'}`}
                       valor={clp(cotizacion.totalProductos)} />
                <Linea
                  etiqueta="Despacho"
                  valor={cotizacion.despacho === 0 ? 'Gratis' : clp(cotizacion.despacho)}
                  destacado={cotizacion.despacho === 0}
                />
                <View style={e.separador} />
                <Linea etiqueta="Total" valor={clp(cotizacion.total)} grande />

                {/* Es la razón por la que el cliente agrega una malla más. */}
                {cotizacion.faltaParaGratis > 0 && cotizacion.alcanzaMinimo ? (
                  <View style={e.franja}>
                    <Text style={[T.micro, { color: C.naranja, textAlign: 'center' }]}>
                      Agrega {clp(cotizacion.faltaParaGratis)} más y el despacho va gratis
                    </Text>
                  </View>
                ) : null}

                {!cotizacion.alcanzaMinimo ? (
                  <View style={[e.franja, { backgroundColor: C.rojoSuave }]}>
                    <Text style={[T.micro, { color: C.rojo, textAlign: 'center' }]}>
                      El pedido mínimo es {clp(cotizacion.minimo)} · te faltan{' '}
                      {clp(cotizacion.minimo - cotizacion.totalProductos)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {cerrada ? (
              <View style={[e.franja, { backgroundColor: C.rojoSuave, marginTop: E.m }]}>
                <Text style={[T.micro, { color: C.rojo, textAlign: 'center' }]}>
                  {feria.mensaje}
                </Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={[e.pie, { bottom: 0, paddingBottom: Math.max(inset.bottom, E.l) }]}>
            <Boton
              titulo={cerrada ? 'FERIA CERRADA' : 'IR A PAGAR'}
              onPress={() => navegar('Pago')}
              deshabilitado={cerrada || !cotizacion?.alcanzaMinimo}
            />
          </View>
        </>
      )}
    </View>
  );
}

export function Linea({ etiqueta, valor, destacado, grande }: {
  etiqueta: string; valor: string; destacado?: boolean; grande?: boolean;
}) {
  return (
    <View style={e.entre}>
      <Text style={grande ? T.destacado : T.apoyo}>{etiqueta}</Text>
      <Text style={[
        grande ? T.cifraMedia : T.cifraChica,
        destacado && { color: C.verde },
      ]}>
        {valor}
      </Text>
    </View>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  cabecera: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    paddingHorizontal: E.l, paddingVertical: E.m,
  },
  atras: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  flecha: { fontSize: 26, color: C.texto, lineHeight: 28 },
  relleno: { padding: E.l, paddingTop: 0 },
  lista: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, paddingHorizontal: E.m,
  },
  linea: { flexDirection: 'row', alignItems: 'center', gap: E.m, paddingVertical: E.m },
  conLinea: { borderBottomWidth: 1, borderBottomColor: C.linea },
  resumen: {
    marginTop: E.l, gap: E.s,
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
  entre: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: E.s,
  },
  separador: { height: 1, backgroundColor: C.linea, marginVertical: E.xs },
  franja: {
    backgroundColor: C.naranjaSuave, borderRadius: R.chico,
    paddingVertical: E.s, paddingHorizontal: E.m,
  },
  pie: {
    position: 'absolute', left: 0, right: 0,
    paddingHorizontal: E.l, paddingTop: E.m,
    backgroundColor: C.fondo,
    borderTopWidth: 1, borderTopColor: C.borde,
  },
});
