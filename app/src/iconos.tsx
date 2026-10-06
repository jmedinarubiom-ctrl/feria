import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { C } from './tema';

/**
 * Los íconos de la app.
 *
 * Antes eran emojis: cada teléfono los dibuja a su manera, con sus
 * propios colores, y al lado de la tipografía de la marca se ven
 * pegados encima. Estos son de línea, todos del mismo grosor y con
 * las puntas redondeadas, como la letra del logo.
 */
export type NombreIcono =
  | 'inicio' | 'feria' | 'pedidos' | 'perfil' | 'canasto' | 'buscar'
  | 'atras' | 'adelante' | 'telefono' | 'tarjeta' | 'pin' | 'listo'
  | 'verduras' | 'frutas' | 'pescado' | 'abarrotes' | 'quesos';

const TRAZOS: Record<NombreIcono, React.ReactNode> = {
  inicio: <Path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z" />,
  feria: (
    <>
      <Path d="M3 9l1.6-5h14.8L21 9" />
      <Path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
      <Path d="M5 12.5V20h14v-7.5" />
      <Path d="M10 20v-4.5h4V20" />
    </>
  ),
  pedidos: (
    <>
      <Path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <Path d="M9.5 8h5M9.5 12h5" />
    </>
  ),
  perfil: (
    <>
      <Circle cx="12" cy="8" r="4" />
      <Path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  canasto: (
    <>
      <Path d="M3.5 10h17l-1.7 9.3a1.5 1.5 0 0 1-1.5 1.2H6.7a1.5 1.5 0 0 1-1.5-1.2z" />
      <Path d="M8 10l4-6.5 4 6.5" />
      <Path d="M9.5 14v3M14.5 14v3" />
    </>
  ),
  buscar: (
    <>
      <Circle cx="11" cy="11" r="7" />
      <Path d="M20.5 20.5 16 16" />
    </>
  ),
  atras: <Path d="M15 5l-7 7 7 7" />,
  adelante: <Path d="M9 5l7 7-7 7" />,
  telefono: <Path d="M21 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.1 4.2 2 2 0 0 1 3.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />,
  tarjeta: (
    <>
      <Rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <Path d="M2.5 10h19M6.5 15h3" />
    </>
  ),
  pin: (
    <>
      <Path d="M12 21.5s-7-6.3-7-11.5a7 7 0 0 1 14 0c0 5.2-7 11.5-7 11.5z" />
      <Circle cx="12" cy="10" r="2.5" />
    </>
  ),
  listo: <Path d="M5 12.5l4.5 4.5L19 7.5" />,
  verduras: (
    <>
      <Path d="M4.5 19.5C4.5 10 10 4.5 19.5 4.5 19.5 14 14 19.5 4.5 19.5z" />
      <Path d="M4.5 19.5 13.5 10.5" />
    </>
  ),
  frutas: (
    <>
      <Path d="M12 8c-1.5-1.5-4-2-5.8-.6C4 9 4 12.5 5.2 15.6 6.2 18.2 8 21 10 21c.8 0 1.2-.5 2-.5s1.2.5 2 .5c2 0 3.8-2.8 4.8-5.4C20 12.5 20 9 17.8 7.4 16 6 13.5 6.5 12 8z" />
      <Path d="M12 8c0-2 .8-3.5 2.5-4.5" />
    </>
  ),
  pescado: (
    <>
      <Path d="M7.5 12c2-3.5 5-5.5 8.2-5.5 2.7 0 4.8 2.2 6.3 5.5-1.5 3.3-3.6 5.5-6.3 5.5-3.2 0-6.2-2-8.2-5.5z" />
      <Path d="M7.5 12 2.5 8v8z" />
      <Circle cx="17" cy="11" r="0.6" />
    </>
  ),
  abarrotes: <Path d="M12 3c3.3 0 6.5 6 6.5 10.5a6.5 6.5 0 0 1-13 0C5.5 9 8.7 3 12 3z" />,
  quesos: (
    <>
      <Path d="M3 18.5v-7L14.5 5c3.3.6 5.6 3 6.5 6.5v7z" />
      <Path d="M3 11.5h18" />
      <Circle cx="8.5" cy="15" r="1.2" />
      <Circle cx="15.5" cy="15.5" r="0.9" />
    </>
  ),
};

export function Icono({
  nombre, tamano = 22, color = C.texto, grosor = 1.9,
}: { nombre: NombreIcono; tamano?: number; color?: string; grosor?: number }) {
  return (
    <Svg
      width={tamano} height={tamano} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={grosor} strokeLinecap="round" strokeLinejoin="round"
    >
      {TRAZOS[nombre]}
    </Svg>
  );
}

/** El ícono y el color de cada rubro del catálogo. */
const RUBROS: Record<string, { icono: NombreIcono; color: string; fondo: string }> = {
  verduras: { icono: 'verduras', color: C.verde, fondo: C.verdeSuave },
  frutas: { icono: 'frutas', color: C.marca, fondo: '#F8E7EA' },
  pescado: { icono: 'pescado', color: C.azul, fondo: '#E6F0F8' },
  abarrotes: { icono: 'abarrotes', color: C.naranja, fondo: C.naranjaSuave },
  quesos: { icono: 'quesos', color: C.amarillo, fondo: '#FBF3DC' },
};

export const iconoDeRubro = (rubroId: string) =>
  RUBROS[rubroId] ?? { icono: 'canasto' as NombreIcono, color: C.verde, fondo: C.verdeSuave };
