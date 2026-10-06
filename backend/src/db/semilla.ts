import { ejecutar, consultarUno, type Fila } from './index.ts';

/**
 * Datos de arranque: Feria Av. Argentina, Valparaíso.
 * Precios en CLP. `precio_venta` es lo que paga el cliente,
 * `precio_costo` lo que se le paga al feriante en la tarde.
 */

const FERIA = 'feria-av-argentina';

const RUBROS = [
  ['verduras', 'Verduras'],
  ['frutas', 'Frutas'],
  ['pescado', 'Pescados y mariscos'],
  ['abarrotes', 'Abarrotes y huevos'],
  ['quesos', 'Quesos y lácteos'],
];

/**
 * Lo que más se lleva de una feria, además de la primera tanda.
 *
 * Los precios son una ESTIMACIÓN para partir, no un dato: hay que
 * corregirlos en el panel (Catálogo) con los de cada semana.
 */
const MAS_PRODUCTOS: Array<[string, string, string, string, number, number]> = [
  // Verduras
  ['p-choclo',          'verduras', 'Choclo',           'Unidad',              700,  450],
  ['p-pimenton',        'verduras', 'Pimentón',         'Unidad',              800,  500],
  ['p-ajo',             'verduras', 'Ajo',              'Cabeza',              600,  350],
  ['p-cilantro',        'verduras', 'Cilantro',         'Atado',               700,  400],
  ['p-perejil',         'verduras', 'Perejil',          'Atado',               700,  400],
  ['p-apio',            'verduras', 'Apio',             'Unidad',             1500, 1000],
  ['p-betarraga',       'verduras', 'Betarraga',        'Atado',              1500, 1000],
  ['p-repollo',         'verduras', 'Repollo',          'Unidad',             1800, 1200],
  ['p-brocoli',         'verduras', 'Brócoli',          'Unidad',             1500, 1000],
  ['p-acelga',          'verduras', 'Acelga',           'Atado',              1000,  650],
  ['p-zapallo-italiano','verduras', 'Zapallo italiano', 'Unidad',              700,  450],
  ['p-pepino',          'verduras', 'Pepino',           'Unidad',              700,  450],
  ['p-poroto-verde',    'verduras', 'Poroto verde',     'Bolsa 500 g',        1500, 1000],
  // Frutas
  ['p-limon',           'frutas',   'Limón',            'Malla 1 kg',         1800, 1200],
  ['p-pera',            'frutas',   'Pera',             'Kilo',               1900, 1300],
  ['p-uva',             'frutas',   'Uva',              'Kilo',               2500, 1700],
  ['p-kiwi',            'frutas',   'Kiwi',             'Kilo',               2200, 1500],
  ['p-mandarina',       'frutas',   'Mandarina',        'Malla 1 kg',         1900, 1300],
  // Pescados
  ['p-salmon',          'pescado',  'Salmón',           'Kilo, filete',      12900, 9900],
  ['p-jurel',           'pescado',  'Jurel',            'Kilo',               3900, 2800],
  // Quesos y lácteos
  ['p-queso-fresco',    'quesos',   'Queso fresco',     'Trozo 500 g aprox.', 4200, 3100],
  ['p-queso-mantecoso', 'quesos',   'Queso mantecoso',  'Trozo 500 g aprox.', 5900, 4500],
  ['p-queso-cabra',     'quesos',   'Queso de cabra',   'Trozo 250 g aprox.', 4500, 3300],
  ['p-quesillo',        'quesos',   'Quesillo',         'Unidad 300 g',       2500, 1800],
  // Abarrotes
  ['p-porotos',         'abarrotes','Porotos',          'Bolsa 1 kg',         3500, 2500],
  ['p-lentejas',        'abarrotes','Lentejas',         'Bolsa 1 kg',         2900, 2100],
  ['p-nueces',          'abarrotes','Nueces',           'Bolsa 250 g',        3500, 2500],
  ['p-miel',            'abarrotes','Miel',             'Frasco 500 g',       5500, 4000],
  ['p-mote',            'abarrotes','Mote',             'Bolsa 500 g',        1500, 1000],
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
  ...MAS_PRODUCTOS,
];


