import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '../api';
import { C, E, R, T } from '../tema';
import { Boton } from '../ui';
import { Campo, useRellenoPestanas } from './piezas';
import { useRecurso } from './cargar';
import { useCliente, type Perfil as DatosPerfil } from './estado';
import { textoHorario, textoUltimoPedido } from './horario';
import Postular from './Postular';

/** Datos de entrega y contacto de la feria. */
export default function Perfil({ onSalir }: { onSalir: () => void }) {
  const { perfil, guardarPerfil, misPedidos } = useCliente();
  const [borrador, setBorrador] = useState<DatosPerfil>(perfil);
  const [guardado, setGuardado] = useState(false);
  const [feria, setFeria] = useState<any>(null);
  const relleno = useRellenoPestanas();
  const { datos: referencia } = useRecurso<{ creditos: Record<string, any> }>('/referencia');
  const [verCreditos, setVerCreditos] = useState(false);

  useEffect(() => { setBorrador(perfil); }, [perfil]);
  useEffect(() => { api('GET', '/feria/estado').then(setFeria).catch(() => {}); }, []);

  const cambiado = JSON.stringify(borrador) !== JSON.stringify(perfil);

  return (
    <ScrollView
      style={e.pantalla}
      contentContainerStyle={[e.relleno, { paddingBottom: relleno + E.l }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={e.portada}>
        <View style={e.avatar}>
          <Text style={e.inicial}>
            {(perfil.nombre.trim() || '?').charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[T.encabezado, { color: '#FFFFFF' }]}>
            {perfil.nombre.trim() || 'Tus datos'}
          </Text>
          <Text style={[T.micro, { color: 'rgba(255,255,255,0.85)' }]}>
            {misPedidos.length === 0
              ? 'Sin pedidos todavía'
              : `${misPedidos.length} ${misPedidos.length === 1 ? 'pedido' : 'pedidos'}`}
          </Text>
        </View>
      </View>

      <View style={e.bloque}>
        <Text style={[T.destacado, { marginBottom: E.s }]}>Datos de entrega</Text>
        <View style={{ gap: E.m }}>
          <Campo
            etiqueta="Nombre"
            value={borrador.nombre}
            onChangeText={(v) => { setBorrador({ ...borrador, nombre: v }); setGuardado(false); }}
            placeholder="Tu nombre"
          />
          <Campo
            etiqueta="Teléfono de contacto"
            value={borrador.telefono}
            onChangeText={(v) => { setBorrador({ ...borrador, telefono: v }); setGuardado(false); }}
            placeholder="+56 9 1234 5678"
            keyboardType="phone-pad"
          />
          <Campo
            etiqueta="Dirección"
            value={borrador.direccion}
            onChangeText={(v) => { setBorrador({ ...borrador, direccion: v }); setGuardado(false); }}
            placeholder="Calle, número, depto"
          />
          <Campo
            etiqueta="Correo"
            value={borrador.email}
            onChangeText={(v) => { setBorrador({ ...borrador, email: v }); setGuardado(false); }}
            placeholder="tu@correo.cl"
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>
        <View style={{ marginTop: E.l }}>
          <Boton
            titulo={guardado && !cambiado ? 'GUARDADO ✓' : 'GUARDAR'}
            onPress={async () => { await guardarPerfil(borrador); setGuardado(true); }}
            deshabilitado={!cambiado}
          />
        </View>
      </View>

      {feria ? (
        <View style={e.bloque}>
          <Text style={[T.destacado, { marginBottom: E.s }]}>La feria</Text>
          <Dato rotulo="Horario" valor={textoHorario(feria.horario)} />
          <Dato rotulo="Pedidos" valor={textoUltimoPedido(feria.horario)} />
          <Dato rotulo="Hoy" valor={feria.aceptandoPedidos ? 'Tomando pedidos' : (feria.mensaje ?? 'Cerrada')} />
          {feria.contacto ? <Dato rotulo="Contacto" valor={feria.contacto} /> : null}
        </View>
      ) : null}

      {/* Las fotos del catálogo son Creative Commons y la licencia
          exige dar crédito a quien las sacó. Va acá, donde se puede
          leer, y no escondido en un archivo del repositorio. */}
      {referencia?.creditos ? (
        <View style={e.bloque}>
          <Pressable onPress={() => setVerCreditos((v) => !v)}>
            <View style={e.dato}>
              <Text style={T.destacado}>Fotos del catálogo</Text>
              <Text style={[T.micro, { color: C.verdeOscuro }]}>
                {verCreditos ? 'Ocultar' : 'Ver créditos'}
              </Text>
            </View>
          </Pressable>
          <Text style={[T.micro, { marginTop: 2 }]}>
            Son imágenes de referencia, no del puesto. Lo que llega puede verse distinto.
          </Text>
          {verCreditos ? (
            <View style={{ marginTop: E.m, gap: E.s }}>
              {Object.values(referencia.creditos).map((c: any) => (
                <Text key={c.archivo} style={T.micro}>
                  {c.titulo} · {c.autor} · {c.licencia}
                </Text>
              ))}
              <Text style={[T.micro, { marginTop: E.xs }]}>
                Vía Wikimedia Commons.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <Postular />

      <Boton titulo="Cerrar sesión" variante="secundario" onPress={onSalir} />
    </ScrollView>
  );
}

function Dato({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <View style={e.dato}>
      <Text style={T.apoyo}>{rotulo}</Text>
      <Text style={[T.destacado, { flexShrink: 1, textAlign: 'right' }]}>{valor}</Text>
    </View>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  relleno: { padding: E.l, gap: E.l },
  portada: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    backgroundColor: C.verde, borderRadius: R.enorme, padding: E.l,
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  inicial: { fontFamily: T.titulo.fontFamily, fontSize: 22, color: '#FFFFFF' },
  bloque: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
  dato: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: E.m, paddingVertical: 6,
  },
});
