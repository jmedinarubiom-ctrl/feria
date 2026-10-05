import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View, Vibration } from 'react-native';

import { api, useTablero, usarCuentaRegresiva } from '../api';
import { C, E, R, T, clp } from '../tema';
import {
  Aviso, BarraTiempo, Boton, Cargando, Chip, Fila, Pantalla, Seccion, Tarjeta, Vacio,
} from '../ui';

/**
 * La app del feriante.
 *
 * Regla de diseño: cuando entra una oferta, esta pantalla no muestra
 * nada más. El feriante está atendiendo gente — tiene dos segundos
 * de atención y dos decisiones posibles. Todo lo demás estorba.
 */
export default function Feriante({ ferianteId }: { ferianteId: string }) {
  const { datos, error, cargando, enVivo, recargar } =
    useTablero('/feriante/tablero', 'feriante', ferianteId);
  const [ocupado, setOcupado] = useState(false);

  if (cargando) return <Cargando />;
  // Con datos en pantalla, una recarga que falla —la señal de la
  // feria— no los tapa con un error: se sigue mostrando lo último.
  if (error && !datos) return <Pantalla><Aviso texto={error} /></Pantalla>;
  if (!datos) return <Cargando />;

  const { feriante, ofertas, trabajo, liquidacion } = datos;

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

  if (ofertas.length > 0) {
    return (
      <OfertaEntrante
        oferta={ofertas[0]}
        ocupado={ocupado}
        onAceptar={() => accion(() =>
          api('POST', `/subpedidos/${ofertas[0].sub_pedido_id}/aceptar`))}
        onRechazar={() => accion(() =>
          api('POST', `/subpedidos/${ofertas[0].sub_pedido_id}/rechazar`))}
      />
    );
  }

  return (
    <Pantalla>
      {/* El interruptor es la decisión más importante del día, así
          que es una fila con su propio texto y no un control chico
          en una esquina. El nombre ya lo dice la cabecera. */}
      <View style={e.interruptor}>
        <View style={{ flex: 1 }}>
          <Text style={T.destacado}>
            {feriante.conectado ? 'Recibiendo pedidos' : 'En pausa'}
          </Text>
          <Text style={T.micro}>{feriante.puesto}</Text>
        </View>
        <Switch
          value={!!feriante.conectado}
          trackColor={{ true: C.verde, false: C.superficieAlta }}
          thumbColor="#FFFFFF"
          ios_backgroundColor={C.superficieAlta}
          onValueChange={(v) => accion(() =>
            api('POST', '/feriante/conexion', { cuerpo: { conectado: v } }))}
        />
      </View>

      {!enVivo ? <Aviso texto="Sin conexión con el servidor. Reintentando…" tono="aviso" /> : null}
      {!feriante.conectado ? (
        <Aviso texto="Estás en pausa: no te van a llegar pedidos." tono="aviso" />
      ) : null}

      <Tarjeta tono="exito" style={{ marginBottom: E.xl }}>
        <Text style={T.seccion}>Lo que llevas hoy</Text>
        <Text style={[T.cifra, { color: C.verdeOscuro, marginTop: E.xs }]}>
          {clp(liquidacion.total)}
        </Text>
        <Text style={T.apoyo}>
          {liquidacion.cantidad} {liquidacion.cantidad === 1 ? 'pedido' : 'pedidos'}
          {liquidacion.pagado > 0 ? ` · ya recibiste ${clp(liquidacion.pagado)}` : ''}
        </Text>

        {liquidacion.pendiente > 0 && liquidacion.pagado > 0 ? (
          <Text style={[T.destacado, { marginTop: E.s, color: C.naranja }]}>
            Te deben {clp(liquidacion.pendiente)}
          </Text>
        ) : null}

        {liquidacion.pagadoAt && !liquidacion.confirmadoAt ? (
          <View style={{ marginTop: E.m }}>
            <Boton
              titulo={`RECIBÍ ${clp(liquidacion.pagado)}`}
              onPress={() => accion(() => api('POST', '/feriante/liquidacion/confirmar'))}
              deshabilitado={ocupado}
            />
          </View>
        ) : liquidacion.confirmadoAt ? (
          <Text style={[T.micro, { marginTop: E.s, color: C.verdeOscuro }]}>
            Pago confirmado ✓
          </Text>
        ) : null}
      </Tarjeta>

      <Seccion titulo="Pedidos que tomaste">
        {trabajo.length === 0 ? (
          <Vacio texto={feriante.conectado
            ? 'Sin pedidos por ahora.\nCuando entre uno, la pantalla te avisa.'
            : 'Estás en pausa.'} />
        ) : (
          trabajo.map((s: any, i: number) => (
            <Fila key={s.id} ultima={i === trabajo.length - 1}>
              <View style={e.filaCabeza}>
                <Text style={T.encabezado}>Pedido #{s.numero}</Text>
                <Chip
                  texto={s.estado === 'LISTO' ? 'Esperando retiro' : 'Preparar'}
                  tono={s.estado === 'LISTO' ? 'exito' : 'info'}
                />
              </View>

              {s.items.map((i2: any) => (
                <Text key={i2.id} style={[T.cuerpo, { marginTop: 2 }]}>
                  {i2.cantidad}× {i2.nombre}{'  '}
                  <Text style={T.apoyo}>{i2.formato}</Text>
                </Text>
              ))}

              <Text style={[T.cifraChica, { color: C.verdeOscuro, marginTop: E.s }]}>
                {clp(s.monto_feriante)}
              </Text>

              {s.estado === 'ACEPTADO' ? (
                <View style={{ marginTop: E.m, gap: E.s }}>
                  <Boton
                    titulo="LISTO PARA RETIRAR"
                    onPress={() => accion(() => api('POST', `/subpedidos/${s.id}/listo`))}
                    deshabilitado={ocupado}
                  />
                  <Boton
                    titulo="No lo puedo cumplir"
                    variante="peligro"
                    deshabilitado={ocupado}
                    onPress={() => Alert.alert(
                      'Devolver el pedido',
                      'Se le va a ofrecer a otro feriante y queda registrado. ¿Seguro?',
                      [
                        { text: 'Cancelar', style: 'cancel' },
                        {
                          text: 'Devolver', style: 'destructive',
                          onPress: () => accion(() =>
                            api('POST', `/subpedidos/${s.id}/liberar`)),
                        },
                      ])}
                  />
                </View>
              ) : null}
            </Fila>
          ))
        )}
      </Seccion>
    </Pantalla>
  );
}

