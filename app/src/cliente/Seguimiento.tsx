import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, useTablero } from '../api';
import { C, E, R, T, clp } from '../tema';
import { Boton, Cargando, Chip, tonoEstado } from '../ui';
import { Pasos, llamar, EnFeria } from './piezas';
import { Linea } from './Carrito';
import { abrirPago } from './Pago';
import { Icono } from '../iconos';

/**
 * Seguimiento del pedido.
 *
 * Los pasos son los del cliente, no los del sistema: no se entera
 * de que un sub-pedido cayó en autogestión porque para él da igual
 * quién lo compró, solo cuándo llega.
 */
const PASOS: Array<{ estados: string[]; texto: string }> = [
  { estados: ['PENDIENTE_PAGO'], texto: 'Pago' },
  { estados: ['DESPACHANDO'], texto: 'Puesto' },
  { estados: ['EN_PREPARACION', 'LISTO_PARA_RETIRO'], texto: 'Preparando' },
  { estados: ['EN_RUTA'], texto: 'En camino' },
  { estados: ['ENTREGADO'], texto: 'Entregado' },
];

export default function Seguimiento({
  pedidoId, volver,
}: {
  pedidoId: string;
  volver: () => void;
}) {
  const { datos, cargando, recargar } = useTablero(`/pedidos/${pedidoId}`, 'cliente', pedidoId);
  const [contacto, setContacto] = useState<string | null>(null);
  const [pagando, setPagando] = useState(false);

  // Quien cerró el navegador sin pagar quedaba acá mirando
  // «esperando el pago» sin forma de volver al checkout: el carro ya
  // estaba vacío y el pedido expiraba solo. El servidor devuelve el
  // mismo cobro abierto, así que no se genera uno nuevo.
  const pagar = async () => {
    setPagando(true);
    try {
      const pago = await api('POST', '/pagos/iniciar', { cuerpo: { pedidoId } });
      await abrirPago(pago);
      if (pago.pagoId) await api('POST', `/pagos/${pago.pagoId}/revisar`).catch(() => {});
      await recargar();
    } catch (err: any) {
      Alert.alert('No se pudo abrir el pago', err.message);
      await recargar();
    } finally {
      setPagando(false);
    }
  };

  useEffect(() => {
    api('GET', '/feria/estado').then((f) => setContacto(f.contacto)).catch(() => {});
  }, []);

  if (cargando || !datos) return <Cargando />;

  const actual = PASOS.findIndex((p) => p.estados.includes(datos.estado));
  const terminado = datos.estado === 'CANCELADO' || datos.estado === 'EXPIRADO';
  const entregado = datos.estado === 'ENTREGADO';

  return (
    <View style={e.pantalla}>
      <View style={e.cabecera}>
        <Pressable onPress={volver} hitSlop={10} style={e.atras}>
          <Icono nombre="atras" tamano={22} color={C.texto} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={T.encabezado}>Pedido #{datos.numero}</Text>
          {/* La feria del pedido, no la elegida hoy: pueden no coincidir. */}
          <EnFeria nombre={datos.feria_nombre} prefijo="Desde" />
        </View>
        <Chip texto={datos.estado.replace(/_/g, ' ')} tono={tonoEstado(datos.estado)} />
      </View>

      <ScrollView contentContainerStyle={e.relleno}>
        {terminado ? (
          <View style={[e.tarjeta, { backgroundColor: C.rojoSuave, borderColor: C.rojoSuave }]}>
            <Text style={[T.destacado, { color: C.rojo }]}>
              {datos.estado === 'CANCELADO' ? 'Pedido cancelado' : 'Pedido expirado'}
            </Text>
            <Text style={[T.apoyo, { marginTop: 2 }]}>
              {datos.estado === 'CANCELADO'
                ? 'Si pagaste, te devolvemos la plata.'
                : 'No se completó el pago a tiempo.'}
            </Text>
          </View>
        ) : (
          <View style={e.portada}>
            <Text style={[T.micro, { color: 'rgba(255,255,255,0.8)' }]}>
              {entregado ? 'Entregado' : 'Llega hoy'}
            </Text>
            <Text style={[T.titulo, { color: '#FFFFFF', marginTop: 2 }]}>
              {TITULOS[datos.estado] ?? 'Tu pedido va en camino'}
            </Text>
            <Text style={[T.apoyo, { color: 'rgba(255,255,255,0.85)', marginTop: E.xs }]}>
              {datos.direccion}
            </Text>
          </View>
        )}

        {datos.estado === 'PENDIENTE_PAGO' ? (
          <Boton
            titulo={pagando ? 'ABRIENDO…' : `PAGAR · ${clp(datos.total_venta)}`}
            onPress={pagar}
            deshabilitado={pagando}
          />
        ) : null}

        {!terminado ? (
          <View style={e.tarjeta}>
            <Pasos pasos={PASOS.map((p) => p.texto)} actual={Math.max(0, actual)} />
          </View>
        ) : null}

        {datos.viaje?.repartidor_nombre && !terminado ? (
          <View style={[e.tarjeta, e.fila]}>
            <View style={e.avatar}>
              <Text style={e.inicial}>
                {datos.viaje.repartidor_nombre.trim().charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={T.seccion}>Tu repartidor</Text>
              <Text style={[T.destacado, { marginTop: 2 }]}>
                {datos.viaje.repartidor_nombre}
              </Text>
              <Text style={T.micro}>En {datos.viaje.vehiculo}</Text>
            </View>
          </View>
        ) : null}

        <View style={[e.tarjeta, { gap: E.s }]}>
          <Text style={T.seccion}>Tu pedido</Text>
          {datos.subPedidos.map((s: any) => (
            <View key={s.id} style={{ gap: 2 }}>
              {s.items.map((i: any) => (
                <View key={i.id} style={e.entre}>
                  <Text style={T.cuerpo}>{i.cantidad}× {i.nombre}</Text>
                </View>
              ))}
            </View>
          ))}
          <View style={e.separador} />
          <Linea etiqueta="Productos" valor={clp(datos.total_productos)} />
          <Linea
            etiqueta="Despacho"
            valor={datos.costo_despacho === 0 ? 'Gratis' : clp(datos.costo_despacho)}
            destacado={datos.costo_despacho === 0}
          />
          <View style={e.separador} />
          <Linea etiqueta="Total" valor={clp(datos.total_venta)} grande />
        </View>

        {/* Sin botón de cancelar: del otro lado hay un feriante
            apartando mercadería o un repartidor en camino, y eso se
            resuelve hablando, no apretando. */}
        {contacto && !terminado && !entregado ? (
          <Boton
            titulo="¿Necesitas cambiar algo? Llámanos"
            subtitulo={contacto}
            variante="secundario"
            onPress={() => llamar(contacto)}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const TITULOS: Record<string, string> = {
  PENDIENTE_PAGO: 'Esperando el pago',
  DESPACHANDO: 'Buscando el puesto',
  EN_PREPARACION: 'Armando tu pedido en la feria',
  LISTO_PARA_RETIRO: 'Listo, esperando al repartidor',
  EN_RUTA: 'Tu pedido va en camino',
  ENTREGADO: '¡Llegó tu feria!',
};

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  cabecera: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    paddingHorizontal: E.l, paddingVertical: E.m,
  },
  atras: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  flecha: { fontSize: 26, color: C.texto, lineHeight: 28 },
  relleno: { padding: E.l, paddingTop: 0, paddingBottom: E.xxxl, gap: E.l },
  portada: {
    backgroundColor: C.verde, borderRadius: R.enorme, padding: E.xl,
  },
  tarjeta: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
  fila: { flexDirection: 'row', alignItems: 'center', gap: E.m },
  avatar: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: C.verdeSuave,
    alignItems: 'center', justifyContent: 'center',
  },
  inicial: { fontFamily: T.titulo.fontFamily, fontSize: 20, color: C.verdeOscuro },
  entre: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: E.s,
  },
  separador: { height: 1, backgroundColor: C.linea, marginVertical: E.xs },
});
