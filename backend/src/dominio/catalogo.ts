import { consultar, consultarUno, ejecutar, registrarEvento, type Fila } from '../db/index.ts';

export class ErrorCatalogo extends Error {
  codigo: number;
  constructor(codigo: number, msg: string) {
    super(msg);
    this.codigo = codigo;
    this.name = 'ErrorCatalogo';
  }
}

/** Margen unitario de un producto. */
const conMargen = (p: Fila): Fila => ({
  ...p,
  margen: p.precio_venta - p.precio_costo,
  tasa_margen: p.precio_venta > 0
    ? Number(((p.precio_venta - p.precio_costo) / p.precio_venta).toFixed(3))
    : 0,
});

/**
 * El catálogo completo para administrar, agrupado por rubro.
 *
 * Incluye los productos apagados: fuera de temporada no se venden,
 * pero vuelven, y no hay que cargarlos de nuevo cada año.
 */
export async function catalogoCompleto() {
  const rubros = await consultar<Fila>('SELECT * FROM rubros ORDER BY nombre');
  const productos = await consultar<Fila>(
    'SELECT * FROM productos ORDER BY activo DESC, nombre');

  return rubros.map((r) => {
    const suyos = productos.filter((p) => p.rubro_id === r.id).map(conMargen);
    return {
      ...r,
      productos: suyos,
      activos: suyos.filter((p) => p.activo).length,
      /** Margen promedio del rubro, para ver de un vistazo cuál rinde. */
      tasaMargen: suyos.length
        ? Number((suyos.reduce((a, p) => a + p.tasa_margen, 0) / suyos.length).toFixed(3))
        : 0,
    };
  });
}

function validarPrecio(valor: unknown, campo: string): number {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ErrorCatalogo(422, `${campo} tiene que ser un número entero mayor que cero.`);
  }
  if (n > 1_000_000) {
    throw new ErrorCatalogo(422, `${campo} parece equivocado: ${n}.`);
  }
  return n;
}

/**
 * Verifica que no se venda bajo el costo.
 *
 * Es un error y no un aviso a propósito: un dedo torpe a las seis de
 * la mañana que deja el tomate vendiéndose bajo costo cuesta plata
 * todo el sábado, y nadie lo mira hasta la noche.
 */
function validarMargen(venta: number, costo: number): void {
  if (venta < costo) {
    throw new ErrorCatalogo(422,
      `El precio de venta (${venta}) es menor que el costo (${costo}). ` +
      `Con cada unidad perderías ${costo - venta}.`);
  }
}

/**
 * Valida la dirección de la foto.
 *
 * Dos formas válidas:
 *
 *  - `/fotos/<hash>.jpg`, una foto subida a este servidor. Se
 *    guarda relativa a propósito: cada cliente le pone adelante la
 *    dirección por la que él llega al servidor. Guardar el dominio
 *    en la base significa que el día que cambie —o que se pruebe
 *    desde un teléfono y no desde el mismo computador— todas las
 *    fotos del catálogo apunten a ninguna parte.
 *  - una URL http(s) completa, para fotos que ya viven en otro lado.
 *
 * Vacío significa «sacar la foto». Un `file://` del teléfono del
 * operador no lo puede abrir nadie más, así que se rechaza: sin
 * esto se guarda sin chistar y el cliente ve un hueco.
 */
export function validarImagen(valor: string | null | undefined): string | null {
  if (valor == null) return null;
  const limpio = String(valor).trim();
  if (!limpio) return null;
  if (limpio.length > 500) throw new ErrorCatalogo(422, 'La dirección de la foto es muy larga.');

  if (/^\/fotos\/[0-9a-f]{32}\.(jpg|png|webp)$/.test(limpio)) return limpio;

  let url: URL;
  try {
    url = new URL(limpio);
  } catch {
    throw new ErrorCatalogo(422, 'La foto tiene que ser una dirección web completa.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ErrorCatalogo(422,
      'La foto tiene que empezar con https://. Una del teléfono no la puede abrir nadie más.');
  }
  // Una foto de este mismo servidor se guarda relativa, venga como
  // venga: lo que importa es el camino, no por dónde se subió.
  return /^\/fotos\/[0-9a-f]{32}\.(jpg|png|webp)$/.test(url.pathname) ? url.pathname : limpio;
}

