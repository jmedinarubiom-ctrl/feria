import React from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';


import { C, E, R, T } from '../tema';
import { Cargando, NoCargo } from '../ui';
import { useRecurso } from './cargar';
import { Manzana } from '../Logotipo';
import { llamar, useRellenoPestanas } from './piezas';
import { textoHorario, textoUltimoPedido } from './horario';
import { useCliente } from './estado';
import { Icono, iconoDeRubro } from '../iconos';

/**
 * La feria.
 *
 * El cliente elige de qué feria le traen —la que le queda cerca—,
 * pero no elige puesto: el pedido se ofrece a todos los del rubro
 * en esa feria y lo toma el primero que puede. Las ferias que
 * todavía no reparten aparecen como «próximamente».
 */
export default function Feria({ navegar }: { navegar: (p: string, args?: any) => void }) {
  const { feriaId, elegirFeria, unidades } = useCliente();
  const { datos: feria, error, recargar } =
    useRecurso<any>(`/feria/estado?feria=${encodeURIComponent(feriaId)}`);
  const { datos: todas } = useRecurso<{ ferias: any[] }>('/ferias');

  // Cambiar de feria vacía el carro: mejor preguntar que perderlo
  // por un toque.
  const cambiarA = (f: any) => {
    if (f.id === feriaId) return;
    if (unidades === 0) return elegirFeria(f.id);
    Alert.alert('Cambiar de feria', `Tu carrito se vacía si cambias a ${f.nombre}.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Cambiar', onPress: () => elegirFeria(f.id) },
    ]);
  };
  const { datos: catalogo } = useRecurso<any[]>('/catalogo');
  const relleno = useRellenoPestanas();

  if (error) return <NoCargo error={error} onReintentar={recargar} />;
  if (!feria || !catalogo) return <Cargando />;

  // Un servidor que todavía no manda el nombre o la calle no puede
  // dejar el botón del mapa buscando «undefined».
  const lugar = [feria.nombre ?? 'Feria libre', feria.calle, feria.comuna ?? 'Valparaíso']
    .filter(Boolean).join(', ');

  const abierta = feria.aceptandoPedidos;

  return (
    <ScrollView
      style={e.pantalla}
      contentContainerStyle={[e.relleno, { paddingBottom: relleno + E.l }]}
    >
      <Text style={T.titulo}>La feria</Text>

      <View style={e.mapa}>
        {/* Sin mapa de verdad: una tarjeta de lugar que abre la app
            de mapas del teléfono. Un mapa embebido cuesta por carga
            y acá hay una sola dirección que nunca cambia. */}
        <View style={e.manzanaFondo}>
          <Manzana tamano={190} />
        </View>
        <View style={e.lugar}>
          <Text style={[T.encabezado, { color: '#FFFFFF' }]}>{feria.nombre ?? 'Tu feria'}</Text>
          <Text style={[T.apoyo, { color: 'rgba(255,255,255,0.85)' }]}>
            {[feria.calle, feria.comuna].filter(Boolean).join(', ')}
          </Text>
          <Pressable
            onPress={() => Linking.openURL(
              `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lugar)}`)}
            style={({ pressed }) => [e.verMapa, pressed && { opacity: 0.8 }]}
          >
            <Text style={[T.micro, { color: C.verdeOscuro, fontFamily: T.destacado.fontFamily }]}>
              Ver en el mapa
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={[e.estado, { backgroundColor: abierta ? C.verdeSuave : C.rojoSuave }]}>
        <View style={[e.punto, { backgroundColor: abierta ? C.verde : C.rojo }]} />
        <Text style={[T.destacado, { color: abierta ? C.verdeOscuro : C.rojo, flex: 1 }]}>
          {abierta ? 'Tomando pedidos ahora' : 'Cerrada'}
        </Text>
        {abierta && feria.minutosParaCerrar != null && feria.minutosParaCerrar < 90 ? (
          <Text style={[T.micro, { color: C.verdeOscuro }]}>
            {feria.minutosParaCerrar} min
          </Text>
        ) : null}
      </View>

      {!abierta ? (
        <Text style={[T.apoyo, { marginTop: -E.s }]}>{feria.mensaje}</Text>
      ) : null}

      <View style={e.bloque}>
        <Text style={[T.destacado, { marginBottom: E.s }]}>Horario</Text>
        <Text style={T.cuerpo}>{textoHorario(feria.horario)}</Text>
        <Text style={[T.micro, { marginTop: 2 }]}>{textoUltimoPedido(feria.horario)}</Text>
      </View>

      {todas && todas.ferias.length > 1 ? (
        <View style={e.bloque}>
          <Text style={[T.destacado, { marginBottom: E.s }]}>Elige tu feria</Text>
          {todas.ferias.map((f) => {
            const elegida = f.id === feriaId;
            return (
              <Pressable
                key={f.id}
                disabled={!f.activa}
                onPress={() => cambiarA(f)}
                accessibilityRole="button"
                accessibilityState={{ selected: elegida, disabled: !f.activa }}
                style={({ pressed }) => [
                  e.opcionFeria,
                  elegida && { borderColor: C.verde, backgroundColor: C.verdeSuave },
                  !f.activa && { opacity: 0.55 },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={T.destacado}>{f.nombre}</Text>
                  <Text style={T.micro}>{f.comuna} · {textoHorario(f.horario)}</Text>
                </View>
                <Text style={[T.micro, { color: elegida ? C.verdeOscuro : C.textoSuave }]}>
                  {elegida ? 'Tu feria ✓' : f.activa ? 'Elegir' : 'Próximamente'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={e.bloque}>
        <Text style={[T.destacado, { marginBottom: E.m }]}>Cómo funciona</Text>
        {[
          ['1', 'Armas tu pedido', 'Precio fijo, igual en todos los puestos.'],
          ['2', 'Lo compramos en la feria', 'Un puesto del rubro aparta tu mercadería esa mañana.'],
          ['3', 'Te lo llevamos', 'El repartidor lo retira del puesto y va a tu dirección.'],
        ].map(([n, titulo, texto]) => (
          <View key={n} style={e.paso}>
            <View style={e.numero}><Text style={e.numeroTexto}>{n}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={T.destacado}>{titulo}</Text>
              <Text style={T.apoyo}>{texto}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={e.bloque}>
        <Text style={[T.destacado, { marginBottom: E.m }]}>Qué hay</Text>
        <View style={e.rubros}>
          {catalogo.map((r: any) => (
            <Pressable
              key={r.id}
              onPress={() => navegar('Categoria', { rubroId: r.id, nombre: r.nombre })}
              style={({ pressed }) => [e.rubro, pressed && { opacity: 0.8 }]}
            >
              <View style={{ marginBottom: 4 }}>
                <Icono nombre={iconoDeRubro(r.id).icono} tamano={22} color={iconoDeRubro(r.id).color} />
              </View>
              <Text style={T.destacado}>{r.nombre}</Text>
              <Text style={T.micro}>
                {r.productos.length} {r.productos.length === 1 ? 'producto' : 'productos'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {feria.contacto ? (
        <Pressable
          onPress={() => llamar(feria.contacto)}
          style={({ pressed }) => [e.bloque, e.contacto, pressed && { opacity: 0.85 }]}
        >
          <Icono nombre="telefono" tamano={20} color={C.verdeOscuro} />
          <View style={{ flex: 1 }}>
            <Text style={T.destacado}>Hablar con nosotros</Text>
            <Text style={T.micro}>{feria.contacto}</Text>
          </View>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const e = StyleSheet.create({
  opcionFeria: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    padding: E.m, marginTop: E.s, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde,
  },
  pantalla: { flex: 1, backgroundColor: C.fondo },
  relleno: { padding: E.l, gap: E.l },

  mapa: {
    height: 190, borderRadius: R.enorme, overflow: 'hidden',
    backgroundColor: C.verde, justifyContent: 'flex-end',
  },
  manzanaFondo: {
    position: 'absolute', right: -40, top: -30, opacity: 0.14,
  },
  lugar: { padding: E.l, gap: E.xs, alignItems: 'flex-start' },
  verMapa: {
    marginTop: E.xs, backgroundColor: '#FFFFFF',
    borderRadius: R.pastilla, paddingHorizontal: E.l, paddingVertical: E.s,
    userSelect: 'none',
  },

  estado: {
    flexDirection: 'row', alignItems: 'center', gap: E.s,
    borderRadius: R.medio, paddingHorizontal: E.l, paddingVertical: E.m,
  },
  punto: { width: 9, height: 9, borderRadius: 5 },

  bloque: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
  paso: { flexDirection: 'row', gap: E.m, paddingVertical: E.s },
  numero: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: C.verdeSuave,
    alignItems: 'center', justifyContent: 'center',
  },
  numeroTexto: {
    fontFamily: T.destacado.fontFamily, fontSize: 13, color: C.verdeOscuro,
  },
  rubros: { flexDirection: 'row', flexWrap: 'wrap', gap: E.s },
  rubro: {
    flexGrow: 1, flexBasis: '45%',
    backgroundColor: C.fondo, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, padding: E.m, userSelect: 'none',
  },
  contacto: { flexDirection: 'row', alignItems: 'center', gap: E.m },
});
