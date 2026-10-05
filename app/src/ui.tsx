import React from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View,
  type StyleProp, type ViewStyle,
} from 'react-native';

import { C, E, ELEV, R, T } from './tema';
import { Manzana } from './Logotipo';
import { servidor } from './api';

// ============================================================
// Estructura de pantalla
// ============================================================

/**
 * El marco de cualquier pantalla con scroll.
 *
 * Centraliza el fondo, los márgenes y el encabezado para que
 * ninguna pantalla invente los suyos.
 */
export function Pantalla({
  titulo, subtitulo, accesorio, children, sinScroll,
}: {
  titulo?: string;
  subtitulo?: string;
  /** Control que va a la derecha del título. */
  accesorio?: React.ReactNode;
  children: React.ReactNode;
  sinScroll?: boolean;
}) {
  const contenido = (
    <>
      {titulo ? (
        <View style={e.encabezado}>
          <View style={{ flex: 1 }}>
            <Text style={T.titulo}>{titulo}</Text>
            {subtitulo ? <Text style={[T.apoyo, { marginTop: 2 }]}>{subtitulo}</Text> : null}
          </View>
          {accesorio}
        </View>
      ) : null}
      {children}
    </>
  );

  if (sinScroll) return <View style={[e.pantalla, e.relleno]}>{contenido}</View>;
  return (
    <ScrollView style={e.pantalla} contentContainerStyle={e.relleno}
                keyboardShouldPersistTaps="handled">
      {contenido}
    </ScrollView>
  );
}

/**
 * Un bloque de contenido agrupado: una sola superficie blanca con
 * filas separadas por una línea fina.
 *
 * Es la diferencia entre una lista que se lee de un vistazo y una
 * pila de tarjetas flotando, que obliga a saltar de una a otra.
 */
export function Seccion({
  titulo, accesorio, children, style,
}: {
  titulo?: string;
  accesorio?: React.ReactNode;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={{ marginBottom: E.xl }}>
      {titulo || accesorio ? (
        <View style={e.tituloSeccion}>
          {titulo ? <Text style={T.seccion}>{titulo}</Text> : <View />}
          {accesorio}
        </View>
      ) : null}
      <View style={[e.superficie, style]}>{children}</View>
    </View>
  );
}

/** Una fila dentro de una Sección. La última no lleva separador. */
export function Fila({
  children, onPress, ultima, style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  ultima?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const cuerpo = (
    <View style={[e.fila, !ultima && e.conLinea, style]}>{children}</View>
  );
  if (!onPress) return cuerpo;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.6 }}>
      {cuerpo}
    </Pressable>
  );
}

/**
 * Quién eres y cómo salir.
 *
 * Antes esto era una barra blanca con borde pegada arriba, que es
 * el lenguaje de la app vieja. Acá va suelta sobre el fondo, con la
 * inicial en un círculo, como en la app del cliente: la misma app
 * no puede verse de dos maneras según de qué lado del mostrador
 * esté quien la mira.
 */
