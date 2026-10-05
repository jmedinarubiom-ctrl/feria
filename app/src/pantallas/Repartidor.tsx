import React, { useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, Switch, Text, View } from 'react-native';

import { api, useTablero } from '../api';
import { useEnviarUbicacion } from '../ubicacion';
import { C, E, R, T, clp } from '../tema';
import {
  Aviso, Boton, Cargando, Chip, Fila, Pantalla, Seccion, Tarjeta, Vacio, tonoEstado,
} from '../ui';

/**
 * La app del repartidor.
 *
 * Muestra una sola parada a la vez. Con tres puestos y una entrega
 * en una feria llena, una lista completa invita a equivocarse de
 * orden y dejar bolsas atrás.
 */
export default function Repartidor({ repartidorId }: { repartidorId: string }) {
  const { datos, error, cargando, enVivo, recargar } =
    useTablero('/repartidor/tablero', 'repartidor', repartidorId);
  const [ocupado, setOcupado] = useState(false);

  // Antes del primer return: la cantidad de hooks no puede cambiar
  // entre renders. Mientras lleva un viaje, la app manda dónde está.
  useEnviarUbicacion(!!datos?.viajeActivo);

  if (cargando) return <Cargando />;
  // Con datos en pantalla, una recarga que falla —la señal de la
  // feria— no los tapa con un error: se sigue mostrando lo último.
  if (error && !datos) return <Pantalla><Aviso texto={error} /></Pantalla>;
  if (!datos) return <Cargando />;

  const accion = async (fn: () => Promise<unknown>) => {
    setOcupado(true);
    try {
      await fn();
      await recargar();
    } catch (err: any) {
      Alert.alert('No se pudo', err.message);
      await recargar();
    } finally {
      setOcupado(false);
    }
  };

  const { viajeActivo, disponibles, repartidor } = datos;
  const conectado = !!repartidor?.conectado;

  const interruptor = (
    <View style={e.interruptor}>
      <View style={{ flex: 1 }}>
        <Text style={T.destacado}>{conectado ? 'Disponible' : 'Fuera de turno'}</Text>
        <Text style={T.micro}>
          {conectado
            ? (enVivo ? 'Te avisamos cuando entre un viaje' : 'Reconectando…')
            : 'No te van a llegar viajes'}
        </Text>
      </View>
      <Switch
        value={conectado}
        trackColor={{ true: C.verde, false: C.superficieAlta }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={C.superficieAlta}
        onValueChange={(v) => accion(() =>
          api('POST', '/repartidor/conexion', { cuerpo: { conectado: v } }))}
      />
    </View>
  );

  if (!viajeActivo) {
    return (
      <Pantalla titulo="Viajes">
        {interruptor}
        {disponibles.length === 0 ? (
          <Seccion>
            <Vacio texto={'No hay viajes ahora.\nCuando un pedido esté listo, aparece acá.'} />
          </Seccion>
        ) : (
          <Seccion titulo={`${disponibles.length} para tomar`}>
            {disponibles.map((v: any, i: number) => (
              <Fila key={v.id} ultima={i === disponibles.length - 1}>
                <View style={e.entre}>
                  <Text style={T.encabezado}>Pedido #{v.numero}</Text>
                  <Text style={[T.cifraMedia, { color: C.verdeOscuro }]}>{clp(v.tarifa)}</Text>
                </View>
                <Text style={[T.apoyo, { marginTop: 2 }]}>
                  {v.retiros} {v.retiros === 1 ? 'puesto' : 'puestos'} · {v.direccion}
                </Text>
                <View style={{ marginTop: E.m }}>
                  <Boton
                    titulo="TOMAR ESTE VIAJE"
                    deshabilitado={ocupado}
                    onPress={() => accion(() => api('POST', `/viajes/${v.id}/aceptar`))}
                  />
                </View>
              </Fila>
            ))}
          </Seccion>
        )}
      </Pantalla>
    );
  }

  const paradas = viajeActivo.paradas as any[];
  const siguiente = paradas.find((p) => !p.completada_at);
  const hechas = paradas.filter((p) => p.completada_at).length;

  return (
    <Pantalla
      titulo={`Pedido #${viajeActivo.numero}`}
      subtitulo={`Parada ${Math.min(hechas + 1, paradas.length)} de ${paradas.length} · ganas ${clp(viajeActivo.tarifa)}`}
      accesorio={<Chip texto={viajeActivo.estado} tono={tonoEstado(viajeActivo.estado)} />}
    >
      {siguiente ? (
        <Tarjeta style={{ marginBottom: E.xl, borderColor: C.verde + '55' }}>
          <Text style={T.seccion}>
            {siguiente.tipo === 'RETIRO' ? 'Retirar en' : 'Entregar en'}
          </Text>
          <Text style={[T.titulo, { marginTop: E.xs }]}>{siguiente.etiqueta}</Text>

          {siguiente.items.length > 0 ? (
            <View style={{ marginTop: E.m }}>
              {siguiente.items.map((i: any) => (
                <Text key={i.id} style={[T.destacado, { marginTop: 2 }]}>
                  {i.cantidad}× {i.nombre}{'  '}
                  <Text style={T.apoyo}>{i.formato}</Text>
                </Text>
              ))}
            </View>
          ) : null}

          {siguiente.tipo === 'ENTREGA' ? (
            <View style={{ marginTop: E.m }}>
              <Text style={T.cuerpo}>{viajeActivo.cliente_nombre}</Text>
              {viajeActivo.notas ? (
                <Text style={[T.apoyo, { marginTop: 2, fontStyle: 'italic' }]}>
                  “{viajeActivo.notas}”
                </Text>
              ) : null}
            </View>
          ) : null}

          <View style={{ marginTop: E.l, gap: E.s }}>
            {siguiente.tipo === 'ENTREGA' ? (
              <Boton
                titulo="Llamar al cliente"
                variante="secundario"
                onPress={() => Linking.openURL(`tel:${viajeActivo.cliente_telefono}`)}
              />
            ) : null}
            {siguiente.lat ? (
              <Boton
                titulo="Abrir en el mapa"
                variante="secundario"
                // Apple Maps solo existe en iPhone; en Android ese
                // enlace abría el navegador en vez del mapa.
                onPress={() => Linking.openURL(Platform.OS === 'ios'
                  ? `https://maps.apple.com/?daddr=${siguiente.lat},${siguiente.lng}`
                  : `https://www.google.com/maps/dir/?api=1&destination=${siguiente.lat},${siguiente.lng}`)}
              />
            ) : null}
            <Boton
              titulo={siguiente.tipo === 'RETIRO' ? 'RETIRADO' : 'ENTREGADO'}
              grande
              deshabilitado={ocupado}
              onPress={() => accion(() => api('POST', `/paradas/${siguiente.id}/completar`))}
            />
          </View>
        </Tarjeta>
      ) : null}

      <Seccion titulo="Ruta completa">
        {paradas.map((p, i) => (
          <Fila key={p.id} ultima={i === paradas.length - 1}>
            <View style={e.filaRuta}>
              <View style={[
                e.punto,
                {
                  backgroundColor: p.completada_at ? C.verde
                    : p.id === siguiente?.id ? C.amarillo : C.borde,
                },
              ]} />
              <Text style={[
                T.cuerpo,
                { flex: 1 },
                p.completada_at && { color: C.textoSuave, textDecorationLine: 'line-through' },
              ]}>
                {p.etiqueta}
              </Text>
            </View>
          </Fila>
        ))}
      </Seccion>
    </Pantalla>
  );
}

const e = StyleSheet.create({
  interruptor: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde,
    paddingHorizontal: E.l, paddingVertical: E.m,
    marginBottom: E.l,
  },
  entre: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: E.s,
  },
  filaRuta: { flexDirection: 'row', alignItems: 'center', gap: E.m },
  punto: { width: 10, height: 10, borderRadius: 5 },
});
