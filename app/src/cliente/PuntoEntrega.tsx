import React, { useRef, useState } from 'react';
import { Alert, Modal, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '../api';
import { C, E, FUENTES, R, T } from '../tema';
import { Boton } from '../ui';

/**
 * El punto exacto donde se entrega.
 *
 * La dirección escrita le sirve al repartidor para tocar el timbre;
 * para LLEGAR sirve un punto en el mapa. En Valparaíso una calle
 * puede subir tres cerros, y «Subida Ecuador 123» ubicada por un
 * buscador cae a cuadras de la casa. Acá el cliente marca dónde
 * está, con el GPS del teléfono, y si quiere lo afina moviendo el
 * mapa. Ese punto viaja con el pedido y es al que navega el
 * repartidor.
 */
export type Punto = {
  lat: number;
  lng: number;
  /** Margen de error del GPS, en metros. Sin dato si lo movió a mano. */
  precisionM?: number;
  /** La dirección que estaba escrita cuando se marcó. */
  direccion: string;
};

// El mapa va en un WebView, que no existe en la versión web de la
// app: ahí queda solo el botón del GPS.
const WebView = Platform.OS !== 'web'
  ? (require('react-native-webview') as typeof import('react-native-webview')).WebView
  : null;

/** Un mapa de OpenStreetMap con una mira fija al centro: se mueve el mapa, no el pin. */
const paginaDelMapa = (lat: number, lng: number) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body, #mapa { height: 100%; margin: 0; }
  #mira { position: absolute; left: 50%; top: 50%; width: 36px; height: 36px;
          margin: -36px 0 0 -18px; z-index: 1000; pointer-events: none; font-size: 36px;
          line-height: 36px; text-align: center; }
</style></head>
<body><div id="mapa"></div><div id="mira">📍</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var mapa = L.map('mapa', { zoomControl: true }).setView([${lat}, ${lng}], 18);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(mapa);
  function avisar() {
    var c = mapa.getCenter();
    window.ReactNativeWebView.postMessage(JSON.stringify({ lat: c.lat, lng: c.lng }));
  }
  mapa.on('moveend', avisar);
  avisar();
