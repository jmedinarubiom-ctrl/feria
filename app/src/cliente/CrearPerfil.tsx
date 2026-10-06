import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { C, E, T } from '../tema';
import { Boton, Cargando } from '../ui';
import { Campo } from './piezas';
import { useCliente, type Perfil } from './estado';

/**
 * «Crea tu perfil», la primera vez que alguien entra.
 *
 * Un número o un correo nuevo quedaba registrado y pasaba derecho
 * al catálogo como un usuario sin nombre: la app lo saludaba con un
 * «Hola» a secas y recién le pedía los datos al momento de pagar.
 * Acá se presenta: cómo se llama y a qué teléfono llamarlo. La
 * dirección puede esperar al primer pedido.
 */
export default function ConPerfil({ children, onSalir }: {
  children: React.ReactNode;
  onSalir: () => void;
}) {
  const { perfil, perfilListo, guardarPerfil, telefonoVerificado } = useCliente();
  const [borrador, setBorrador] = useState<Perfil>(perfil);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => { setBorrador(perfil); }, [perfil]);

  if (!perfilListo) return <View style={e.pantalla}><Cargando /></View>;
  // Nombre y teléfono: quien entra con Google ya trae el nombre,
  // pero no un número al que llamarlo.
  if (perfil.nombre.trim() && perfil.telefono.trim()) return <>{children}</>;

  const telefonoOk = borrador.telefono.replace(/\D/g, '').length >= 8;
  const listo = borrador.nombre.trim().length >= 2 && telefonoOk;

  return (
    <KeyboardAvoidingView
      style={e.pantalla}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={e.relleno} keyboardShouldPersistTaps="handled">
        <Text style={T.titulo}>Crea tu perfil</Text>
        <Text style={[T.apoyo, { marginTop: E.xs, marginBottom: E.xl }]}>
          Es la primera vez que entras. Con esto sabemos a quién le llevamos el pedido.
        </Text>

        <View style={{ gap: E.m }}>
          <Campo
            etiqueta="Tu nombre"
            value={borrador.nombre}
            onChangeText={(v) => setBorrador({ ...borrador, nombre: v })}
            placeholder="Nombre y apellido"
          />
          <Campo
            etiqueta={telefonoVerificado ? 'Teléfono (confirmado)' : 'Teléfono de contacto'}
            value={telefonoVerificado ?? borrador.telefono}
            onChangeText={(v) => setBorrador({ ...borrador, telefono: v })}
            placeholder="+56 9 1234 5678"
            keyboardType="phone-pad"
            editable={!telefonoVerificado}
            ayuda={telefonoVerificado
              ? 'Es el número con el que entraste.'
              : 'Para que el repartidor te pueda llamar cuando esté llegando.'}
          />
          <Campo
            etiqueta="Dirección de entrega (opcional)"
            value={borrador.direccion}
            onChangeText={(v) => setBorrador({ ...borrador, direccion: v })}
            placeholder="Calle, número, depto"
            ayuda="La puedes poner ahora o al hacer tu primer pedido."
          />
        </View>

        <View style={{ marginTop: E.xl, gap: E.s }}>
          <Boton
            titulo={guardando ? 'GUARDANDO…' : 'CREAR MI PERFIL'}
            deshabilitado={!listo || guardando}
            onPress={async () => {
              setGuardando(true);
              await guardarPerfil({
                ...borrador,
                nombre: borrador.nombre.trim(),
                telefono: borrador.telefono.trim(),
                direccion: borrador.direccion.trim(),
              });
              setGuardando(false);
            }}
          />
          <Boton titulo="Salir" variante="secundario" onPress={onSalir} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: C.fondo },
  relleno: { padding: E.l, paddingTop: E.xxl },
});
