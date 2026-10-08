import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '../api';
import { C, E, FUENTES, R, T } from '../tema';
import { Boton } from '../ui';
import { Icono } from '../iconos';

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
<body><div id="mapa"></div><div id="mira"><svg width="40" height="40" viewBox="0 0 24 24"><path d="M12 22s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.700-7 12-7 12z" fill="#8B2838" stroke="#fff" stroke-width="1.2"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg></div>
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

/**
 * El mapa chico que se ve en la pantalla de pago: no se mueve, solo
 * muestra dónde se va a entregar. Al tocarlo se abre el mapa grande.
 */
const paginaDeVista = (lat: number, lng: number, exacto: boolean) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body, #mapa { height: 100%; margin: 0; background: #E4ECDC; }
  .leaflet-control-attribution { font-size: 9px; }
  #mira { position: absolute; left: 50%; top: 50%; margin: -38px 0 0 -19px; z-index: 1000;
          pointer-events: none; opacity: ${exacto ? 1 : 0.75}; }
</style></head>
<body><div id="mapa"></div><div id="mira"><svg width="38" height="38" viewBox="0 0 24 24"><path d="M12 22s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12z" fill="${exacto ? '#8B2838' : '#C2701B'}" stroke="#fff" stroke-width="1.2"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var mapa = L.map('mapa', { zoomControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false }).setView([${lat}, ${lng}], ${exacto ? 17 : 15});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapa);
  ${exacto ? '' : `L.circle([${lat}, ${lng}], { radius: 220, color: '#C2701B', weight: 1, fillOpacity: 0.12 }).addTo(mapa);`}
</script></body></html>`;

export function MapaVista({ lat, lng, exacto }: { lat: number; lng: number; exacto: boolean }) {
  const html = paginaDeVista(lat, lng, exacto);
  if (WebView) {
    return (
      <View style={e.mapaVista} pointerEvents="none">
        <WebView originWhitelist={['*']} source={{ html }} scrollEnabled={false} style={{ flex: 1 }} />
      </View>
    );
  }
  // En la versión web de la app no hay WebView, pero sí un marco.
  return (
    <View style={e.mapaVista} pointerEvents="none">
      {React.createElement('iframe', {
        srcDoc: html, title: 'Mapa del punto de entrega',
        style: { border: 0, width: '100%', height: '100%' },
      })}
    </View>
  );
}

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

  // Mientras no haya un punto marcado, el mapa muestra más o menos
  // dónde queda la dirección escrita: así se ve al tiro si el
  // buscador la entendió o la mandó a otra comuna. Se espera a que
  // la persona deje de escribir antes de preguntar.
  const [aprox, setAprox] = useState<{ lat: number; lng: number } | null>(null);
  const [ubicando, setUbicando] = useState(false);
  useEffect(() => {
    const texto = direccion.trim();
    setAprox(null);
    if (texto.length < 6) return;
    let vigente = true;
    const t = setTimeout(async () => {
      setUbicando(true);
      try {
        const q = `direccion=${encodeURIComponent(texto)}&feria=${encodeURIComponent(feriaId)}`;
        const r = await api('GET', `/cliente/ubicar?${q}`);
        if (vigente && r.encontrada) setAprox({ lat: r.lat, lng: r.lng });
      } catch { /* sin mapa aproximado: queda el aviso de marcar el punto */ } finally {
        if (vigente) setUbicando(false);
      }
    }, 1400);
    return () => { vigente = false; clearTimeout(t); };
  }, [direccion, feriaId]);

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

  const marcado = !!punto && !desactualizado;
  const vista = marcado ? { lat: punto!.lat, lng: punto!.lng } : aprox;
  const puedeAbrirMapa = !!WebView;

  return (
    <View style={e.caja}>
      {/* El mapa va arriba y a la vista: es la forma más rápida de
          confirmar que el pedido va a llegar donde uno cree. */}
      <Pressable
        onPress={() => { if (puedeAbrirMapa) { setEscrito(''); void abrirMapa(); } }}
        disabled={!puedeAbrirMapa || abriendo}
        accessibilityRole="button"
        accessibilityLabel="Ver o ajustar el punto de entrega en el mapa"
      >
        {vista ? (
          <MapaVista lat={vista.lat} lng={vista.lng} exacto={marcado} />
        ) : (
          <View style={[e.mapaVista, e.mapaVacio]}>
            <Icono nombre="pin" tamano={30} color={C.textoSuave} />
            <Text style={[T.apoyo, { textAlign: 'center', marginTop: E.xs }]}>
              {ubicando ? 'Buscando la dirección…'
                : direccion.trim().length < 6 ? 'Escribe tu dirección y aparece el mapa'
                : 'No encontramos esa dirección en el mapa. Márcala tú.'}
            </Text>
          </View>
        )}
        <View style={[e.insignia, { backgroundColor: marcado ? C.verde : vista ? C.naranja : C.textoSuave }]}>
          {marcado ? <Icono nombre="listo" tamano={13} color="#FFFFFF" grosor={2.6} /> : null}
          <Text style={e.insigniaTexto}>
            {marcado
              ? `Punto exacto${punto!.precisionM ? ` · ±${Math.round(punto!.precisionM)} m` : ''}`
              : vista ? 'Ubicación aproximada' : 'Sin punto marcado'}
          </Text>
        </View>
      </Pressable>

      <Text style={[T.micro, { marginTop: E.s }]}>
        {marcado
          ? 'El repartidor llega directo a este punto.'
          : desactualizado
            ? 'Cambiaste la dirección: marca el punto de nuevo.'
            : vista
              ? 'Así ubicamos tu dirección. Marca el punto exacto para que el repartidor llegue a tu puerta.'
              : 'Marca el punto exacto para que el repartidor llegue a tu puerta.'}
      </Text>

      <View style={e.acciones}>
        <View style={{ flex: 1 }}>
          <Boton
            titulo={buscando ? 'Ubicando…' : 'Mi ubicación'}
            variante={marcado ? 'secundario' : 'primario'}
            onPress={usarGps}
            deshabilitado={buscando}
          />
        </View>
        {puedeAbrirMapa ? (
          <View style={{ flex: 1 }}>
            <Boton
              titulo={abriendo ? 'Abriendo…' : marcado ? 'Ajustar en mapa' : 'Elegir en mapa'}
              variante="secundario"
              onPress={() => { setEscrito(''); void abrirMapa(); }}
              deshabilitado={abriendo}
            />
          </View>
        ) : null}
      </View>

      {WebView && inicio ? (
        <Modal visible animationType="slide" onRequestClose={() => setInicio(null)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: C.fondo }}>
            <View style={{ padding: E.l, paddingBottom: E.s }}>
              <Text style={T.encabezado}>Mueve el mapa hasta la puerta</Text>
              <Text style={T.apoyo}>
                El pin queda fijo al centro.
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
  caja: {},
  mapaVista: {
    height: 170, borderRadius: R.medio, overflow: 'hidden',
    borderWidth: 1, borderColor: C.borde, backgroundColor: C.verdeSuave,
  },
  mapaVacio: { alignItems: 'center', justifyContent: 'center', padding: E.l, backgroundColor: C.superficieAlta },
  insignia: {
    position: 'absolute', left: E.s, top: E.s, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: E.s, paddingVertical: 4, borderRadius: R.pastilla,
  },
  insigniaTexto: { color: '#FFFFFF', fontFamily: FUENTES.cuerpoFuerte, fontSize: 12 },
  acciones: { flexDirection: 'row', gap: E.s, marginTop: E.s },
});
