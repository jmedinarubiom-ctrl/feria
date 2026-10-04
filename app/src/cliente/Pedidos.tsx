import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '../api';
import { C, E, R, T, clp } from '../tema';
import { Cargando, Chip, Vacio, tonoEstado } from '../ui';
import { useCliente } from './estado';
import { useRellenoPestanas } from './piezas';

/**
 * Los pedidos hechos desde este teléfono.
 *
 * El cliente no tiene cuenta en el servidor, así que la lista de
 * ids vive en el teléfono y acá se le pregunta al servidor el
 * estado de cada uno.
 */
export default function Pedidos({ navegar }: { navegar: (p: string, args?: any) => void }) {
  const { misPedidos } = useCliente();
  const [pedidos, setPedidos] = useState<any[] | null>(null);
  const relleno = useRellenoPestanas();

  useEffect(() => {
    if (misPedidos.length === 0) return setPedidos([]);
    let vigente = true;
    void (async () => {
      const r = await Promise.all(
        // Un pedido que el servidor ya no conoce no debe tirar abajo
        // la lista entera.
        misPedidos.map((id) => api('GET', `/pedidos/${id}`).catch(() => null)),
      );
      if (vigente) setPedidos(r.filter(Boolean));
    })();
    return () => { vigente = false; };
  }, [misPedidos]);

  if (!pedidos) return <Cargando />;

  const enCurso = pedidos.filter((p) => !FINALES.includes(p.estado));
  const pasados = pedidos.filter((p) => FINALES.includes(p.estado));

  return (
    <ScrollView
      style={e.pantalla}
      contentContainerStyle={[e.relleno, { paddingBottom: relleno + E.l }]}
    >
      <Text style={T.titulo}>Mis pedidos</Text>

      {pedidos.length === 0 ? (
        <View style={{ marginTop: E.xl }}>
          <Vacio texto="Todavía no hiciste pedidos. Tu feria llega el mismo día." />
        </View>
      ) : null}

      {enCurso.length > 0 ? (
        <View style={{ gap: E.m, marginTop: E.l }}>
          <Text style={T.seccion}>En curso</Text>
          {enCurso.map((p) => <Tarjeta key={p.id} pedido={p} navegar={navegar} />)}
        </View>
      ) : null}

      {pasados.length > 0 ? (
        <View style={{ gap: E.m, marginTop: E.xl }}>
          <Text style={T.seccion}>Anteriores</Text>
          {pasados.map((p) => <Tarjeta key={p.id} pedido={p} navegar={navegar} />)}
        </View>
      ) : null}
    </ScrollView>
  );
}

const FINALES = ['ENTREGADO', 'CANCELADO', 'EXPIRADO'];

function Tarjeta({ pedido, navegar }: {
  pedido: any; navegar: (p: string, args?: any) => void;
}) {
  const unidades = pedido.subPedidos
    .flatMap((s: any) => s.items)
    .reduce((a: number, i: any) => a + i.cantidad, 0);

  return (
    <Pressable
      onPress={() => navegar('Seguimiento', { pedidoId: pedido.id })}
      style={({ pressed }) => [e.tarjeta, pressed && { opacity: 0.85 }]}
    >
      <View style={e.entre}>
        <Text style={T.destacado}>Pedido #{pedido.numero}</Text>
        <Chip texto={pedido.estado.replace(/_/g, ' ')} tono={tonoEstado(pedido.estado)} />
      </View>
      <Text style={[T.micro, { marginTop: 2 }]} numberOfLines={1}>{pedido.direccion}</Text>
      <View style={[e.entre, { marginTop: E.s }]}>
        <Text style={T.apoyo}>
          {unidades} {unidades === 1 ? 'producto' : 'productos'}
        </Text>
        <Text style={[T.cifraChica, { color: C.verde }]}>{clp(pedido.total_venta)}</Text>
      </View>
    </Pressable>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  relleno: { padding: E.l },
  tarjeta: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
  entre: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: E.s,
  },
});
