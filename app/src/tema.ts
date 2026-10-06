/**
 * Sistema de diseño.
 *
 * Los colores salen de muestrear el logotipo original, no de ojo.
 * El resto —espaciado, elevación, tipografía— es una escala cerrada:
 * si un valor no está acá, no se usa. Eso es lo que hace que la app
 * se vea de una sola pieza en vez de pantalla por pantalla.
 */

export const C = {
  // ---- Verde de la marca: botones y todo lo que es acción ----
  verde: '#146C54',
  verdeOscuro: '#0C5C44',
  /** Fondo tenue para zonas de marca (bienvenida, tarjetas de saldo). */
  verdeSuave: '#E4ECDC',

  /** El granate de la manzana del logotipo. */
  marca: '#8B2838',

  // ---- Cremas: splash, perfil, acentos cálidos ----
  crema: '#FCF4E4',
  cremaClara: '#FCF4EC',
  amarillo: '#B8860B',
  /** Amarillo pleno del splash. */
  amarilloVivo: '#FCD47C',
  rosa: '#F49CA4',
  /** Ámbar de las estrellas de calificación. */
  ambar: '#F4B424',

  // ---- Superficies ----
  fondo: '#F4F6F4',
  superficie: '#FFFFFF',
  superficieAlta: '#F0F2F0',
  borde: '#E4E7E4',
  /** Separador dentro de una misma superficie. */
  linea: '#EDEFED',

  texto: '#16211D',
  textoSuave: '#6B7670',

  // ---- Semánticos ----
  rojo: '#C23B3B',
  rojoSuave: '#FBEEEE',
  naranja: '#C2701B',
  naranjaSuave: '#FCF2E8',
  azul: '#3B7FBF',

  /** Color sólido para sombras; la opacidad va en cada nivel. */
  sombra: '#16211D',
} as const;

/**
 * Espaciado en múltiplos de 4.
 *
 * Tener pocos valores obliga a decidir jerarquía en vez de inventar
 * un número distinto cada vez.
 */
export const E = {
  xs: 4,
  s: 8,
  m: 12,
  l: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const;

export const R = {
  chico: 10,
  medio: 14,
  grande: 18,
  enorme: 24,
  pastilla: 999,
} as const;

/**
 * Elevación.
 *
 * Las tarjetas van planas con borde; la sombra se reserva para lo
 * que de verdad flota sobre el contenido. Sombra en todo es ruido:
 * cuando todo sobresale, nada sobresale.
 */
export const ELEV = {
  plano: {},
  flotante: {
    shadowColor: C.sombra,
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
} as const;

export const FUENTES = {
  // Un peso menos que antes: en negrita Fredoka se empasta y se ve
  // de juguete; en seminegrita se parece a la letra del logo.
  titulo: 'Fredoka_500Medium',
  tituloFuerte: 'Fredoka_600SemiBold',
  cuerpo: 'Nunito_400Regular',
  cuerpoFuerte: 'Nunito_700Bold',
} as const;

/** Las cifras se alinean en columna: dígitos de ancho fijo. */
const TABULAR = { fontVariant: ['tabular-nums' as const] };

export const T = {
  /** El monto de una oferta: lo único que se lee de reojo. */
  cifra: {
    fontFamily: FUENTES.tituloFuerte, fontSize: 44, color: C.texto,
    letterSpacing: -1, ...TABULAR,
  },
  cifraMedia: {
    fontFamily: FUENTES.tituloFuerte, fontSize: 24, color: C.texto,
    letterSpacing: -0.4, ...TABULAR,
  },
  cifraChica: {
    fontFamily: FUENTES.cuerpoFuerte, fontSize: 16, color: C.texto, ...TABULAR,
  },

  titulo: {
    fontFamily: FUENTES.tituloFuerte, fontSize: 26, color: C.texto, letterSpacing: -0.2,
  },
  encabezado: {
    fontFamily: FUENTES.titulo, fontSize: 18, color: C.texto,
  },

  cuerpo: {
    fontFamily: FUENTES.cuerpo, fontSize: 16, lineHeight: 23, color: C.texto,
  },
  destacado: {
    fontFamily: FUENTES.cuerpoFuerte, fontSize: 16, lineHeight: 23, color: C.texto,
  },
  apoyo: {
    fontFamily: FUENTES.cuerpo, fontSize: 14, lineHeight: 20, color: C.textoSuave,
  },
  micro: {
    fontFamily: FUENTES.cuerpo, fontSize: 12, lineHeight: 17, color: C.textoSuave,
  },
  /** Rótulo de sección. */
  seccion: {
    fontFamily: FUENTES.cuerpoFuerte, fontSize: 12, color: C.textoSuave,
    letterSpacing: 0.7, textTransform: 'uppercase' as const,
  },
} as const;

export const clp = (n: number | null | undefined): string => {
  if (n == null) return '—';
  // El signo va antes del peso: «-$6.000», no «$-6.000». Y sin el
  // cero negativo que devuelve Math.round(-0).
  const entero = Math.round(n) || 0;
  const signo = entero < 0 ? '-' : '';
  return signo + '$' + Math.abs(entero).toLocaleString('es-CL');
};