/** La pantalla que aparece sola cuando entra un pedido. */
function OfertaEntrante({
  oferta, onAceptar, onRechazar, ocupado,
}: {
  oferta: any; onAceptar: () => void; onRechazar: () => void; ocupado: boolean;
}) {
  const restante = usarCuentaRegresiva(oferta.expira_at);

  // El teléfono está en el bolsillo del delantal: la vibración es
  // lo que realmente avisa, la pantalla es la confirmación.
  useEffect(() => {
    Vibration.vibrate([0, 400, 200, 400]);
  }, [oferta.sub_pedido_id]);

  return (
    <View style={e.oferta}>
      <View style={{ alignItems: 'center' }}>
        {/* Granate de la marca, no naranja: el naranja ya significa
            autogestión en el resto de la app. */}
        <Text style={[T.seccion, { color: C.marca }]}>
          Pedido nuevo · {oferta.rubro}
        </Text>
        <Text style={[T.cifra, { fontSize: 60, color: C.verdeOscuro, marginTop: E.s }]}>
          {clp(oferta.monto_feriante)}
        </Text>
        <Text style={T.apoyo}>es lo que ganas tú</Text>
      </View>

      <View style={e.lista}>
        {oferta.items.map((i: any, k: number) => (
          <View key={i.id} style={[e.item, k > 0 && e.conLinea]}>
            <Text style={[T.cifraMedia, { width: 56 }]}>{i.cantidad}×</Text>
            <View style={{ flex: 1 }}>
              <Text style={T.encabezado}>{i.nombre}</Text>
              <Text style={T.apoyo}>{i.formato}</Text>
            </View>
          </View>
        ))}
        {oferta.notas ? (
          <Text style={[T.apoyo, { padding: E.l, paddingTop: E.m, fontStyle: 'italic' }]}>
            “{oferta.notas}”
          </Text>
        ) : null}
      </View>

      <View style={{ gap: E.m }}>
        <BarraTiempo restante={restante} total={90} />
        <Boton titulo="SÍ, LO TENGO" grande onPress={onAceptar} deshabilitado={ocupado} />
        <Boton titulo="NO TENGO" variante="secundario" onPress={onRechazar}
               deshabilitado={ocupado} />
      </View>
    </View>
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
  oferta: {
    flex: 1,
    // Fondo liso, sin el lavado ni la marca de agua del resto de la
    // app: acá hay que decidir en segundos y nada puede competir
    // con el monto.
    backgroundColor: C.fondo,
    padding: E.l, paddingVertical: E.xxl,
    justifyContent: 'space-between',
  },
  lista: {
    backgroundColor: C.superficie,
    borderRadius: 18, borderWidth: 1, borderColor: C.borde,
  },
  item: { flexDirection: 'row', alignItems: 'center', padding: E.l },
  conLinea: { borderTopWidth: 1, borderTopColor: C.linea },
  filaCabeza: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: E.xs, gap: E.s,
  },
});
