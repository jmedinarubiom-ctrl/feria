import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';

import { api } from '../api';
import { C, E, R, T, clp } from '../tema';
import { Boton, Cargando } from '../ui';
import { Campo } from './piezas';
import { Linea } from './Carrito';
import { useCliente, type Perfil } from './estado';

/**
 * Entrega y pago.
 *
 * El pedido se crea reservado y NO sale a la feria hasta que la
 * pasarela confirma: nadie aparta mercadería de algo sin pagar.
 * La tarjeta nunca pasa por la app — el pago es en la página de la
 * pasarela, y después el servidor vuelve a preguntarle el estado.
 */
export default function Pago({
  navegar, volver,
}: {
  navegar: (p: string, args?: any) => void;
  volver: () => void;
}) {
  const { carro, perfil, guardarPerfil, vaciar, registrarPedido, unidades } = useCliente();
  const [borrador, setBorrador] = useState<Perfil>(perfil);
  const [catalogo, setCatalogo] = useState<any[] | null>(null);
  const [cotizacion, setCotizacion] = useState<any>(null);
  const [pagando, setPagando] = useState(false);
  const inset = useSafeAreaInsets();

  useEffect(() => { api('GET', '/catalogo').then(setCatalogo).catch(() => {}); }, []);
  useEffect(() => { setBorrador(perfil); }, [perfil]);

  const productos = (catalogo ?? []).flatMap((r: any) => r.productos);
  const totalProductos = Object.entries(carro).reduce((acc, [id, cant]) => {
    const p = productos.find((x: any) => x.id === id);
    return acc + (p ? p.precio_venta * cant : 0);
  }, 0);

  useEffect(() => {
    if (totalProductos === 0) return setCotizacion(null);
    let vigente = true;
    api('GET', `/cotizar/${totalProductos}`)
      .then((c) => { if (vigente) setCotizacion(c); })
      .catch(() => {});
    return () => { vigente = false; };
  }, [totalProductos]);

  if (!catalogo) return <Cargando />;

  const completo = !!(
    borrador.nombre.trim() && borrador.telefono.trim() && borrador.direccion.trim()
  );

  const pagar = async () => {
    setPagando(true);
    try {
      await guardarPerfil(borrador);

      const pedido = await api('POST', '/pedidos', {
        cuerpo: {
          clienteNombre: borrador.nombre.trim(),
          clienteTelefono: borrador.telefono.trim(),
          clienteEmail: borrador.email.trim() || undefined,
          direccion: borrador.direccion.trim(),
          lat: borrador.lat, lng: borrador.lng,
          items: Object.entries(carro).map(([productoId, cantidad]) => ({ productoId, cantidad })),
        },
      });

      const pago = await api('POST', '/pagos/iniciar', {
        cuerpo: { pedidoId: pedido.pedidoId, email: borrador.email.trim() || undefined },
      });

      if (pago.url) await WebBrowser.openBrowserAsync(pago.url);
      else if (pago.pagoId) await api('POST', `/dev/pagar/${pago.pagoId}`);

      const listo = await esperarConfirmacion(pedido.pedidoId, pago.pagoId);
      if (!listo) {
        Alert.alert('Pago sin confirmar',
          'Si ya pagaste, tu pedido va a aparecer en unos segundos.');
      }
      await registrarPedido(pedido.pedidoId);
      vaciar();
      navegar('Seguimiento', { pedidoId: pedido.pedidoId });
    } catch (err: any) {
      Alert.alert('No se pudo pedir', err.message);
    } finally {
      setPagando(false);
    }
  };

  return (
    <View style={e.pantalla}>
      <View style={e.cabecera}>
        <Pressable onPress={volver} hitSlop={10} style={e.atras}>
          <Text style={e.flecha}>‹</Text>
        </Pressable>
        <Text style={[T.encabezado, { flex: 1 }]}>Pagar</Text>
      </View>

      <ScrollView
        contentContainerStyle={[e.relleno, { paddingBottom: 150 + inset.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={e.bloque}>
          <Text style={[T.destacado, { marginBottom: E.s }]}>¿Dónde lo dejamos?</Text>
          <View style={{ gap: E.m }}>
            <Campo
              etiqueta="Nombre"
              value={borrador.nombre}
              onChangeText={(v) => setBorrador({ ...borrador, nombre: v })}
              placeholder="Tu nombre"
            />
            <Campo
              etiqueta="Teléfono"
              value={borrador.telefono}
              onChangeText={(v) => setBorrador({ ...borrador, telefono: v })}
              placeholder="+56 9 1234 5678"
              keyboardType="phone-pad"
              ayuda="Para avisarte cuando el repartidor esté llegando."
            />
            <Campo
              etiqueta="Dirección"
              value={borrador.direccion}
              onChangeText={(v) => setBorrador({ ...borrador, direccion: v })}
              placeholder="Calle, número, depto"
            />
            <Campo
              etiqueta="Correo (opcional)"
              value={borrador.email}
              onChangeText={(v) => setBorrador({ ...borrador, email: v })}
              placeholder="tu@correo.cl"
              keyboardType="email-address"
              autoCapitalize="none"
              ayuda="Para el respaldo del pedido y, si hace falta, la devolución."
            />
          </View>
        </View>

        <View style={e.bloque}>
          <Text style={[T.destacado, { marginBottom: E.s }]}>Cómo pagas</Text>
          <View style={e.medio}>
            <Text style={{ fontSize: 22 }}>💳</Text>
            <View style={{ flex: 1 }}>
              <Text style={T.destacado}>Tarjeta o transferencia</Text>
              <Text style={T.micro}>Pagás en la página segura de la pasarela</Text>
            </View>
          </View>
        </View>

        {cotizacion ? (
          <View style={[e.bloque, { gap: E.s }]}>
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
          </View>
        ) : null}

        <Text style={[T.micro, { textAlign: 'center', marginTop: E.s }]}>
          Compramos tu pedido en la feria la misma mañana. Si algo no está,
          te llamamos antes de cambiarlo.
        </Text>
      </ScrollView>

      <View style={[e.pie, { bottom: 0, paddingBottom: Math.max(inset.bottom, E.l) }]}>
        <Boton
          titulo={pagando ? 'PROCESANDO…' : `PAGAR · ${clp(cotizacion?.total)}`}
          onPress={pagar}
          deshabilitado={!completo || pagando || !cotizacion?.alcanzaMinimo}
        />
        {!completo ? (
          <Text style={[T.micro, { textAlign: 'center', marginTop: E.s }]}>
            Completa nombre, teléfono y dirección.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Espera a que el pago quede confirmado.
 *
 * No se queda esperando el webhook: le pide al servidor que le
 * pregunte a la pasarela. El aviso se pierde más seguido de lo que
 * uno cree, y en desarrollo no llega nunca porque la pasarela no
 * puede alcanzar `localhost`. Sin esto el cliente mira «esperando
 * el pago» con la plata ya descontada.
 */
async function esperarConfirmacion(
  pedidoId: string, pagoId?: string, intentos = 10,
): Promise<boolean> {
  for (let i = 0; i < intentos; i++) {
    try {
      if (pagoId) {
        const r = await api('POST', `/pagos/${pagoId}/revisar`);
        if (r?.pagado) return true;
      }
      const p = await api('GET', `/pedidos/${pedidoId}`);
      if (p.estado !== 'PENDIENTE_PAGO') return true;
    } catch {
      // Un error de red no significa que el pago falló.
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  cabecera: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    paddingHorizontal: E.l, paddingVertical: E.m,
  },
  atras: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  flecha: { fontSize: 26, color: C.texto, lineHeight: 28 },
  relleno: { padding: E.l, paddingTop: 0, gap: E.l },
  bloque: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
  medio: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    backgroundColor: C.verdeSuave, borderRadius: R.medio, padding: E.m,
  },
  separador: { height: 1, backgroundColor: C.linea, marginVertical: E.xs },
  pie: {
    position: 'absolute', left: 0, right: 0,
    paddingHorizontal: E.l, paddingTop: E.m,
    backgroundColor: C.fondo,
    borderTopWidth: 1, borderTopColor: C.borde,
  },
});
