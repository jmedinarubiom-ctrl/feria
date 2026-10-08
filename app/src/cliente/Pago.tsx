import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';

import { api } from '../api';
import { C, E, R, T, clp } from '../tema';
import { Boton, Cargando } from '../ui';
import { Campo, EnFeria } from './piezas';
import { Linea } from './Carrito';
import { useCliente, type Perfil } from './estado';
import PuntoEntrega, { puntoVigente } from './PuntoEntrega';
import { Icono } from '../iconos';

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
  const {
    carro, perfil, guardarPerfil, vaciar, registrarPedido, unidades, feriaId, telefonoVerificado,
  } = useCliente();
  const [borrador, setBorrador] = useState<Perfil>(perfil);
  const [catalogo, setCatalogo] = useState<any[] | null>(null);
  const [cotizacion, setCotizacion] = useState<any>(null);
  const [pagando, setPagando] = useState(false);
  const [editandoQuien, setEditandoQuien] = useState(false);
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
  // Qué falta, dicho con nombre: «completa los datos» no le dice a
  // nadie qué casilla dejó vacía.
  const falta = [
    !borrador.direccion.trim() && 'la dirección',
    !borrador.nombre.trim() && 'tu nombre',
    !borrador.telefono.trim() && 'un teléfono',
  ].filter(Boolean) as string[];
  const quienResumido = !editandoQuien && !!(borrador.nombre.trim() && borrador.telefono.trim());
  const lineas = Object.entries(carro).map(([id, cantidad]) => {
    const p = productos.find((x: any) => x.id === id);
    return p ? { id, cantidad, nombre: p.nombre as string, subtotal: p.precio_venta * cantidad } : null;
  }).filter(Boolean) as Array<{ id: string; cantidad: number; nombre: string; subtotal: number }>;

  const pagar = async () => {
    setPagando(true);
    try {
      await guardarPerfil(borrador);

      const punto = puntoVigente(borrador.punto, borrador.direccion);
      const pedido = await api('POST', '/pedidos', {
        cuerpo: {
          clienteNombre: borrador.nombre.trim(),
          clienteTelefono: borrador.telefono.trim(),
          clienteEmail: borrador.email.trim() || undefined,
          direccion: borrador.direccion.trim(),
          // El punto que marcó, si sigue siendo el de esta dirección.
          // Sin punto marcado, el servidor ubica la dirección escrita.
          ...(punto ? {
            puntoMarcado: true, lat: punto.lat, lng: punto.lng, precisionM: punto.precisionM,
          } : { lat: borrador.lat, lng: borrador.lng }),
          feriaId,
          items: Object.entries(carro).map(([productoId, cantidad]) => ({ productoId, cantidad })),
        },
      });

      // Se anota apenas existe. Antes se anotaba recién al volver
      // del pago: si la app se cerraba en el medio, el cliente
      // pagaba y el pedido no aparecía en «Mis pedidos».
      await registrarPedido(pedido.pedidoId);

      const pago = await api('POST', '/pagos/iniciar', {
        cuerpo: { pedidoId: pedido.pedidoId, email: borrador.email.trim() || undefined },
      });

      await abrirPago(pago);

      const listo = await esperarConfirmacion(pedido.pedidoId, pago.pagoId);
      if (!listo) {
        Alert.alert('Pago sin confirmar',
          'Si ya pagaste, tu pedido va a aparecer en unos segundos.');
      }
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
          <Icono nombre="atras" tamano={22} color={C.texto} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={T.encabezado}>Pagar</Text>
          <EnFeria prefijo="Tu pedido se compra en" />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[e.relleno, { paddingBottom: 150 + inset.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* 1 · Dónde. Va primero y con el mapa a la vista: es lo que
            más cuesta arreglar después si queda mal. */}
        <View style={e.bloque}>
          <Paso n={1} titulo="¿Dónde lo entregamos?" listo={!!borrador.direccion.trim()} />
          <View style={{ gap: E.m }}>
            <Campo
              etiqueta="Dirección"
              value={borrador.direccion}
              onChangeText={(v) => setBorrador({ ...borrador, direccion: v })}
              placeholder="Calle, número, depto, comuna"
              ayuda="Agrega el depto, el block o una referencia: «casa azul, reja negra»."
            />
            <PuntoEntrega
              direccion={borrador.direccion}
              feriaId={feriaId}
              punto={borrador.punto ?? null}
              onCambio={(punto) => setBorrador({ ...borrador, punto })}
            />
          </View>
        </View>

        {/* 2 · Quién. Si ya lo sabemos por el perfil, se muestra
            resumido: no hay por qué volver a escribirlo. */}
        <View style={e.bloque}>
          <Paso n={2} titulo="¿Quién recibe?" listo={!!(borrador.nombre.trim() && borrador.telefono.trim())} />
          {quienResumido ? (
            <Pressable onPress={() => setEditandoQuien(true)} style={e.resumenQuien}>
              <View style={{ flex: 1 }}>
                <Text style={T.destacado}>{borrador.nombre}</Text>
                <Text style={T.apoyo}>
                  {telefonoVerificado ?? borrador.telefono}
                  {borrador.email ? `  ·  ${borrador.email}` : ''}
                </Text>
              </View>
              <Text style={[T.micro, { color: C.verde, fontFamily: T.destacado.fontFamily }]}>Cambiar</Text>
            </Pressable>
          ) : (
            <View style={{ gap: E.m }}>
              <Campo
                etiqueta="Nombre"
                value={borrador.nombre}
                onChangeText={(v) => setBorrador({ ...borrador, nombre: v })}
                placeholder="Tu nombre"
              />
              <Campo
                etiqueta={telefonoVerificado ? 'Teléfono (confirmado)' : 'Teléfono'}
                value={telefonoVerificado ?? borrador.telefono}
                onChangeText={(v) => setBorrador({ ...borrador, telefono: v })}
                placeholder="+56 9 1234 5678"
                keyboardType="phone-pad"
                // El confirmado se cambia en Perfil, con un código.
                editable={!telefonoVerificado}
                ayuda={telefonoVerificado
                  ? 'Es el número de tu cuenta. Se cambia en Perfil.'
                  : 'Para que el repartidor te avise cuando esté llegando.'}
              />
              <Campo
                etiqueta="Correo (opcional)"
                value={borrador.email}
                onChangeText={(v) => setBorrador({ ...borrador, email: v })}
                placeholder="tu@correo.cl"
                keyboardType="email-address"
                autoCapitalize="none"
                ayuda="Ahí te llega el respaldo del pedido."
              />
            </View>
          )}
        </View>

        {/* 3 · Qué. Un vistazo al pedido antes de pagar, sin volver atrás. */}
        <View style={e.bloque}>
          <View style={e.entre}>
            <Paso n={3} titulo="Tu pedido" listo />
            <Pressable onPress={volver} hitSlop={10}>
              <Text style={[T.micro, { color: C.verde, fontFamily: T.destacado.fontFamily }]}>Editar</Text>
            </Pressable>
          </View>
          {lineas.slice(0, 4).map((l) => (
            <View key={l.id} style={e.entre}>
              <Text style={[T.cuerpo, { flex: 1 }]} numberOfLines={1}>
                <Text style={T.destacado}>{l.cantidad}×</Text> {l.nombre}
              </Text>
              <Text style={T.apoyo}>{clp(l.subtotal)}</Text>
            </View>
          ))}
          {lineas.length > 4 ? (
            <Text style={[T.micro, { marginTop: E.xs }]}>y {lineas.length - 4} más</Text>
          ) : null}
        </View>

        <View style={e.bloque}>
          <Paso n={4} titulo="Cómo pagas" listo />
          <View style={e.medio}>
            <Icono nombre="tarjeta" tamano={24} color={C.verdeOscuro} />
            <View style={{ flex: 1 }}>
              <Text style={T.destacado}>Tarjeta o transferencia</Text>
              <Text style={T.micro}>Pagas en la página segura de Mercado Pago. No guardamos tu tarjeta.</Text>
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
          te llamamos antes de cambiarlo.{'\n'}Un pedido pagado se cambia o cancela
          llamando a la feria; si se cancela, te devolvemos lo pagado.
        </Text>
        {/* La ley exige informar ANTES del pago que no hay retracto. */}
        <Text style={[T.micro, { textAlign: 'center', marginTop: E.s }]}>
          Los alimentos frescos son productos perecibles: no tienen derecho a
          retracto (art. 3° bis, Ley 19.496). Si algo llega en mal estado o
          no es lo que pediste, te lo reponemos o te devolvemos el dinero.
          Al pagar aceptas los Términos y la Política de Privacidad, que
          puedes leer en tu perfil.
        </Text>
      </ScrollView>

      <View style={[e.pie, { bottom: 0, paddingBottom: Math.max(inset.bottom, E.l) }]}>
        <Boton
          titulo={pagando ? 'PROCESANDO…' : `PAGAR · ${clp(cotizacion?.total)}`}
          onPress={pagar}
          deshabilitado={!completo || pagando || !cotizacion?.alcanzaMinimo}
        />
        {falta.length ? (
          <Text style={[T.micro, { textAlign: 'center', marginTop: E.s, color: C.naranja }]}>
            Falta {falta.join(', ')}.
          </Text>
        ) : !borrador.punto || borrador.punto.direccion.trim() !== borrador.direccion.trim() ? (
          <Text style={[T.micro, { textAlign: 'center', marginTop: E.s }]}>
            Consejo: marca el punto en el mapa y el repartidor llega directo.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** El título de cada paso, con su número y un visto cuando está completo. */
function Paso({ n, titulo, listo }: { n: number; titulo: string; listo?: boolean }) {
  return (
    <View style={e.paso}>
      <View style={[e.pasoNumero, listo && { backgroundColor: C.verde, borderColor: C.verde }]}>
        {listo
          ? <Icono nombre="listo" tamano={13} color="#FFFFFF" grosor={2.8} />
          : <Text style={[T.micro, { color: C.textoSuave, fontFamily: T.destacado.fontFamily }]}>{n}</Text>}
      </View>
      <Text style={T.destacado}>{titulo}</Text>
    </View>
  );
}

/**
 * Manda al cliente a pagar y espera a que vuelva.
 *
 * `openAuthSessionAsync` y no `openBrowserAsync`: el segundo, en
 * Android, devuelve apenas se abre el navegador. La app empezaba a
 * contar los 12 segundos de espera con el cliente todavía
 * escribiendo la tarjeta, y le mostraba «pago sin confirmar» encima
 * del checkout. Este espera a que la página de retorno del servidor
 * lo traiga de vuelta por `feria://pago`, o a que cierre el navegador.
 */
export async function abrirPago(pago: { url?: string | null; pagoId?: string }): Promise<void> {
  if (pago.url) await WebBrowser.openAuthSessionAsync(pago.url, 'feria://pago');
  // Sin pasarela configurada (desarrollo) se confirma directo.
  else if (pago.pagoId) await api('POST', `/dev/pagar/${pago.pagoId}`);
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
  paso: { flexDirection: 'row', alignItems: 'center', gap: E.s, marginBottom: E.m },
  pasoNumero: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: C.borde,
    alignItems: 'center', justifyContent: 'center',
  },
  entre: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: E.s },
  resumenQuien: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    backgroundColor: C.fondo, borderRadius: R.medio, padding: E.m,
  },
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
