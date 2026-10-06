import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { api } from '../api';
import { C, E, R, T } from '../tema';
import { Boton } from '../ui';
import { Campo } from './piezas';

type Solicitud = { tipo: 'feriante' | 'repartidor'; estado: string } | null;

/**
 * «Quiero vender» / «quiero repartir».
 *
 * Cualquiera entra a la app como cliente. Quien tiene un puesto o
 * reparte lo pide acá, con el teléfono con el que ya entró, y queda
 * esperando a que la operación lo apruebe: nadie empieza a recibir
 * pedidos de clientes reales solo por anotarse.
 */
export default function Postular() {
  const [solicitud, setSolicitud] = useState<Solicitud | undefined>(undefined);
  const [tipo, setTipo] = useState<'feriante' | 'repartidor' | null>(null);
  const [rubros, setRubros] = useState<Array<{ id: string; nombre: string }>>([]);
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [ferias, setFerias] = useState<Array<{ id: string; nombre: string; comuna: string }>>([]);
  const [feriaId, setFeriaId] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [puesto, setPuesto] = useState('');
  const [vehiculo, setVehiculo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [conTelefono, setConTelefono] = useState(true);

  useEffect(() => {
    api('GET', '/auth/yo')
      .then((yo) => {
        setSolicitud(yo.solicitud ?? null);
        setNombre(yo.perfil?.nombre ?? '');
        setConTelefono(!!yo.perfil?.telefono);
      })
      .catch(() => setSolicitud(null));
    api('GET', '/catalogo')
      .then((c: any[]) => setRubros(c.map((r) => ({ id: r.id, nombre: r.nombre }))))
      .catch(() => {});
    api('GET', '/ferias', { sinSesion: true })
      .then((r) => setFerias(r.ferias))
      .catch(() => {});
  }, []);

  if (solicitud === undefined) return null;

  if (solicitud) {
    const que = solicitud.tipo === 'feriante' ? 'vender en la feria' : 'repartir';
    return (
      <View style={e.bloque}>
        <Text style={T.destacado}>Tu solicitud para {que}</Text>
        <Text style={[T.apoyo, { marginTop: E.xs }]}>
          {solicitud.estado === 'pendiente'
            ? 'La estamos revisando. Cuando la aprueben, sal de la app y vuelve a entrar con tu teléfono.'
            : solicitud.estado === 'aprobada'
              ? 'Ya está aprobada. Sal de la app y vuelve a entrar con tu teléfono.'
              : 'Está cerrada. Si crees que es un error, llama a la operación.'}
        </Text>
      </View>
    );
  }

  // Entró con correo, Google o Apple: no hay un número confirmado.
  // A quien vende o reparte hay que poder llamarlo.
  if (!conTelefono) {
    return (
      <View style={e.bloque}>
        <Text style={T.destacado}>¿Tienes un puesto o repartes?</Text>
        <Text style={[T.apoyo, { marginTop: E.xs }]}>
          Para trabajar con la feria hay que entrar con tu teléfono. Cierra sesión
          y entra con tu número; después vuelve acá.
        </Text>
      </View>
    );
  }

  const listo = nombre.trim() && (tipo === 'feriante'
    ? puesto.trim() && elegidos.length > 0 && feriaId
    : vehiculo.trim());

  const enviar = async () => {
    setEnviando(true);
    try {
      const r = await api('POST', '/cliente/postular', {
        cuerpo: tipo === 'feriante'
          ? { tipo, nombre: nombre.trim(), puesto: puesto.trim(), rubros: elegidos, feriaId }
          : { tipo, nombre: nombre.trim(), vehiculo: vehiculo.trim() },
      });
      setSolicitud(r);
    } catch (err: any) {
      Alert.alert('No se pudo enviar', err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <View style={e.bloque}>
      <Text style={T.destacado}>¿Tienes un puesto o repartes?</Text>
      <Text style={[T.micro, { marginTop: 2, marginBottom: E.m }]}>
        Pide trabajar con la feria. La operación revisa cada solicitud.
      </Text>

      <View style={e.fila}>
        <Opcion texto="Tengo un puesto" activa={tipo === 'feriante'}
                onPress={() => setTipo('feriante')} />
        <Opcion texto="Reparto" activa={tipo === 'repartidor'}
                onPress={() => setTipo('repartidor')} />
      </View>

      {tipo ? (
        <View style={{ gap: E.m, marginTop: E.m }}>
          <Campo etiqueta="Tu nombre" value={nombre} onChangeText={setNombre}
                 placeholder="Nombre y apellido" />
          {tipo === 'feriante' ? (
            <>
              <View>
                <Text style={[T.micro, { marginBottom: E.xs }]}>En qué feria</Text>
                <View style={[e.fila, { flexWrap: 'wrap' }]}>
                  {ferias.map((f) => (
                    <Opcion
                      key={f.id}
                      texto={`${f.nombre.replace(/^Feria /, '')} · ${f.comuna}`}
                      activa={feriaId === f.id}
                      onPress={() => setFeriaId(f.id)}
                    />
                  ))}
                </View>
              </View>
              <Campo etiqueta="Tu puesto" value={puesto} onChangeText={setPuesto}
                     placeholder="Puesto 12, sector norte" />
              <View>
                <Text style={[T.micro, { marginBottom: E.xs }]}>Qué vendes</Text>
                <View style={[e.fila, { flexWrap: 'wrap' }]}>
                  {rubros.map((r) => (
                    <Opcion
                      key={r.id}
                      texto={r.nombre}
                      activa={elegidos.includes(r.id)}
                      onPress={() => setElegidos((a) =>
                        a.includes(r.id) ? a.filter((x) => x !== r.id) : [...a, r.id])}
                    />
                  ))}
                </View>
              </View>
            </>
          ) : (
            <Campo etiqueta="En qué repartes" value={vehiculo} onChangeText={setVehiculo}
                   placeholder="Moto, auto, bicicleta" />
          )}
          <Boton
            titulo={enviando ? 'ENVIANDO…' : 'ENVIAR SOLICITUD'}
            onPress={enviar}
            deshabilitado={!listo || enviando}
          />
        </View>
      ) : null}
    </View>
  );
}

function Opcion({ texto, activa, onPress }: {
  texto: string; activa: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: activa }}
      style={[e.opcion, activa && { backgroundColor: C.verde, borderColor: C.verde }]}
    >
      <Text style={[T.apoyo, { color: activa ? '#FFFFFF' : C.texto }]}>{texto}</Text>
    </Pressable>
  );
}

const e = StyleSheet.create({
  bloque: {
    backgroundColor: C.superficie, borderRadius: R.grande,
    borderWidth: 1, borderColor: C.borde, padding: E.l,
  },
  fila: { flexDirection: 'row', gap: E.s },
  opcion: {
    paddingVertical: E.s, paddingHorizontal: E.m, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, backgroundColor: C.superficie,
  },
});
