import { consultarUno, type Fila } from '../db/index.ts';
import { CONFIG } from '../config.ts';

/**
 * Cuánto cuesta llevar un pedido, según la distancia.
 *
 * El repartidor cobra por viaje: una parte fija (salir de la feria),
 * una por kilómetro y una por cada puesto extra donde tiene que
 * pasar a retirar. El cliente paga de despacho lo mismo que gana el
 * repartidor, calculado ANTES de pagar con la dirección que dio. Así
 * el reparto no sale del margen de la feria, y nada sube después:
 * lo que el cliente pagó es lo que el repartidor cobra.
 *
 * La distancia es en línea recta, alargada por un factor porque las
 * calles no van derecho (y en los cerros menos). No es la ruta
 * exacta, pero es la misma para el cliente y para el repartidor, y
 * no depende de un servicio de mapas pagado.
 */
export type Punto = { lat: number; lng: number };

export function kmEnLineaRecta(a: Punto, b: Punto): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Los kilómetros que se cobran: por calle, con un decimal. */
export const kmPorCalle = (a: Punto, b: Punto): number =>
  Math.round(kmEnLineaRecta(a, b) * CONFIG.reparto.factorCalle * 10) / 10;

const redondear = (n: number) => Math.ceil(n / 100) * 100;

/** Lo que gana el repartidor por un viaje. */
export function tarifaReparto(km: number, puestos: number, r = CONFIG.reparto): number {
  const bruto = r.base + r.porKm * Math.max(0, km) + r.porPuestoExtra * Math.max(0, puestos - 1);
  return Math.max(r.minimo, redondear(bruto));
}

export const fueraDeZona = (km: number): boolean => km > CONFIG.reparto.maxKm;

/**
 * Lo que paga el cliente de despacho.
 *
 * Es la tarifa del repartidor. La única excepción es el envío gratis
 * por compra grande, y solo dentro de un radio corto: ahí la feria
 * absorbe un viaje barato a cambio de un carro más grande. Lejos,
 * el cliente paga el viaje aunque compre mucho.
 */
export function despachoParaCliente(totalProductos: number, km: number, rubros: number) {
  const tarifa = tarifaReparto(km, rubros);
  const gratis = totalProductos >= CONFIG.despacho.gratisDesde && km <= CONFIG.despacho.gratisHastaKm;
  return { despacho: gratis ? 0 : tarifa, tarifa, gratis };
}

/** Dónde queda la feria; sin coordenadas cargadas, el punto de la principal. */
export async function puntoDeFeria(feriaId: string): Promise<Punto> {
  const f = await consultarUno<Fila>('SELECT lat, lng FROM ferias WHERE id = ?', feriaId).catch(() => undefined);
  return Number.isFinite(f?.lat) && Number.isFinite(f?.lng)
    ? { lat: f!.lat, lng: f!.lng }
    : { lat: CONFIG.puntoFeria.lat, lng: CONFIG.puntoFeria.lng };
}
