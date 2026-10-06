/**
 * Símbolo de cada producto y rubro, para cuando no hay foto.
 *
 * El catálogo todavía no tiene fotos —`imagen_url` queda en null
 * hasta que alguien le saque una foto a cada puesto—, y una grilla
 * con dieciséis manzanas iguales no se lee. Con un símbolo por
 * producto el cliente encuentra el tomate de un vistazo, y el día
 * que entre la foto de verdad esta tabla deja de usarse sola.
 */

const PRODUCTOS: Record<string, string> = {
  'p-tomate': '🍅',
  'p-papa': '🥔',
  'p-cebolla': '🧅',
  'p-lechuga': '🥬',
  'p-zanahoria': '🥕',
  'p-zapallo': '🍠',
  'p-palta': '🥑',
  'p-platano': '🍌',
  'p-manzana': '🍎',
  'p-naranja': '🍊',
  'p-frutilla': '🍓',
  'p-merluza': '🐟',
  'p-reineta': '🐠',
  'p-choritos': '🦪',
  'p-huevos': '🥚',
  'p-aceitunas': '🫒',
  'p-choclo': '🌽', 'p-pimenton': '🫑', 'p-ajo': '🧄', 'p-cilantro': '🌿', 'p-perejil': '🌿',
  'p-apio': '🥬', 'p-betarraga': '🍠', 'p-repollo': '🥬', 'p-brocoli': '🥦', 'p-acelga': '🥬',
  'p-zapallo-italiano': '🥒', 'p-pepino': '🥒', 'p-poroto-verde': '🫛',
  'p-limon': '🍋', 'p-pera': '🍐', 'p-uva': '🍇', 'p-kiwi': '🥝', 'p-mandarina': '🍊',
  'p-salmon': '🐟', 'p-jurel': '🐟',
  'p-queso-fresco': '🧀', 'p-queso-mantecoso': '🧀', 'p-queso-cabra': '🧀', 'p-quesillo': '🧀',
  'p-porotos': '🫘', 'p-lentejas': '🫘', 'p-nueces': '🌰', 'p-miel': '🍯', 'p-mote': '🌾',
};

const RUBROS: Record<string, string> = {
  verduras: '🥬',
  frutas: '🍎',
  pescado: '🐟',
  abarrotes: '🥚',
  quesos: '🧀',
};

/**
 * Por palabra, para los productos que el operador agregue después
 * desde el catálogo y que no estén en la tabla de arriba.
 */
const PALABRAS: Array<[RegExp, string]> = [
  [/tomate/i, '🍅'], [/papa|patata/i, '🥔'], [/cebolla/i, '🧅'],
  [/lechuga|acelga|espinaca|repollo/i, '🥬'], [/zanahoria/i, '🥕'],
  [/zapallo|calabaza/i, '🍠'], [/palta/i, '🥑'], [/plátano|platano/i, '🍌'],
  [/manzana/i, '🍎'], [/naranja/i, '🍊'], [/frutilla|fresa/i, '🍓'],
  [/limón|limon/i, '🍋'], [/uva/i, '🍇'], [/sandía|sandia/i, '🍉'],
  [/melón|melon/i, '🍈'], [/durazno|damasco/i, '🍑'], [/pera/i, '🍐'],
  [/cherry|cereza/i, '🍒'], [/piña/i, '🍍'], [/kiwi/i, '🥝'],
  [/choclo|maíz|maiz/i, '🌽'], [/ají|aji|pimentón|pimenton/i, '🌶️'],
  [/pepino/i, '🥒'], [/champiñ|hongo/i, '🍄'], [/ajo/i, '🧄'],
  [/brócoli|brocoli|coliflor/i, '🥦'], [/palmito|alcachofa/i, '🌿'],
  [/merluza|pescado|congrio|salmón|salmon/i, '🐟'], [/reineta|corvina/i, '🐠'],
  [/chorito|ostión|ostion|almeja|mariscos?/i, '🦪'], [/jaiba|cangrejo/i, '🦀'],
  [/camarón|camaron/i, '🦐'], [/pulpo/i, '🐙'], [/huevo/i, '🥚'],
  [/aceituna/i, '🫒'], [/queso/i, '🧀'], [/pan|hallulla|marraqueta/i, '🍞'],
  [/miel/i, '🍯'], [/nuez|nueces|almendra/i, '🌰'], [/poroto|lenteja|garbanzo/i, '🫘'],
  [/arroz|fideo|tallarín|tallarin/i, '🍚'], [/aceite/i, '🫗'],
  [/hierba|cilantro|perejil|albahaca/i, '🌿'], [/flor/i, '💐'],
];

export function simboloProducto(p: { id?: string; nombre?: string }): string | null {
  if (p.id && PRODUCTOS[p.id]) return PRODUCTOS[p.id];
  if (p.nombre) {
    for (const [patron, simbolo] of PALABRAS) {
      if (patron.test(p.nombre)) return simbolo;
    }
  }
  return null;
}

export const simboloRubro = (id: string, nombre?: string): string | null =>
  RUBROS[id] ?? (nombre ? simboloProducto({ nombre }) : null);