export function Cabecera({
  nombre, subtitulo, accesorio, onSalir,
}: {
  nombre: string;
  subtitulo?: string;
  /** Control propio del rol, a la derecha del nombre. */
  accesorio?: React.ReactNode;
  onSalir: () => void;
}) {
  return (
    <View style={e.cabecera}>
      <View style={e.avatar}>
        <Text style={e.inicial}>{(nombre.trim() || '?').charAt(0).toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={T.encabezado} numberOfLines={1}>{nombre}</Text>
        {subtitulo ? <Text style={T.micro} numberOfLines={1}>{subtitulo}</Text> : null}
      </View>
      {accesorio}
      <Pressable
        onPress={onSalir}
        hitSlop={10}
        accessibilityRole="button"
        style={({ pressed }) => [e.salir, pressed && { opacity: 0.6 }]}
      >
        <Text style={[T.micro, { color: C.textoSuave, fontFamily: T.destacado.fontFamily }]}>
          Salir
        </Text>
      </Pressable>
    </View>
  );
}

/** Superficie suelta, para contenido que no es una lista. */
export function Tarjeta({
  children, style, tono,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  tono?: 'exito' | 'aviso' | 'alerta';
}) {
  const tonos = {
    exito: { backgroundColor: C.verdeSuave, borderColor: C.verde + '33' },
    aviso: { backgroundColor: C.naranjaSuave, borderColor: C.naranja + '33' },
    alerta: { backgroundColor: C.rojoSuave, borderColor: C.rojo + '33' },
  };
  return (
    <View style={[e.superficie, e.tarjeta, tono && tonos[tono], style]}>{children}</View>
  );
}

/** Barra que flota sobre el contenido: acá sí va sombra. */
export function Flotante({ children }: { children: React.ReactNode }) {
  return <View style={[e.flotante, ELEV.flotante]}>{children}</View>;
}

// ============================================================
// Controles
// ============================================================

type Variante = 'primario' | 'secundario' | 'atencion' | 'peligro';

export function Boton({
  titulo, subtitulo, onPress, variante = 'primario', grande, deshabilitado,
}: {
  titulo: string;
  subtitulo?: string;
  onPress: () => void;
  variante?: Variante;
  grande?: boolean;
  deshabilitado?: boolean;
}) {
  const estilos: Record<Variante, { fondo: string; texto: string; borde?: string }> = {
    primario: { fondo: C.verde, texto: '#FFFFFF' },
    atencion: { fondo: C.naranja, texto: '#FFFFFF' },
    peligro: { fondo: C.superficie, texto: C.rojo, borde: C.rojo + '44' },
    secundario: { fondo: C.superficie, texto: C.texto, borde: C.borde },
  };
  const v = estilos[variante];

  return (
    <Pressable
      onPress={onPress}
      disabled={deshabilitado}
      accessibilityRole="button"
      style={({ pressed }) => [
        e.boton,
        grande && e.botonGrande,
        {
          // Deshabilitado va en gris, no en color translúcido: un
          // color lavado se lee como «cargando», no como «todavía no».
          backgroundColor: deshabilitado ? C.superficieAlta : v.fondo,
          borderColor: deshabilitado ? C.borde : v.borde ?? 'transparent',
          borderWidth: deshabilitado || v.borde ? 1 : 0,
        },
        pressed && !deshabilitado && { opacity: 0.86, transform: [{ scale: 0.99 }] },
      ]}
    >
      <Text style={[
        grande ? T.titulo : T.encabezado,
        { color: deshabilitado ? C.textoSuave : v.texto },
      ]}>
        {titulo}
      </Text>
      {subtitulo ? (
        <Text style={[T.micro, {
          color: deshabilitado ? C.textoSuave
            : variante === 'primario' || variante === 'atencion'
              ? 'rgba(255,255,255,0.9)' : C.textoSuave,
          marginTop: 1,
        }]}>
          {subtitulo}
        </Text>
      ) : null}
    </Pressable>
  );
}

type Tono = 'neutro' | 'exito' | 'aviso' | 'alerta' | 'info' | 'marca';

const TONOS: Record<Tono, string> = {
  neutro: C.textoSuave,
  exito: C.verdeOscuro,
  aviso: C.amarillo,
  alerta: C.rojo,
  info: C.azul,
  marca: C.marca,
};

export function Chip({ texto, tono = 'neutro' }: { texto: string; tono?: Tono }) {
  const color = TONOS[tono];
  return (
    <View style={[e.chip, { backgroundColor: color + '16' }]}>
      <Text style={[T.micro, { color, fontFamily: T.seccion.fontFamily, letterSpacing: 0.3 }]}>
        {texto}
      </Text>
    </View>
  );
}

export function Aviso({ texto, tono = 'alerta' }: { texto: string; tono?: Tono }) {
  const color = TONOS[tono];
  return (
    <View style={[e.aviso, { backgroundColor: color + '12', borderColor: color + '2E' }]}>
      <Text style={[T.apoyo, { color }]}>{texto}</Text>
    </View>
  );
}

/** Rótulo de un dato con su valor, para filas de resumen. */
export function Dato({
  etiqueta, valor, pie, tono,
}: {
  etiqueta: string;
  valor: string;
  pie?: string;
  tono?: Tono;
}) {
  return (
    <View style={e.dato}>
      <Text style={T.seccion}>{etiqueta}</Text>
      <Text style={[T.cifraMedia, { marginTop: 4 }, tono && { color: TONOS[tono] }]}>
        {valor}
      </Text>
      {pie ? <Text style={T.micro}>{pie}</Text> : null}
    </View>
  );
}

/** Barra de tiempo restante. Cambia de color al acercarse al final. */
export function BarraTiempo({ restante, total }: { restante: number; total: number }) {
  const razon = Math.max(0, Math.min(1, restante / total));
  const color = razon > 0.5 ? C.verde : razon > 0.2 ? C.amarillo : C.rojo;
  return (
    <View>
      <View style={e.barraFondo}>
        <View style={[e.barraRelleno, { width: `${razon * 100}%`, backgroundColor: color }]} />
      </View>
      <Text style={[T.apoyo, { textAlign: 'center', marginTop: E.s, color }]}>
        {restante > 0 ? `${restante} s para contestar` : 'venciendo…'}
      </Text>
    </View>
  );
}

export function Cargando() {
  return (
    <View style={e.centrado}>
      <ActivityIndicator color={C.verde} size="large" />
    </View>
  );
}

/**
 * No se pudo cargar, con salida.
 *
 * Un error sin botón de reintentar obliga a cerrar la app: en la
 * feria la señal se cae sola y volver a pedir suele alcanzar.
 */
export function NoCargo({ error, onReintentar }: { error: string; onReintentar: () => void }) {
  // «Network request failed» no le dice nada a nadie. Lo que hace
  // falta saber es a qué servidor no se pudo llegar: casi siempre
  // es el teléfono en otra red, y con la dirección a la vista se
  // descubre en diez segundos en vez de en media hora.
  const deRed = /network|failed to fetch|timeout|abort/i.test(error);
  return (
    <View style={e.vacio}>
      <Manzana tamano={56} />
      <Text style={[T.destacado, { marginTop: E.m, textAlign: 'center' }]}>
        {deRed ? 'Sin conexión con el servidor' : 'No se pudo cargar'}
      </Text>
      <Text style={[T.apoyo, { textAlign: 'center', marginTop: 2 }]}>
        {deRed
          ? 'Revisa que estés en la misma red que el servidor de la feria.'
          : error}
      </Text>
      <Text style={[T.micro, { textAlign: 'center', marginTop: E.s }]}>{servidor()}</Text>
      <View style={{ marginTop: E.l, alignSelf: 'stretch' }}>
        <Boton titulo="REINTENTAR" onPress={onReintentar} />
      </View>
    </View>
  );
}

export function Vacio({ texto }: { texto: string }) {
  return (
    <View style={e.vacio}>
      {/* Una manzana apagada: llena el hueco sin gritar y mantiene
          la marca presente donde no hay nada que mostrar. */}
      <View style={{ opacity: 0.16, marginBottom: E.m }}>
        <Manzana tamano={52} />
      </View>
      <Text style={[T.apoyo, { textAlign: 'center' }]}>{texto}</Text>
    </View>
  );
}

/** Estado de un pedido o viaje, traducido a tono. */
export const tonoEstado = (estado: string): Tono => {
  switch (estado) {
    case 'PENDIENTE_PAGO': return 'neutro';
    case 'OFERTANDO': case 'DESPACHANDO': case 'BUSCANDO': return 'aviso';
    case 'ACEPTADO': case 'ASIGNADO': case 'EN_PREPARACION': return 'info';
    case 'AUTOGESTION': return 'marca';
    case 'LISTO': case 'LISTO_PARA_RETIRO': case 'RETIRANDO':
    case 'EN_RUTA': case 'RETIRADO': case 'ENTREGADO': return 'exito';
    case 'EXPIRADO': case 'CANCELADO': return 'alerta';
    default: return 'neutro';
  }
};

const e = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: 'transparent' },
  relleno: { padding: E.l, paddingBottom: E.xxxl },
  encabezado: {
    flexDirection: 'row', alignItems: 'flex-start',
    gap: E.m, marginBottom: E.xl,
  },

  cabecera: {
    flexDirection: 'row', alignItems: 'center', gap: E.m,
    paddingHorizontal: E.l, paddingVertical: E.m,
  },
  avatar: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: C.verdeSuave,
    alignItems: 'center', justifyContent: 'center',
  },
  inicial: { fontFamily: T.destacado.fontFamily, color: C.verdeOscuro, fontSize: 17 },
  salir: {
    borderRadius: R.pastilla, borderWidth: 1, borderColor: C.borde,
    backgroundColor: C.superficie,
    paddingHorizontal: E.m, paddingVertical: 6,
    userSelect: 'none',
  },

  superficie: {
    backgroundColor: C.superficie,
    borderRadius: R.grande,
    borderWidth: 1,
    borderColor: C.borde,
    overflow: 'hidden',
  },
  tarjeta: { padding: E.l },
  tituloSeccion: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: E.s, paddingHorizontal: E.xs,
  },
  fila: { paddingHorizontal: E.l, paddingVertical: E.m },
  conLinea: { borderBottomWidth: 1, borderBottomColor: C.linea },

  flotante: {
    backgroundColor: C.superficie,
    borderRadius: R.enorme,
    borderWidth: 1,
    borderColor: C.borde,
    padding: E.m,
    gap: E.s,
  },

  boton: {
    minHeight: 52,
    borderRadius: R.grande,
    paddingVertical: E.m,
    paddingHorizontal: E.xl,
    alignItems: 'center',
    justifyContent: 'center',
    // Un botón no es texto para seleccionar: sin esto, mantener
    // apretado empieza a seleccionar la etiqueta.
    userSelect: 'none',
  },
  /** Para aceptar o rechazar: tiene que ser acertable sin mirar. */
  botonGrande: { minHeight: 76, borderRadius: R.enorme },

  chip: {
    paddingHorizontal: E.s, paddingVertical: 3,
    borderRadius: R.pastilla, alignSelf: 'flex-start',
  },
  aviso: {
    borderRadius: R.medio, borderWidth: 1,
    paddingHorizontal: E.m, paddingVertical: E.s + 2,
    marginBottom: E.m,
  },
  dato: {
    flexGrow: 1, flexBasis: '45%',
    backgroundColor: C.superficie,
    borderRadius: R.grande, borderWidth: 1, borderColor: C.borde,
    padding: E.m + 2,
  },

  barraFondo: {
    height: 10, backgroundColor: C.superficieAlta,
    borderRadius: R.pastilla, overflow: 'hidden',
  },
  barraRelleno: { height: '100%', borderRadius: R.pastilla },

  centrado: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: E.xxxl },
  vacio: { padding: E.xxl, alignItems: 'center' },
});
