import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, useTablero } from '../api';
import { C, E, R, T, clp } from '../tema';
import {
  Aviso, Boton, Cargando, Chip, Dato, Fila, Pantalla, Seccion, Tarjeta, Vacio, tonoEstado,
} from '../ui';
import Catalogo from './Catalogo';

/**
 * Tu panel.
 *
 * Lo primero que se ve no son las ventas: es la cola de autogestión,
 * porque es lo único que exige que te muevas ahora mismo.
 */
export default function Operador() {
  const [pestana, setPestana] = useState<'hoy' | 'catalogo'>('hoy');

  return (
    <View style={{ flex: 1 }}>
      <View style={e.pestanas}>
        <Pestana texto="Hoy" activa={pestana === 'hoy'} onPress={() => setPestana('hoy')} />
        <Pestana texto="Catálogo" activa={pestana === 'catalogo'}
                 onPress={() => setPestana('catalogo')} />
      </View>
      {pestana === 'hoy' ? <Hoy /> : <Catalogo />}
    </View>
  );
}

function Pestana({ texto, activa, onPress }: {
  texto: string; activa: boolean; onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[e.pestana, activa && e.pestanaActiva]}>
      <Text style={[T.apoyo, {
        color: activa ? '#FFFFFF' : C.textoSuave,
        fontFamily: T.destacado.fontFamily,
      }]}>
        {texto}
      </Text>
    </Pressable>
  );
}

