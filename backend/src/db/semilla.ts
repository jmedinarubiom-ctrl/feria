import { ejecutar, consultarUno, type Fila } from './index.ts';

/**
 * Datos de arranque: Feria Av. Argentina, Valparaíso.
 * Precios en CLP. `precio_venta` es lo que paga el cliente,
 * `precio_costo` lo que se le paga al feriante en la tarde.
 */

const RUBROS = [
  ['verduras', 'Verduras'],
  ['frutas', 'Frutas'],
  ['pescado', 'Pescados y mariscos'],
  ['abarrotes', 'Abarrotes y huevos'],
];

const PRODUCTOS: Array<[string, string, string, string, number, number]> = [
  // id, rubro, nombre, formato, venta, costo
  ['p-tomate',    'verduras', 'Tomate',            'Malla 1 kg aprox.',   2200, 1500],
  ['p-papa',      'verduras', 'Papa',              'Saco 2 kg',           3200, 2200],
  ['p-cebolla',   'verduras', 'Cebolla',           'Malla 1 kg',          1900, 1200],
  ['p-lechuga',   'verduras', 'Lechuga costina',   'Unidad',              1200,  800],
  ['p-zanahoria', 'verduras', 'Zanahoria',         'Malla 1 kg',          1600, 1000],
  ['p-zapallo',   'verduras', 'Zapallo camote',    'Trozo 1 kg aprox.',   2400, 1600],
  ['p-palta',     'frutas',   'Palta Hass',        'Malla 1 kg aprox.',   5900, 4200],
  ['p-platano',   'frutas',   'Plátano',           'Kilo',                1800, 1200],
  ['p-manzana',   'frutas',   'Manzana fuji',      'Kilo',                2100, 1400],
  ['p-naranja',   'frutas',   'Naranja de jugo',   'Malla 2 kg',          3400, 2400],
  ['p-frutilla',  'frutas',   'Frutilla',          'Bandeja 500 g',       3200, 2300],
  ['p-merluza',   'pescado',  'Merluza',           'Kilo, limpia',        6500, 4800],
  ['p-reineta',   'pescado',  'Reineta',           'Kilo, filete',        8900, 6800],
  ['p-choritos',  'pescado',  'Choritos',          'Kilo',                4200, 3000],
  ['p-huevos',    'abarrotes','Huevos de campo',   'Bandeja 12',          3900, 2900],
  ['p-aceitunas', 'abarrotes','Aceitunas negras',  'Bolsa 500 g',         2800, 2000],
];

const FERIA = 'feria-av-argentina';

// Coordenadas aproximadas a lo largo de Av. Argentina, Valparaíso.
const FERIANTES: Array<[string, string, string, string, string[], number, number]> = [
  ['f-jose',   'José Sandoval',    'Puesto 12, sector norte',  '+56911111111', ['verduras'],              -33.0472, -71.6127],
  ['f-ana',    'Ana Poblete',      'Puesto 27, sector norte',  '+56922222222', ['verduras', 'frutas'],    -33.0475, -71.6131],
  ['f-carmen', 'Carmen Vidal',     'Puesto 41, sector centro', '+56933333333', ['frutas'],                -33.0481, -71.6136],
  ['f-luis',   'Luis Ovalle',      'Puesto 55, sector centro', '+56944444444', ['verduras'],              -33.0486, -71.6140],
  ['f-marta',  'Marta Riquelme',   'Puesto 63, sector centro', '+56955555555', ['frutas', 'abarrotes'],   -33.0490, -71.6144],
  ['f-pedro',  'Pedro Cáceres',    'Puesto 78, sector sur',    '+56966666666', ['pescado'],               -33.0495, -71.6149],
  ['f-rosa',   'Rosa Millán',      'Puesto 84, sector sur',    '+56977777777', ['pescado', 'abarrotes'],  -33.0498, -71.6152],
  ['f-hector', 'Héctor Fuentes',   'Puesto 91, sector sur',    '+56988888888', ['abarrotes'],             -33.0501, -71.6155],
];

const REPARTIDORES: Array<[string, string, string, string]> = [
  ['r-diego',  'Diego Araya',   'moto', '+56900000001'],
  ['r-sofia',  'Sofía Bustos',  'auto', '+56900000002'],
];

// El operador entra con su teléfono igual que todos. En producción
// se carga con OPERADOR_TELEFONO; acá queda uno de ejemplo.
const OPERADORES: Array<[string, string, string]> = [
  ['op-juan', 'Juan Manuel', process.env.OPERADOR_TELEFONO ?? '+56900000009'],
];

export async function sembrar(): Promise<void> {
  const yaEsta = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM productos');
  if ((yaEsta?.n ?? 0) > 0) return;

  for (const [id, nombre] of RUBROS) {
    await ejecutar('INSERT INTO rubros (id, nombre) VALUES (?, ?)', id, nombre);
  }
  for (const [id, rubro, nombre, formato, venta, costo] of PRODUCTOS) {
    await ejecutar(
      `INSERT INTO productos (id, rubro_id, nombre, formato, precio_venta, precio_costo, activo)
       VALUES (?, ?, ?, ?, ?, ?, true)`,
      id, rubro, nombre, formato, venta, costo);
  }
  // La gente de ejemplo es para desarrollo. En producción quedaban
  // ocho feriantes inventados y «conectados»: cada pedido real se
  // les ofrecía a ellos primero y esperaba tres minutos y medio a
  // que contestara alguien que no existe. Y sus teléfonos de mentira
  // tienen formato de número real: quien tuviera uno podía entrar
  // como ese feriante. Los de verdad se cargan en el panel (Gente).
  const conGenteDeEjemplo = process.env.NODE_ENV !== 'production';
  for (const [id, nombre, puesto, telefono, rubros, lat, lng] of conGenteDeEjemplo ? FERIANTES : []) {
    await ejecutar(
      `INSERT INTO feriantes (id, nombre, puesto, feria_id, telefono, conectado, lat, lng)
       VALUES (?, ?, ?, ?, ?, true, ?, ?)`,
      id, nombre, puesto, FERIA, telefono, lat, lng);
    for (const r of rubros) {
      await ejecutar('INSERT INTO feriante_rubros (feriante_id, rubro_id) VALUES (?, ?)', id, r);
    }
  }
  for (const [id, nombre, vehiculo, telefono] of conGenteDeEjemplo ? REPARTIDORES : []) {
    await ejecutar(
      `INSERT INTO repartidores (id, nombre, vehiculo, telefono, conectado)
       VALUES (?, ?, ?, ?, true)`,
      id, nombre, vehiculo, telefono);
  }
  for (const [id, nombre, telefono] of OPERADORES) {
    await ejecutar(
      'INSERT INTO operadores (id, nombre, telefono) VALUES (?, ?, ?)', id, nombre, telefono);
  }
}

export const FERIA_ID = FERIA;