export type CambioProducto = {
  nombre?: string;
  formato?: string;
  precioVenta?: number;
  precioCosto?: number;
  activo?: boolean;
  imagenUrl?: string | null;
};

/**
 * Actualiza un producto.
 *
 * Cambiar un precio NO toca los pedidos que ya existen: los items
 * guardan su propia copia del precio. El cliente paga lo que vio, y
 * al feriante se le paga lo que se le prometió.
 */
export async function actualizarProducto(id: string, cambio: CambioProducto) {
  const actual = await consultarUno<Fila>('SELECT * FROM productos WHERE id = ?', id);
  if (!actual) throw new ErrorCatalogo(404, 'Producto no encontrado.');

  const venta = cambio.precioVenta !== undefined
    ? validarPrecio(cambio.precioVenta, 'El precio de venta') : actual.precio_venta;
  const costo = cambio.precioCosto !== undefined
    ? validarPrecio(cambio.precioCosto, 'El precio de costo') : actual.precio_costo;
  validarMargen(venta, costo);

  const nombre = cambio.nombre?.trim() || actual.nombre;
  const formato = cambio.formato?.trim() || actual.formato;
  const activo = cambio.activo ?? actual.activo;

  await ejecutar(
    `UPDATE productos
        SET nombre = ?, formato = ?, precio_venta = ?, precio_costo = ?,
            activo = ?, imagen_url = ?
      WHERE id = ?`,
    nombre, formato, venta, costo, activo,
    cambio.imagenUrl !== undefined ? validarImagen(cambio.imagenUrl) : actual.imagen_url,
    id);

  // Los cambios de precio quedan registrados: al mes siguiente uno
  // quiere saber cuándo subió el tomate y en cuánto.
  if (venta !== actual.precio_venta || costo !== actual.precio_costo) {
    await registrarEvento('producto', id, 'precio cambiado', {
      venta: { antes: actual.precio_venta, ahora: venta },
      costo: { antes: actual.precio_costo, ahora: costo },
    });
  }
  if (activo !== actual.activo) {
    await registrarEvento('producto', id, activo ? 'activado' : 'desactivado');
  }

  return conMargen((await consultarUno<Fila>('SELECT * FROM productos WHERE id = ?', id))!);
}

export async function crearProducto(datos: {
  id?: string;
  rubroId: string;
  nombre: string;
  formato: string;
  precioVenta: number;
  precioCosto: number;
  imagenUrl?: string | null;
}) {
  const rubro = await consultarUno('SELECT id FROM rubros WHERE id = ?', datos.rubroId);
  if (!rubro) throw new ErrorCatalogo(422, `No existe el rubro ${datos.rubroId}.`);

  const nombre = String(datos.nombre ?? '').trim();
  const formato = String(datos.formato ?? '').trim();
  if (!nombre) throw new ErrorCatalogo(422, 'Falta el nombre del producto.');
  if (!formato) throw new ErrorCatalogo(422, 'Falta el formato (por ejemplo "Malla 1 kg").');

  const venta = validarPrecio(datos.precioVenta, 'El precio de venta');
  const costo = validarPrecio(datos.precioCosto, 'El precio de costo');
  validarMargen(venta, costo);

  // Id legible a partir del nombre, para que la base se pueda leer.
  const id = datos.id ?? 'p-' + nombre.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

  if (await consultarUno('SELECT id FROM productos WHERE id = ?', id)) {
    throw new ErrorCatalogo(409, `Ya existe un producto con el id ${id}.`);
  }

  await ejecutar(
    `INSERT INTO productos
       (id, rubro_id, nombre, formato, precio_venta, precio_costo, imagen_url, activo)
     VALUES (?, ?, ?, ?, ?, ?, ?, true)`,
    id, datos.rubroId, nombre, formato, venta, costo, validarImagen(datos.imagenUrl));
  await registrarEvento('producto', id, 'creado', { nombre, venta, costo });

  return conMargen((await consultarUno<Fila>('SELECT * FROM productos WHERE id = ?', id))!);
}

/** Historial de precios de un producto. */
export async function historialDe(productoId: string) {
  return consultar(
    `SELECT tipo, detalle, at FROM eventos
      WHERE entidad = 'producto' AND entidad_id = ?
      ORDER BY at DESC LIMIT 50`,
    productoId);
}