// Coordenadas aproximadas a lo largo de Av. Argentina, Valparaíso.
const FERIANTES: Array<[string, string, string, string, string[], number, number]> = [
  ['f-jose',   'José Sandoval',    'Puesto 12, sector norte',  '+56911111111', ['verduras'],              -33.0472, -71.6127],
  ['f-ana',    'Ana Poblete',      'Puesto 27, sector norte',  '+56922222222', ['verduras', 'frutas'],    -33.0475, -71.6131],
  ['f-carmen', 'Carmen Vidal',     'Puesto 41, sector centro', '+56933333333', ['frutas'],                -33.0481, -71.6136],
  ['f-luis',   'Luis Ovalle',      'Puesto 55, sector centro', '+56944444444', ['verduras'],              -33.0486, -71.6140],
  ['f-marta',  'Marta Riquelme',   'Puesto 63, sector centro', '+56955555555', ['frutas', 'abarrotes', 'quesos'],   -33.0490, -71.6144],
  ['f-pedro',  'Pedro Cáceres',    'Puesto 78, sector sur',    '+56966666666', ['pescado'],               -33.0495, -71.6149],
  ['f-rosa',   'Rosa Millán',      'Puesto 84, sector sur',    '+56977777777', ['pescado', 'abarrotes'],  -33.0498, -71.6152],
  ['f-hector', 'Héctor Fuentes',   'Puesto 91, sector sur',    '+56988888888', ['abarrotes', 'quesos'],             -33.0501, -71.6155],
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

/**
 * Las ferias principales del Gran Valparaíso.
 *
 * Días, calles y horarios salen del Localizador Nacional de Ferias
 * Libres de ODEPA y ASOF (actualización de agosto de 2025); la
 * lista completa de la región está en `src/datos/`. El último
 * pedido es una hora y media antes del cierre: lo que tarda un
 * pedido en ofertarse, prepararse y salir.
 *
 * Solo Av. Argentina nace activa. Su horario es el que ya usaba la
 * app, más corto que el del localizador (que dice 06:00 a 22:00, y
 * no parece el de una feria de frutas y verduras).
 */
const FERIAS: Array<[string, string, string, string, number[], string, string, string, boolean]> = [
  // id, nombre, comuna, calle, días, abre, último pedido, cierra, activa
  [FERIA, 'Feria Av. Argentina', 'Valparaíso',
    'Av. Argentina, entre Rancagua y Victoria', [3, 6], '07:00', '13:30', '15:00', true],
  ['feria-marga-marga', 'Feria Estero Marga Marga', 'Viña del Mar',
    'Lecho del estero Marga Marga', [3, 6], '08:00', '14:30', '16:00', false],
  ['feria-gomez-carreno-3', 'Feria Gómez Carreño, tercer sector', 'Viña del Mar',
    'Av. Pacífico', [2, 5], '08:00', '14:30', '16:00', false],
  ['feria-gomez-carreno-5', 'Feria Gómez Carreño, quinto sector', 'Viña del Mar',
    '25 Poniente con 1 Sur', [0, 4], '08:00', '14:30', '16:00', false],
  ['feria-belloto', 'Feria Municipal El Belloto', 'Quilpué',
    'Perú 151', [3, 6], '06:00', '15:30', '17:00', false],
  ['feria-molino-prat', 'Feria Molino Prat', 'Villa Alemana',
    'Valencia 275, esquina Aviador Figueroa', [0], '07:00', '15:00', '16:30', false],
  ['feria-pena-blanca', 'Feria Peña Blanca', 'Villa Alemana',
    'New Memory, esquina Los Crespones', [3, 6], '07:00', '15:00', '16:30', false],
];

/** Carga las ferias que falten. No pisa lo que el operador ya cambió. */
export async function sembrarFerias(): Promise<void> {
  for (const [id, nombre, comuna, calle, dias, abre, ultimo, cierra, activa] of FERIAS) {
    await ejecutar(
      `INSERT INTO ferias (id, nombre, comuna, calle, dias, abre, ultimo_pedido, cierra, activa, fuente)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      id, nombre, comuna, calle, dias, abre, ultimo, cierra, activa,
      'ODEPA/ASOF, Localizador Nacional de Ferias Libres, agosto 2025');
  }
}

const MARCA_NOVEDADES = 'siembra-2026-10-mas-productos';

/**
 * Agrega a un catálogo que ya existe los productos y el rubro que
 * se sumaron después. Corre una sola vez por base —queda anotado
 * junto a las migraciones— para no volver a meter lo que el
 * operador después haya decidido sacar. No toca precios ni nada de
 * lo que ya estaba.
 */
async function sembrarNovedades(): Promise<void> {
  if (await consultarUno('SELECT 1 AS ok FROM migraciones WHERE nombre = ?', MARCA_NOVEDADES)) return;

  for (const [id, nombre] of RUBROS) {
    await ejecutar('INSERT INTO rubros (id, nombre) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', id, nombre);
  }
  for (const [id, rubro, nombre, formato, venta, costo] of MAS_PRODUCTOS) {
    await ejecutar(
      `INSERT INTO productos (id, rubro_id, nombre, formato, precio_venta, precio_costo, activo)
       VALUES (?, ?, ?, ?, ?, ?, true) ON CONFLICT (id) DO NOTHING`,
      id, rubro, nombre, formato, venta, costo);
  }
  // Los feriantes de ejemplo que venden quesos, si están.
  for (const id of ['f-marta', 'f-hector']) {
    await ejecutar(
      `INSERT INTO feriante_rubros (feriante_id, rubro_id)
       SELECT id, 'quesos' FROM feriantes WHERE id = ? ON CONFLICT DO NOTHING`, id);
  }
  await ejecutar('INSERT INTO migraciones (nombre) VALUES (?) ON CONFLICT DO NOTHING', MARCA_NOVEDADES);
  console.log('[catálogo] se agregaron los productos nuevos');
}

export async function sembrar(): Promise<void> {
  await sembrarFerias();
  const yaEsta = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM productos');
  if ((yaEsta?.n ?? 0) > 0) return sembrarNovedades();
  // Una base nueva nace con todo: no hay novedades que agregarle.
  await ejecutar('INSERT INTO migraciones (nombre) VALUES (?) ON CONFLICT DO NOTHING', MARCA_NOVEDADES);

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
