import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultar, consultarUno, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar, pedidoPagado } from './ayuda.ts';
import {
  catalogoCompleto, actualizarProducto, crearProducto, historialDe, ErrorCatalogo,
} from '../src/dominio/catalogo.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { await cerrarDB(); });
beforeEach(limpiarYSembrar);

const pedir = (items: Array<{ productoId: string; cantidad: number }>) => pedidoPagado({
  feriaId: FERIA_ID,
  clienteNombre: 'Juan Manuel',
  clienteTelefono: '+56999999999',
  direccion: 'Subida Ecuador 123, Valparaíso',
  lat: -33.0458, lng: -71.6197,
  items,
});

// ============================================================

test('el catálogo muestra el margen de cada producto', async () => {
  const rubros = await catalogoCompleto();
  const verduras = rubros.find((r) => r.id === 'verduras')!;
  const tomate = verduras.productos.find((p: Fila) => p.id === 'p-tomate')!;

  assert.equal(tomate.margen, 2200 - 1500);
  assert.equal(tomate.tasa_margen, Number((700 / 2200).toFixed(3)));
  assert.ok(verduras.tasaMargen > 0, 'y el promedio del rubro');
});

test('cambiar un precio no toca los pedidos que ya existen', async () => {
  const { pedidoId } = await pedir([{ productoId: 'p-tomate', cantidad: 4 }]);

  await actualizarProducto('p-tomate', { precioVenta: 3000, precioCosto: 2000 });

  // El cliente paga lo que vio y al feriante se le paga lo prometido.
  const pedido = await consultarUno<Fila>('SELECT * FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(pedido!.total_productos, 2200 * 4, 'el pedido conserva su precio');

  const item = await consultarUno<Fila>(
    `SELECT i.* FROM items i JOIN sub_pedidos s ON s.id = i.sub_pedido_id
      WHERE s.pedido_id = ?`, pedidoId);
  assert.equal(item!.precio_venta, 2200);
  assert.equal(item!.precio_costo, 1500);

  const sub = await consultarUno<Fila>(
    'SELECT monto_feriante FROM sub_pedidos WHERE pedido_id = ?', pedidoId);
  assert.equal(sub!.monto_feriante, 1500 * 4, 'al feriante se le paga lo pactado');
});

test('no deja vender bajo el costo', async () => {
  // Un dedo torpe a las seis de la mañana cuesta plata todo el sábado.
  await assert.rejects(
    () => actualizarProducto('p-tomate', { precioVenta: 1000 }),
    (e: ErrorCatalogo) => e.codigo === 422 && /perderías/.test(e.message));

  const p = await consultarUno<Fila>('SELECT * FROM productos WHERE id = ?', 'p-tomate');
  assert.equal(p!.precio_venta, 2200, 'no se guardó nada');
});

test('rechaza precios que no son números enteros positivos', async () => {
  for (const malo of [0, -100, 1.5, 'hola', null]) {
    await assert.rejects(
      () => actualizarProducto('p-tomate', { precioVenta: malo as any }), ErrorCatalogo);
  }
  // Y un cero de más al escribir.
  await assert.rejects(
    () => actualizarProducto('p-tomate', { precioVenta: 22_000_000 }), ErrorCatalogo);
});

test('un producto apagado no se puede pedir pero sigue en el catálogo', async () => {
  await actualizarProducto('p-frutilla', { activo: false });

  await assert.rejects(() => pedir([
    { productoId: 'p-frutilla', cantidad: 4 },
  ]), /inexistente o inactivo/);

  const rubros = await catalogoCompleto();
  const frutas = rubros.find((r) => r.id === 'frutas')!;
  assert.ok(frutas.productos.some((p: Fila) => p.id === 'p-frutilla'),
    'sigue listado para poder reactivarlo en temporada');
  assert.equal(frutas.productos.find((p: Fila) => p.id === 'p-frutilla')!.activo, false);
});

test('se pueden agregar productos nuevos', async () => {
  const nuevo = await crearProducto({
    rubroId: 'verduras',
    nombre: 'Choclo',
    formato: 'Docena',
    precioVenta: 4500,
    precioCosto: 3000,
  });

  assert.equal(nuevo.id, 'p-choclo', 'id legible a partir del nombre');
  assert.equal(nuevo.margen, 1500);
  assert.equal(nuevo.activo, true);

  // Y se puede pedir de inmediato.
  const { pedidoId } = await pedir([{ productoId: 'p-choclo', cantidad: 2 }]);
  const p = await consultarUno<Fila>('SELECT total_productos FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(p!.total_productos, 9000);
});

test('no deja crear dos productos con el mismo nombre', async () => {
  await crearProducto({
    rubroId: 'verduras', nombre: 'Choclo', formato: 'Docena',
    precioVenta: 4500, precioCosto: 3000,
  });
  await assert.rejects(() => crearProducto({
    rubroId: 'verduras', nombre: 'Choclo', formato: 'Media docena',
    precioVenta: 2500, precioCosto: 1800,
  }), (e: ErrorCatalogo) => e.codigo === 409);
});

test('rechaza productos sin nombre, sin formato o de un rubro inexistente', async () => {
  const base = { rubroId: 'verduras', nombre: 'X', formato: 'Y', precioVenta: 100, precioCosto: 50 };
  await assert.rejects(() => crearProducto({ ...base, nombre: '  ' }), ErrorCatalogo);
  await assert.rejects(() => crearProducto({ ...base, formato: '' }), ErrorCatalogo);
  await assert.rejects(() => crearProducto({ ...base, rubroId: 'inventado' }), ErrorCatalogo);
});

test('los cambios de precio quedan en el historial', async () => {
  await actualizarProducto('p-tomate', { precioVenta: 2500, precioCosto: 1700 });
  await actualizarProducto('p-tomate', { activo: false });

  const h = await historialDe('p-tomate');
  assert.equal(h.length, 2);
  assert.equal(h[0].tipo, 'desactivado');
  assert.equal(h[1].tipo, 'precio cambiado');
  assert.deepEqual(h[1].detalle.venta, { antes: 2200, ahora: 2500 });
});

test('cambiar solo el nombre no toca los precios', async () => {
  const r = await actualizarProducto('p-tomate', { nombre: 'Tomate larga vida' });
  assert.equal(r.nombre, 'Tomate larga vida');
  assert.equal(r.precio_venta, 2200);
  assert.equal(r.precio_costo, 1500);

  const h = await historialDe('p-tomate');
  assert.equal(h.length, 0, 'no se registra un cambio de precio que no hubo');
});

test('la foto se guarda al crear y al editar', async () => {
  const r = await crearProducto({
    rubroId: 'verduras', nombre: 'Choclo', formato: 'Docena',
    precioVenta: 3000, precioCosto: 2000,
    imagenUrl: 'https://fotos.feria.cl/choclo.jpg',
  });
  assert.equal(r.imagen_url, 'https://fotos.feria.cl/choclo.jpg');

  const e = await actualizarProducto('p-tomate', {
    imagenUrl: 'https://fotos.feria.cl/tomate.jpg',
  });
  assert.equal(e.imagen_url, 'https://fotos.feria.cl/tomate.jpg');
  assert.equal(e.precio_venta, 2200, 'cargar la foto no toca el precio');
});

test('una foto vacía saca la que había', async () => {
  await actualizarProducto('p-tomate', { imagenUrl: 'https://fotos.feria.cl/tomate.jpg' });
  const r = await actualizarProducto('p-tomate', { imagenUrl: '  ' });
  assert.equal(r.imagen_url, null);
});

test('sin tocar la foto, la que había se queda', async () => {
  await actualizarProducto('p-tomate', { imagenUrl: 'https://fotos.feria.cl/tomate.jpg' });
  const r = await actualizarProducto('p-tomate', { precioVenta: 2300 });
  assert.equal(r.imagen_url, 'https://fotos.feria.cl/tomate.jpg');
});

test('una foto del teléfono del operador no la puede abrir nadie más', async () => {
  // El error más fácil de cometer: pegar la ruta local de la foto.
  // Se guarda sin chistar y el cliente ve un hueco.
  await assert.rejects(
    () => actualizarProducto('p-tomate', { imagenUrl: 'file:///var/fotos/tomate.jpg' }),
    (e: ErrorCatalogo) => e.codigo === 422);
  await assert.rejects(
    () => actualizarProducto('p-tomate', { imagenUrl: 'fotos.feria.cl/tomate.jpg' }),
    (e: ErrorCatalogo) => e.codigo === 422);
  await assert.rejects(
    () => actualizarProducto('p-tomate', { imagenUrl: 'javascript:alert(1)' }),
    (e: ErrorCatalogo) => e.codigo === 422);
});

test('la foto propia se guarda relativa, venga como venga', async () => {
  // Guardar el dominio en la base es lo que rompe el día que la
  // feria cambie de servidor: cada producto apuntaría al viejo.
  const hash = 'a'.repeat(32);
  const a = await actualizarProducto('p-tomate',
    { imagenUrl: `http://localhost:4000/fotos/${hash}.png` });
  assert.equal(a.imagen_url, `/fotos/${hash}.png`);

  const b = await actualizarProducto('p-tomate',
    { imagenUrl: `https://feria.cl/fotos/${hash}.png` });
  assert.equal(b.imagen_url, `/fotos/${hash}.png`);

  const c = await actualizarProducto('p-tomate', { imagenUrl: `/fotos/${hash}.webp` });
  assert.equal(c.imagen_url, `/fotos/${hash}.webp`);
});

test('una foto de otro sitio se guarda entera', async () => {
  const r = await actualizarProducto('p-tomate',
    { imagenUrl: 'https://fotos.ejemplo.cl/tomate-de-la-feria.jpg' });
  assert.equal(r.imagen_url, 'https://fotos.ejemplo.cl/tomate-de-la-feria.jpg');
});

test('un camino que parece de acá pero no lo es se rechaza', async () => {
  await assert.rejects(
    () => actualizarProducto('p-tomate', { imagenUrl: '/fotos/../../etc/passwd' }),
    (e: ErrorCatalogo) => e.codigo === 422);
});