function Hoy() {
  const { datos, error, cargando, recargar } =
    useTablero('/operador/tablero', 'operador', 'operador');
  const [ocupado, setOcupado] = useState(false);

  if (cargando) return <Cargando />;
  // Con datos en pantalla, una recarga que falla —la señal de la
  // feria— no los tapa con un error: se sigue mostrando lo último.
  if (error && !datos) return <Pantalla><Aviso texto={error} /></Pantalla>;
  if (!datos) return <Cargando />;

  const { autogestion, metricas, liquidaciones, activos } = datos;

  const accion = async (fn: () => Promise<unknown>) => {
    setOcupado(true);
    try {
      await fn();
      await recargar();
    } catch (err: any) {
      Alert.alert('No se pudo', err.message);
    } finally {
      setOcupado(false);
    }
  };

  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const tasa = metricas.subPedidos.tasaAutogestion;

  return (
    <Pantalla titulo="Hoy">
      <View style={e.grilla}>
        <Dato etiqueta="Pedidos" valor={String(metricas.pedidos.total)}
              pie={`${metricas.pedidos.entregados} entregados`} />
        <Dato etiqueta="Venta" valor={clp(metricas.pedidos.venta)}
              pie={`${clp(metricas.pedidos.despachoCobrado)} de despacho`} />
        <Dato etiqueta="Aceptación" valor={pct(metricas.ofertas.tasaAceptacion)}
              pie={`${metricas.ofertas.enviadas} ofertas`} />
        <Dato
          etiqueta="Lo hiciste tú"
          valor={pct(tasa)}
          pie={`${metricas.subPedidos.autogestion} de ${metricas.subPedidos.total}`}
          tono={tasa == null ? undefined : tasa > 0.3 ? 'alerta' : tasa > 0.15 ? 'aviso' : 'exito'}
        />
      </View>

      {/* La cuenta completa de lo entregado. La venta sube igual
          aunque cada pedido pierda plata; esto no. */}
      <Seccion titulo="La plata de hoy">
        <View style={{ padding: E.l }}>
          <Linea etiqueta="Ingresos" valor={metricas.plata.ingresos} />
          <Linea etiqueta="Mercadería a feriantes" valor={-metricas.plata.mercaderia} />
          <Linea etiqueta="Repartidores" valor={-metricas.plata.reparto} />
          <Linea etiqueta="Comisiones" valor={-metricas.plata.comisiones} />
          {metricas.plata.cancelaciones > 0 ? (
            <Linea
              etiqueta={`Cancelaciones (${metricas.plata.pedidosCancelados})`}
              valor={-metricas.plata.cancelaciones}
            />
          ) : null}

          <View style={e.separador} />
          <View style={e.entre}>
            <Text style={T.encabezado}>Te queda</Text>
            <Text style={[T.cifraMedia, {
              color: metricas.plata.margen >= 0 ? C.verdeOscuro : C.rojo,
            }]}>
              {clp(metricas.plata.margen)}
            </Text>
          </View>
          <Text style={[T.micro, { marginTop: E.xs }]}>
            {metricas.plata.porPedido !== null
              ? `${clp(metricas.plata.porPedido)} por pedido entregado`
              : 'Todavía no entregaste nada hoy'}
            {metricas.plata.tasaMargen !== null
              ? ` · ${(metricas.plata.tasaMargen * 100).toFixed(1)}% de la venta`
              : ''}
          </Text>
        </View>
      </Seccion>

      <Seccion titulo={`Tienes que ir a comprar (${autogestion.length})`}>
        {autogestion.length === 0 ? (
          <Vacio texto="Nada pendiente. Los feriantes tomaron todo." />
        ) : (
          autogestion.map((s: any, i: number) => (
            <Fila key={s.id} ultima={i === autogestion.length - 1}>
              <View style={e.entre}>
                <Text style={T.encabezado}>Pedido #{s.numero} · {s.rubro}</Text>
                <Chip texto="Autogestión" tono="marca" />
              </View>
              {s.items.map((i2: any) => (
                <Text key={i2.id} style={[T.cuerpo, { marginTop: 2 }]}>
                  {i2.cantidad}× {i2.nombre}{'  '}
                  <Text style={T.apoyo}>{i2.formato}</Text>
                </Text>
              ))}
              <Text style={[T.apoyo, { marginTop: E.s }]}>
                Presupuesto {clp(s.monto_feriante)} · entrega en {s.direccion}
              </Text>
              <View style={{ marginTop: E.m }}>
                <Boton
                  titulo="YA LO COMPRÉ"
                  variante="atencion"
                  deshabilitado={ocupado}
                  onPress={() => accion(() =>
                    api('POST', `/operador/autogestion/${s.id}/listo`))}
                />
              </View>
            </Fila>
          ))
        )}
      </Seccion>

      <Seccion titulo={`Pedidos en curso (${activos.length})`}>
        {activos.length === 0 ? (
          <Vacio texto="Sin pedidos activos." />
        ) : (
          activos.map((p: any, i: number) => (
            <Fila key={p.id} ultima={i === activos.length - 1}>
              <View style={e.entre}>
                <Text style={T.encabezado}>#{p.numero} · {p.cliente_nombre}</Text>
                <Chip texto={p.estado.replace(/_/g, ' ')} tono={tonoEstado(p.estado)} />
              </View>
              <Text style={[T.apoyo, { marginTop: 2 }]}>
                {p.direccion} · {clp(p.total_venta)}
              </Text>
              <View style={{ marginTop: E.m }}>
                <Boton
                  titulo="Cancelar este pedido"
                  variante="peligro"
                  deshabilitado={ocupado}
                  onPress={() => Alert.alert(
                    `Cancelar el pedido #${p.numero}`,
                    'Se le devuelve la plata al cliente. A los feriantes que ya ' +
                    'aceptaron se les paga igual: apartaron la mercadería.',
                    [
                      { text: 'No', style: 'cancel' },
                      {
                        text: 'Cancelar pedido',
                        style: 'destructive',
                        onPress: () => accion(async () => {
                          const r = await api('POST', `/operador/pedidos/${p.id}/cancelar`,
                            { cuerpo: { motivo: 'cancelado desde el panel' } });
                          const comp = r.compensaciones
                            .map((c: any) => `${c.nombre}: ${clp(c.monto)}`).join('\n');
                          Alert.alert('Pedido cancelado', [
                            r.reembolso.solicitado
                              ? `Devolución pedida: ${clp(r.reembolso.monto)}`
                              : `Devolución PENDIENTE (${r.reembolso.motivo})`,
                            comp ? `\nLes pagas igual:\n${comp}` : '',
                          ].join('\n'));
                        }),
                      },
                    ])}
                />
              </View>
            </Fila>
          ))
        )}
      </Seccion>

      <Seccion titulo={`A pagar esta tarde · ${clp(liquidaciones.totalAPagar)}`}>
        {liquidaciones.feriantes.length === 0 ? (
          <Vacio texto="Nadie entregó nada todavía." />
        ) : (
          liquidaciones.feriantes.map((f: any, i: number) => (
            <Fila key={f.id} ultima={i === liquidaciones.feriantes.length - 1}>
              <View style={e.entre}>
                <View style={{ flex: 1 }}>
                  <Text style={T.encabezado}>{f.nombre}</Text>
                  <Text style={T.apoyo}>{f.puesto}</Text>
                </View>
                <Text style={[T.cifraMedia, {
                  color: f.pendiente > 0 ? C.verdeOscuro : C.textoSuave,
                }]}>
                  {clp(f.pendiente > 0 ? f.pendiente : f.total)}
                </Text>
              </View>
              <Text style={[T.micro, { marginTop: E.xs }]}>
                {f.cantidad} {f.cantidad === 1 ? 'bolsa' : 'bolsas'} · ganó {clp(f.total)}
                {f.pagado > 0 ? ` · ya le diste ${clp(f.pagado)}` : ''}
                {f.confirmado_at ? ' · confirmado ✓'
                  : f.pagado_at && f.pendiente === 0 ? ' · falta que confirme' : ''}
              </Text>
              {f.pendiente > 0 ? (
                <View style={{ marginTop: E.m }}>
                  <Boton
                    titulo={`PAGUÉ ${clp(f.pendiente)} EN EFECTIVO`}
                    deshabilitado={ocupado}
                    onPress={() => Alert.alert(
                      'Confirmar pago',
                      `¿Le entregaste ${clp(f.pendiente)} a ${f.nombre}?`,
                      [
                        { text: 'Todavía no', style: 'cancel' },
                        {
                          text: 'Sí, le pagué',
                          onPress: () => accion(() => api(
                            'POST', `/operador/liquidaciones/${f.id}/pagar`)),
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

function Linea({ etiqueta, valor }: { etiqueta: string; valor: number }) {
  return (
    <View style={[e.entre, { paddingVertical: 3 }]}>
      <Text style={T.apoyo}>{etiqueta}</Text>
      <Text style={[T.cifraChica, valor < 0 && { color: C.textoSuave }]}>{clp(valor)}</Text>
    </View>
  );
}

const e = StyleSheet.create({
  entre: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: E.s,
  },
  grilla: { flexDirection: 'row', flexWrap: 'wrap', gap: E.m, marginBottom: E.xl },
  separador: { height: 1, backgroundColor: C.linea, marginVertical: E.m },
  pestanas: {
    flexDirection: 'row', gap: E.s,
    paddingHorizontal: E.l, paddingBottom: E.m,
  },
  pestana: {
    paddingHorizontal: E.xl, paddingVertical: E.s,
    borderRadius: R.pastilla, borderWidth: 1, borderColor: C.borde,
    backgroundColor: C.superficie, userSelect: 'none',
  },
  pestanaActiva: { backgroundColor: C.verde, borderColor: C.verde },
});