</script></body></html>`;

export default function PuntoEntrega({ direccion, feriaId, punto, onCambio }: {
  direccion: string;
  /** Para abrir el mapa en la comuna de la feria elegida. */
  feriaId: string;
  punto: Punto | null;
  onCambio: (p: Punto | null) => void;
}) {
  const [buscando, setBuscando] = useState(false);
  const [abriendo, setAbriendo] = useState(false);
  /** Dónde parte el mapa. `null` = cerrado. */
  const [inicio, setInicio] = useState<{ lat: number; lng: number; encontrada?: boolean } | null>(null);
  const centro = useRef<{ lat: number; lng: number } | null>(null);
  const mapa = useRef<any>(null);
  const [escrito, setEscrito] = useState('');
  const [yendo, setYendo] = useState(false);

  /**
   * Lleva el mapa a lo que se escribió: unas coordenadas o una
   * dirección. El punto no queda marcado todavía: el mapa se mueve
   * ahí y la persona confirma (o lo corrige) con el pin.
   */
  const irA = async () => {
    const texto = escrito.trim();
    if (!texto) return;
    let destino = leerCoordenadas(texto);
    if (!destino) {
      setYendo(true);
      try {
        const q = `direccion=${encodeURIComponent(texto)}&feria=${encodeURIComponent(feriaId)}`;
        const r = await api('GET', `/cliente/ubicar?${q}`);
        if (r.encontrada) destino = { lat: r.lat, lng: r.lng };
      } catch { /* se avisa abajo */ } finally {
        setYendo(false);
      }
    }
    if (!destino) {
      Alert.alert('No lo encontramos',
        'Prueba con la calle y el número, o escribe las coordenadas, por ejemplo: -33.0472, -71.6127');
      return;
    }
    mapa.current?.injectJavaScript(
      `mapa.setView([${destino.lat}, ${destino.lng}], 18); true;`);
  };

  // Marcó el punto y después escribió otra dirección: ese punto ya
  // no es de fiar.
  const desactualizado = !!punto && punto.direccion.trim() !== direccion.trim();

  const usarGps = async () => {
    setBuscando(true);
    try {
      const permiso = await Location.requestForegroundPermissionsAsync();
      if (permiso.status !== 'granted') {
        Alert.alert('Sin permiso de ubicación',
          'Para marcar el punto necesitamos tu ubicación. Puedes activarla en los ajustes del teléfono.');
        return;
      }
      const { coords } = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      onCambio({
        lat: coords.latitude, lng: coords.longitude,
        precisionM: coords.accuracy ?? undefined, direccion,
      });
    } catch {
      Alert.alert('No pudimos ubicarte',
        'Revisa que el GPS esté encendido y prueba de nuevo, mejor al aire libre o cerca de una ventana.');
    } finally {
      setBuscando(false);
    }
  };

  /**
   * Abre el mapa para elegir o ver el punto.
   *
   * No hace falta estar en el lugar: se puede pedir para la casa de
   * otra persona. Si ya hay un punto marcado, el mapa parte ahí; si
   * no, cerca de la dirección escrita.
   */
  const abrirMapa = async () => {
    centro.current = null;
    if (punto && !desactualizado) return setInicio({ lat: punto.lat, lng: punto.lng });
    setAbriendo(true);
    try {
      const q = `direccion=${encodeURIComponent(direccion)}&feria=${encodeURIComponent(feriaId)}`;
      setInicio(await api('GET', `/cliente/ubicar?${q}`));
    } catch {
      // Sin respuesta del servidor igual se abre, en el centro.
      setInicio({ lat: -33.0472, lng: -71.6127, encontrada: false });
    } finally {
      setAbriendo(false);
    }
  };

  return (
    <View style={e.caja}>
      <Text style={T.micro}>PUNTO EXACTO DE ENTREGA</Text>
      {punto && !desactualizado ? (
        <Text style={[T.destacado, { marginTop: 2, color: C.verdeOscuro }]}>
          Punto marcado ✓
          <Text style={T.apoyo}>
            {punto.precisionM ? `  ±${Math.round(punto.precisionM)} m` : '  ajustado en el mapa'}
          </Text>
        </Text>
      ) : (
        <Text style={[T.apoyo, { marginTop: 2 }]}>
          {desactualizado
            ? 'Cambiaste la dirección: marca el punto de nuevo.'
            : 'Marca dónde entregamos, para que el repartidor llegue directo. '
              + 'Con tu ubicación si estás en el lugar, o eligiéndolo en el mapa.'}
        </Text>
      )}

      <View style={{ marginTop: E.s, gap: E.s }}>
        <Boton
          titulo={buscando ? 'UBICANDO…' : punto && !desactualizado
            ? 'Volver a marcar con mi ubicación' : 'USAR MI UBICACIÓN ACTUAL'}
          variante={punto && !desactualizado ? 'secundario' : 'primario'}
          onPress={usarGps}
          deshabilitado={buscando}
        />
        {WebView ? (
          <Boton
            titulo={abriendo ? 'ABRIENDO EL MAPA…'
              : punto && !desactualizado ? 'Ver o cambiar en el mapa' : 'Elegir otro punto en el mapa'}
            variante="secundario"
            onPress={() => { setEscrito(''); void abrirMapa(); }}
            deshabilitado={abriendo}
          />
        ) : null}
      </View>

      {WebView && inicio ? (
        <Modal visible animationType="slide" onRequestClose={() => setInicio(null)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: C.fondo }}>
            <View style={{ padding: E.l, paddingBottom: E.s }}>
              <Text style={T.encabezado}>Mueve el mapa hasta la puerta</Text>
              <Text style={T.apoyo}>
                El pin 📍 queda fijo al centro.
                {inicio.encontrada === false
                  ? ' No encontramos la dirección escrita: búscala moviendo y acercando el mapa.'
                  : ''}
              </Text>
            </View>
            <View style={e.buscador}>
              <TextInput
                style={e.campoBusqueda}
                value={escrito}
                onChangeText={setEscrito}
                placeholder="Escribe una dirección o coordenadas"
                placeholderTextColor={C.textoSuave}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={irA}
              />
              <View style={{ width: 84 }}>
                <Boton titulo={yendo ? '…' : 'Ir'} onPress={irA}
                       deshabilitado={yendo || !escrito.trim()} />
              </View>
            </View>
            <WebView
              ref={mapa}
              originWhitelist={['*']}
              source={{ html: paginaDelMapa(inicio.lat, inicio.lng) }}
              onMessage={(ev) => {
                try {
                  const c = JSON.parse(ev.nativeEvent.data);
                  if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) centro.current = c;
                } catch { /* un mensaje que no era nuestro */ }
              }}
              style={{ flex: 1 }}
            />
            <View style={{ padding: E.l, gap: E.s }}>
              <Boton
                titulo="ESTE ES EL PUNTO"
                onPress={() => {
                  if (centro.current) {
                    // Movido a mano: ya no aplica el margen del GPS.
                    onCambio({ lat: centro.current.lat, lng: centro.current.lng, direccion });
                  }
                  setInicio(null);
                }}
              />
              <Boton titulo="Cancelar" variante="secundario" onPress={() => setInicio(null)} />
            </View>
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}

/**
 * Lee unas coordenadas escritas a mano.
 *
 * Acepta lo que la gente copia de otros lados: «-33.0472, -71.6127»,
 * con espacios o punto y coma, y también un enlace de Google Maps,
 * que las trae después de una arroba. Devuelve null si no hay dos
 * números con decimales que parezcan latitud y longitud.
 */
export function leerCoordenadas(texto: string): { lat: number; lng: number } | null {
  const m = /(-?\d{1,2}[.,]\d{3,})\s*[,; ]\s*(-?\d{1,3}[.,]\d{3,})/.exec(texto);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.'));
  const lng = Number(m[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
}

/** El punto, solo si sigue correspondiendo a la dirección escrita. */
export const puntoVigente = (punto: Punto | null | undefined, direccion: string): Punto | null =>
  punto && punto.direccion.trim() === direccion.trim() ? punto : null;

const e = StyleSheet.create({
  buscador: {
    flexDirection: 'row', alignItems: 'center', gap: E.s,
    paddingHorizontal: E.l, paddingBottom: E.s,
  },
  campoBusqueda: {
    flex: 1, backgroundColor: C.superficie, borderWidth: 1, borderColor: C.borde,
    borderRadius: R.medio, paddingHorizontal: E.m, paddingVertical: E.m,
    fontFamily: FUENTES.cuerpo, fontSize: 15, color: C.texto,
  },
  caja: {
    backgroundColor: C.fondo, borderRadius: R.medio,
    borderWidth: 1, borderColor: C.borde, padding: E.m,
  },
});
