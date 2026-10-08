import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, useTablero } from '../api';
import { C, E, R, T, clp } from '../tema';
import { Boton, Cargando, Chip, tonoEstado } from '../ui';
import { Pasos, llamar, EnFeria } from './piezas';
import { Linea } from './Carrito';
import { abrirPago } from './Pago';
import { Icono } from '../iconos';
import { activarPush } from '../notificaciones';
import { MapaVista } from './PuntoEntrega';

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

  // El permiso de notificaciones se pide acá, con un pedido ya
  // hecho: es cuando se entiende para qué sirve («avisarte cuando
  // salga y cuando llegue»). Pedirlo al abrir la app es pedirlo a
  // ciegas, y la mayoría dice que no.
  useEffect(() => { void activarPush('cliente').catch(() => {}); }, []);
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
            {/* Una estimación, no una promesa: por eso «unos». */}
            {datos.viaje?.eta_minutos && !entregado ? (
              <Text style={[T.destacado, { color: '#FFFFFF', marginTop: E.xs }]}>
                Llega en unos {datos.viaje.eta_minutos} minutos
              </Text>
            ) : null}
            <Text style={[T.apoyo, { color: 'rgba(255,255,255,0.85)', marginTop: E.xs }]}>
              {datos.direccion}
            </Text>
          </View>
        )}

        {/* El código que prueba la entrega. Se ve desde que el pedido
            está pagado, para tenerlo a mano cuando toquen el timbre. */}
        {datos.codigo_entrega && !terminado && !entregado && datos.estado !== 'PENDIENTE_PAGO' ? (
          <View style={[e.tarjeta, e.codigo]}>
            <View style={{ flex: 1 }}>
              <Text style={T.seccion}>Tu código de entrega</Text>
              <Text style={[T.micro, { marginTop: 2 }]}>
                Díctaselo al repartidor cuando recibas tu pedido. No se lo des antes.
              </Text>
            </View>
            <Text style={e.codigoNumero}>{datos.codigo_entrega}</Text>
          </View>
        ) : null}

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
            {datos.viaje.repartidor_telefono ? (
              <Pressable onPress={() => llamar(datos.viaje.repartidor_telefono)} style={e.llamar} hitSlop={8}
                         accessibilityLabel="Llamar al repartidor">
                <Icono nombre="telefono" tamano={18} color={C.verdeOscuro} />
                <Text style={[T.micro, { color: C.verdeOscuro, fontFamily: T.destacado.fontFamily }]}>Llamar</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Por dónde viene, cuando ya salió de la feria. */}
        {datos.estado === 'EN_RUTA' && Number.isFinite(datos.viaje?.lat) && Number.isFinite(datos.viaje?.lng) ? (
          <View>
            <MapaVista lat={datos.viaje.lat} lng={datos.viaje.lng} exacto />
            <Text style={[T.micro, { marginTop: E.xs, textAlign: 'center' }]}>
              Tu repartidor va por aquí. Se actualiza solo.
            </Text>
          </View>
        ) : null}

        {!terminado && !entregado && datos.estado !== 'PENDIENTE_PAGO' ? (
          <NotaParaElRepartidor pedidoId={pedidoId} inicial={datos.notas ?? ''} />
        ) : null}

        {entregado ? (
          <Calificacion pedidoId={pedidoId} hecha={datos.calificacion} alGuardar={recargar} />
        ) : null}

        <View style={[e.tarjeta, { gap: E.s }]}>
          <Text style={T.seccion}>Tu pedido</Text>
          {datos.subPedidos.map((s: any) => (
            <View key={s.id} style={{ gap: 2 }}>
              {s.items.map((i: any) => (
                <View key={i.id} style={e.entre}>
                  <Text style={[T.cuerpo, { flex: 1 }, i.faltante && e.tachado]}>
                    {i.cantidad}× {i.nombre}
                  </Text>
                  {i.faltante ? (
                    <Text style={[T.micro, { color: C.naranja }]}>
                      No había · te devolvemos {clp(i.cantidad * i.precio_venta)}
                    </Text>
                  ) : null}
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

/** Una indicación para quien trae el pedido: el timbre, la reja, el piso. */
function NotaParaElRepartidor({ pedidoId, inicial }: { pedidoId: string; inicial: string }) {
  const [nota, setNota] = useState(inicial);
  const [guardada, setGuardada] = useState(inicial);
  const [ocupado, setOcupado] = useState(false);
  const guardar = async () => {
    setOcupado(true);
    try {
      await api('POST', `/pedidos/${pedidoId}/nota`, { cuerpo: { notas: nota } });
      setGuardada(nota);
    } catch (err: any) {
      Alert.alert('No se pudo guardar', err.message);
    } finally {
      setOcupado(false);
    }
  };
  return (
    <View style={[e.tarjeta, { gap: E.s }]}>
      <Text style={T.seccion}>Indicación para el repartidor</Text>
      <TextInput
        style={e.campoNota}
        value={nota}
        onChangeText={setNota}
        placeholder="Ej.: toca el timbre de abajo, depto 3"
        placeholderTextColor={C.textoSuave}
        maxLength={300}
        multiline
      />
      {nota.trim() !== guardada.trim() ? (
        <Boton titulo={ocupado ? 'Guardando…' : 'Guardar indicación'} variante="secundario"
               onPress={guardar} deshabilitado={ocupado} />
      ) : guardada.trim() ? (
        <Text style={[T.micro, { color: C.verdeOscuro }]}>El repartidor ya la tiene.</Text>
      ) : null}
    </View>
  );
}

/** Cómo llegó el pedido, de una a cinco estrellas. Una vez por pedido. */
function Calificacion({ pedidoId, hecha, alGuardar }: {
  pedidoId: string; hecha: { estrellas: number; comentario?: string | null } | null; alGuardar: () => void;
}) {
  const [estrellas, setEstrellas] = useState(0);
  const [comentario, setComentario] = useState('');
  const [ocupado, setOcupado] = useState(false);

  if (hecha) {
    return (
      <View style={[e.tarjeta, { alignItems: 'center', gap: E.xs }]}>
        <Text style={T.seccion}>Tu calificación</Text>
        <Text style={e.estrellas}>{'★'.repeat(hecha.estrellas)}<Text style={{ color: C.borde }}>{'★'.repeat(5 - hecha.estrellas)}</Text></Text>
        <Text style={T.micro}>¡Gracias! Con esto elegimos a los mejores puestos.</Text>
      </View>
    );
  }
  const enviar = async () => {
    setOcupado(true);
    try {
      await api('POST', `/pedidos/${pedidoId}/calificar`, { cuerpo: { estrellas, comentario } });
      alGuardar();
    } catch (err: any) {
      Alert.alert('No se pudo guardar', err.message);
    } finally {
      setOcupado(false);
    }
  };
  return (
    <View style={[e.tarjeta, { alignItems: 'center', gap: E.s }]}>
      <Text style={T.destacado}>¿Cómo llegó tu pedido?</Text>
      <View style={{ flexDirection: 'row', gap: E.s }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => setEstrellas(n)} hitSlop={6}
                     accessibilityLabel={`${n} ${n === 1 ? 'estrella' : 'estrellas'}`}>
            <Text style={[e.estrellas, { fontSize: 38, color: n <= estrellas ? C.ambar : C.borde }]}>★</Text>
          </Pressable>
        ))}
      </View>
      {estrellas > 0 ? (
        <>
          <TextInput
            style={[e.campoNota, { alignSelf: 'stretch' }]}
            value={comentario}
            onChangeText={setComentario}
            placeholder={estrellas <= 3 ? '¿Qué pasó? Nos sirve para mejorar' : 'Cuéntanos (opcional)'}
            placeholderTextColor={C.textoSuave}
            maxLength={500}
            multiline
          />
          <View style={{ alignSelf: 'stretch' }}>
            <Boton titulo={ocupado ? 'Enviando…' : 'ENVIAR'} onPress={enviar} deshabilitado={ocupado} />
          </View>
        </>
      ) : null}
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
  codigo: { flexDirection: 'row', alignItems: 'center', gap: E.m, borderColor: C.verde + '66', backgroundColor: C.verdeSuave },
  codigoNumero: { fontFamily: T.cifra.fontFamily, fontSize: 34, letterSpacing: 4, color: C.verdeOscuro },
  llamar: { alignItems: 'center', gap: 2, paddingHorizontal: E.s },
  tachado: { textDecorationLine: 'line-through', color: C.textoSuave },
  campoNota: {
    backgroundColor: C.fondo, borderRadius: R.medio, borderWidth: 1, borderColor: C.borde,
    paddingHorizontal: E.m, paddingVertical: E.s, minHeight: 44,
    fontFamily: T.cuerpo.fontFamily, fontSize: 15, color: C.texto,
  },
  estrellas: { fontSize: 26, color: C.ambar, letterSpacing: 2 },
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
