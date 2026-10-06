import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from './api';
import { C, E, R, T } from './tema';
import { Boton, Cargando } from './ui';

type Textos = { version: string; terminos: string; privacidad: string };

/**
 * Los términos y la política de privacidad, antes de usar la app.
 *
 * Se muestran una vez por versión: si el texto cambia, el servidor
 * lo vuelve a pedir. Queda guardado quién aceptó qué y cuándo.
 *
 * Si no se puede preguntar —la feria sin señal— se deja pasar: es
 * peor dejar a un feriante sin poder atender que pedirle la
 * aceptación un rato después.
 */
export default function ConTerminos({ children, onSalir }: {
  children: React.ReactNode;
  /** No acepta: se cierra la sesión. */
  onSalir: () => void;
}) {
  const [estado, setEstado] = useState<'viendo' | 'pendiente' | 'listo'>('viendo');
  const [textos, setTextos] = useState<Textos | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      try {
        const yo = await api('GET', '/auth/yo');
        if (!yo.terminosPendientes) return vigente && setEstado('listo');
        const t = await api('GET', '/legal', { sinSesion: true });
        if (vigente) { setTextos(t); setEstado('pendiente'); }
      } catch {
        if (vigente) setEstado('listo');
      }
    })();
    return () => { vigente = false; };
  }, []);

  if (estado === 'listo') return <>{children}</>;
  if (estado === 'viendo' || !textos) {
    return <View style={e.pantalla}><Cargando /></View>;
  }

  const aceptar = async () => {
    setOcupado(true);
    try {
      await api('POST', '/auth/aceptar-terminos', { cuerpo: { version: textos.version } });
      setEstado('listo');
    } catch (err: any) {
      Alert.alert('No se pudo guardar', err.message);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <SafeAreaView style={e.pantalla}>
      <View style={e.cabecera}>
        <Text style={T.titulo}>Antes de empezar</Text>
        <Text style={[T.apoyo, { marginTop: E.xs }]}>
          Lee cómo funciona la app y qué hacemos con tus datos.
        </Text>
      </View>
      <ScrollView style={e.caja} contentContainerStyle={{ padding: E.l }}>
        <TextoLegal texto={textos.terminos} />
        <View style={e.separador} />
        <TextoLegal texto={textos.privacidad} />
      </ScrollView>
      <View style={e.pie}>
        <Boton
          titulo={ocupado ? 'GUARDANDO…' : 'ACEPTO'}
          onPress={aceptar}
          deshabilitado={ocupado}
        />
        <Boton titulo="No acepto, salir" variante="secundario" onPress={onSalir} />
      </View>
    </SafeAreaView>
  );
}

/**
 * Un texto legal, compuesto para leerse.
 *
 * El archivo viene cortado a 70 columnas, como se escribe en un
 * editor: mostrado tal cual, cada línea se partía a mitad de frase.
 * Acá cada párrafo se une, los títulos se ven como títulos y cada
 * punto numerado lleva su nombre destacado.
 */
export function TextoLegal({ texto }: { texto: string }) {
  const crudos = texto.trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <View style={{ gap: E.m }}>
      {crudos.map((crudo, i) => {
        // Una lista: cada línea que parte con «- » es un punto.
        if (/^- /.test(crudo)) {
          const puntos = crudo.split(/\n(?=- )/).map((l) => l.replace(/^- /, '').replace(/\s*\n\s*/g, ' '));
          return (
            <View key={i} style={{ gap: E.s }}>
              {puntos.map((p, j) => (
                <View key={j} style={{ flexDirection: 'row', gap: E.s }}>
                  <Text style={[T.cuerpo, { color: C.verde }]}>•</Text>
                  <Text style={[T.cuerpo, { flex: 1 }]}>{p}</Text>
                </View>
              ))}
            </View>
          );
        }
        const b = crudo.replace(/\s*\n\s*/g, ' ');
        if (/^BORRADOR/i.test(b)) {
          return <Text key={i} style={[T.micro, e.borrador]}>{b}</Text>;
        }
        // Títulos de capítulo: «I. Antecedentes generales».
        if (/^[IVX]+\.\s/.test(b) && b.length < 70) {
          return <Text key={i} style={[T.seccion, { marginTop: E.m, color: C.verdeOscuro }]}>{b}</Text>;
        }
        const punto = /^(\d+)\.\s+([^.]{2,60}\.)\s*(.*)$/.exec(b);
        if (punto) {
          return (
            <Text key={i} style={T.cuerpo}>
              <Text style={T.destacado}>{punto[1]}. {punto[2]} </Text>
              {punto[3]}
            </Text>
          );
        }
        // Una línea corta sin punto final es un título.
        if (b.length < 70 && !/[.:;,]$/.test(b)) {
          return <Text key={i} style={[T.encabezado, { marginTop: E.xs }]}>{b.replace(/^#+\s*/, '')}</Text>;
        }
        return <Text key={i} style={T.cuerpo}>{b}</Text>;
      })}
    </View>
  );
}

const e = StyleSheet.create({
  borrador: {
    color: C.naranja, backgroundColor: C.naranjaSuave, borderRadius: R.chico,
    paddingHorizontal: E.m, paddingVertical: E.s, overflow: 'hidden',
  },
  pantalla: { flex: 1, backgroundColor: C.fondo },
  cabecera: { padding: E.l, paddingBottom: E.m },
  caja: {
    flex: 1, marginHorizontal: E.l, backgroundColor: C.superficie,
    borderRadius: R.grande, borderWidth: 1, borderColor: C.borde,
  },
  separador: { height: 1, backgroundColor: C.linea, marginVertical: E.l },
  pie: { padding: E.l, gap: E.s },
});
