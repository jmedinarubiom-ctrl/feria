import React, { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { api } from '../api';
import { C, E, R, T } from '../tema';
import { Boton, Chip, Fila, Pantalla, Seccion, Tarjeta } from '../ui';

/**
 * La ruta del camión de la tarde, para el chofer.
 *
 * Primero carga todas las bolsas en la feria con un solo toque.
 * Después va entregando en el orden que calculó el servidor (el que
 * recorre menos), aunque puede adelantar otra entrega si en una casa
 * no hay nadie: la ruta sigue y esa queda para el final.
 */
export default function RutaCamion({ ruta, accion, ocupado, encabezado }: {
  ruta: any;
  accion: (fn: () => Promise<unknown>) => Promise<void>;
  ocupado: boolean;
  encabezado: React.ReactNode;
}) {
  const [elegidaId, setElegidaId] = useState<string | null>(null);
  const [codigo, setCodigo] = useState('');
  const [sinCodigo, setSinCodigo] = useState(false);
  const [motivo, setMotivo] = useState('');

  const entregas = ruta.entregas as any[];
  const porEntregar = entregas.filter((x) => x.estado === 'EN_RUTA');
  const actual = porEntregar.find((x) => x.id === elegidaId) ?? porEntregar[0] ?? null;
  const { total, entregados, porCargar } = ruta.resumen;

  // Google Maps acepta hasta 9 paradas intermedias en un enlace.
  const proximas = porEntregar.slice(0, 10);
  const enlaceRuta = proximas.length
    ? `https://www.google.com/maps/dir/?api=1&destination=${proximas[proximas.length - 1].lat},${proximas[proximas.length - 1].lng}`
      + (proximas.length > 1
        ? `&waypoints=${proximas.slice(0, -1).map((x) => `${x.lat},${x.lng}`).join('|')}` : '')
    : null;

  const limpiar = () => { setCodigo(''); setMotivo(''); setSinCodigo(false); setElegidaId(null); };

  return (
    <Pantalla titulo="Ruta del camión">
      {encabezado}

      <Tarjeta style={{ marginBottom: E.l }}>
        <Text style={T.seccion}>{ruta.feria_nombre} · entre {ruta.ventana}</Text>
        <Text style={[T.cifraMedia, { color: C.verdeOscuro, marginTop: 2 }]}>
          {entregados} de {total} entregados
        </Text>
        {ruta.km_total != null ? (
          <Text style={T.apoyo}>Recorrido estimado: {String(ruta.km_total).replace('.', ',')} km</Text>
        ) : null}
      </Tarjeta>

      {porCargar > 0 ? (
        <Tarjeta style={{ marginBottom: E.l }}>
          <Text style={T.encabezado}>Carga el camión</Text>
          <Text style={[T.apoyo, { marginVertical: E.s }]}>
            Retira en la feria las bolsas de los {porCargar} pedidos de la ruta. Cada una lleva su
            número. Cuando estén todas arriba, toca el botón: avisamos a los clientes que vas en camino.
          </Text>
          <Boton
            titulo="CARGUÉ TODO, SALGO"
            grande
            deshabilitado={ocupado}
            onPress={() => accion(async () => {
              const r = await api('POST', '/repartidor/ruta/cargar');
              if (r.pendientes?.length) {
                throw new Error(`Faltan bolsas de ${r.pendientes.map((n: number) => `#${n}`).join(', ')}: todavía se están preparando. Espera el aviso o llama a la feria.`);
              }
            })}
          />
        </Tarjeta>
      ) : null}

      {actual && porCargar === 0 ? (
        <Tarjeta style={{ marginBottom: E.l }}>
          <View style={e.entre}>
            <Text style={T.encabezado}>Pedido #{actual.numero}</Text>
            <Chip texto={`${entregados + 1} de ${total}`} tono="info" />
          </View>
          <Text style={[T.cuerpo, { marginTop: E.xs }]}>{actual.cliente_nombre}</Text>
          <Text style={T.apoyo}>{actual.direccion}</Text>
          {actual.notas ? <Text style={[T.micro, { marginTop: E.xs }]}>“{actual.notas}”</Text> : null}

          <View style={{ marginTop: E.l, gap: E.s }}>
            <Boton titulo="Llamar al cliente" variante="secundario"
                   onPress={() => Linking.openURL(`tel:${actual.cliente_telefono}`)} />
            <Boton
              titulo="Abrir en el mapa" variante="secundario"
              onPress={() => Linking.openURL(Platform.OS === 'ios'
                ? `https://maps.apple.com/?daddr=${actual.lat},${actual.lng}`
                : `https://www.google.com/maps/dir/?api=1&destination=${actual.lat},${actual.lng}`)}
            />
            <View style={e.prueba}>
              {!sinCodigo ? (
                <>
                  <Text style={T.seccion}>Código de entrega</Text>
                  <Text style={T.micro}>Pídeselo al cliente: lo ve en su pedido.</Text>
                  <TextInput
                    style={e.campoCodigo}
                    value={codigo}
                    onChangeText={(v) => setCodigo(v.replace(/\D/g, '').slice(0, 4))}
                    placeholder="0000"
                    placeholderTextColor={C.borde}
                    keyboardType="number-pad"
                    maxLength={4}
                  />
                  <Pressable onPress={() => setSinCodigo(true)} hitSlop={8}>
                    <Text style={[T.micro, { color: C.naranja, textAlign: 'center' }]}>
                      No hay quién me dé el código
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={T.seccion}>¿A quién se lo dejaste?</Text>
                  <TextInput
                    style={e.campoMotivo}
                    value={motivo}
                    onChangeText={setMotivo}
                    placeholder="Ej.: lo recibió el conserje, don Luis"
                    placeholderTextColor={C.textoSuave}
                    maxLength={200}
                    multiline
                  />
                  <Pressable onPress={() => setSinCodigo(false)} hitSlop={8}>
                    <Text style={[T.micro, { color: C.verde, textAlign: 'center' }]}>Ya tengo el código</Text>
                  </Pressable>
                </>
              )}
            </View>
            <Boton
              titulo="ENTREGADO"
              grande
              deshabilitado={ocupado || !actual.paradaEntregaId
                || (sinCodigo ? motivo.trim().length < 8 : codigo.length !== 4)}
              onPress={() => accion(async () => {
                await api('POST', `/paradas/${actual.paradaEntregaId}/completar`, {
                  cuerpo: sinCodigo ? { motivo: motivo.trim() } : { codigo },
                });
                limpiar();
              })}
            />
          </View>
        </Tarjeta>
      ) : null}

      {enlaceRuta && porCargar === 0 ? (
        <View style={{ marginBottom: E.l }}>
          <Boton titulo={`Ver las próximas ${proximas.length} en el mapa`} variante="secundario"
                 onPress={() => Linking.openURL(enlaceRuta)} />
        </View>
      ) : null}

      <Seccion titulo="Entregas en orden">
        {entregas.map((x, i) => {
          const hecha = x.estado === 'ENTREGADO';
          const cancelada = x.estado === 'CANCELADO';
          const esActual = actual?.id === x.id;
          return (
            <Fila key={x.id} ultima={i === entregas.length - 1}>
              <Pressable
                disabled={hecha || cancelada || x.estado !== 'EN_RUTA'}
                onPress={() => { setElegidaId(x.id); setCodigo(''); setMotivo(''); setSinCodigo(false); }}
                style={e.filaRuta}
              >
                <View style={[e.punto, {
                  backgroundColor: hecha ? C.verde : esActual ? C.amarillo : cancelada ? C.rojo : C.borde,
                }]} />
                <View style={{ flex: 1 }}>
                  <Text style={[T.cuerpo, (hecha || cancelada) && e.tachado]}>
                    {i + 1}. #{x.numero} · {x.cliente_nombre}
                  </Text>
                  <Text style={[T.micro, (hecha || cancelada) && e.tachado]} numberOfLines={1}>
                    {cancelada ? 'Cancelado' : x.direccion}
                  </Text>
                </View>
                {!hecha && !cancelada && !esActual && x.estado === 'EN_RUTA' ? (
                  <Text style={[T.micro, { color: C.verde }]}>Adelantar</Text>
                ) : null}
              </Pressable>
            </Fila>
          );
        })}
      </Seccion>
    </Pantalla>
  );
}

const e = StyleSheet.create({
  tachado: { textDecorationLine: 'line-through', color: C.textoSuave },
  entre: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: E.s },
  prueba: {
    gap: E.xs, padding: E.m, borderRadius: R.medio, backgroundColor: C.fondo,
    borderWidth: 1, borderColor: C.borde,
  },
  campoCodigo: {
    backgroundColor: C.superficie, borderRadius: R.medio, borderWidth: 1, borderColor: C.borde,
    paddingVertical: E.s, textAlign: 'center', fontFamily: T.cifra.fontFamily,
    fontSize: 34, letterSpacing: 10, color: C.texto, marginVertical: E.xs,
  },
  campoMotivo: {
    backgroundColor: C.superficie, borderRadius: R.medio, borderWidth: 1, borderColor: C.borde,
    paddingHorizontal: E.m, paddingVertical: E.s, minHeight: 60, marginVertical: E.xs,
    fontFamily: T.cuerpo.fontFamily, fontSize: 15, color: C.texto,
  },
  filaRuta: { flexDirection: 'row', alignItems: 'center', gap: E.m },
  punto: { width: 10, height: 10, borderRadius: 5 },
});
