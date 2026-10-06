/**
 * Varias ferias: cada una con su horario, sus feriantes y sus pedidos.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { abrirDB, cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar } from './ayuda.ts';
import { crearPedido, confirmarPago } from '../src/dominio/despacho.ts';
import { crearFeriante, actualizarFeriante } from '../src/dominio/gente.ts';
import { listarFerias, vistaDeFeria, actualizarFeria } from '../src/dominio/ferias.ts';
import { estadoFeria, horarioDeFeria } from '../src/dominio/horario.ts';
import { ErrorNegocio } from '../src/dominio/estados.ts';

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { await cerrarDB(); });
beforeEach(limpiarYSembrar);

const MARGA = 'feria-marga-marga';
const rechaza = (codigo: number) => (e: unknown) => e instanceof ErrorNegocio && e.codigo === codigo;

const pedido = (feriaId: string) => ({
  feriaId,
  clienteNombre: 'Camila Rojas', clienteTelefono: '+56987654321',
  direccion: 'Calle Valparaíso 500', lat: -33.02, lng: -71.55,
  items: [{ productoId: 'p-tomate', cantidad: 4 }],
});

/** Marga Marga con una feriante de verduras conectada, y abierta. */
async function abrirMargaMarga() {
  const f = await crearFeriante({
    nombre: 'Elena Tapia', puesto: 'Puesto 8', telefono: '+56976543210', rubros: ['verduras'],
  }, MARGA);
  await ejecutar('UPDATE feriantes SET conectado = true WHERE id = ?', f.id);
  await actualizarFeria(MARGA, { activa: true });
  return f.id as string;
}

test('la app conoce las ferias principales y solo Av. Argentina reparte', async () => {
  const ferias = await listarFerias();
  assert.ok(ferias.length >= 7);
  assert.deepEqual(ferias.filter((f) => f.activa).map((f) => f.id), [FERIA_ID]);

  const marga = ferias.find((f) => f.id === MARGA)!;
  assert.equal(marga.comuna, 'Viña del Mar');
  assert.deepEqual(marga.horario.dias, [3, 6], 'miércoles y sábado');
});

test('no se puede pedir en una feria que todavía no reparte, ni en una inventada', async () => {
  await assert.rejects(() => crearPedido(pedido(MARGA)), rechaza(422));
  await assert.rejects(() => crearPedido(pedido('feria-que-no-existe')), rechaza(422));
});

test('una feria no se abre sin feriantes cargados', async () => {
  await assert.rejects(() => actualizarFeria(MARGA, { activa: true }), rechaza(409));
  await abrirMargaMarga();
  assert.equal((await vistaDeFeria(MARGA)).activa, true);
});

test('el pedido de una feria se ofrece solo a los feriantes de esa feria', async () => {
  const elena = await abrirMargaMarga();

  const enVina = await crearPedido(pedido(MARGA));
  await confirmarPago(enVina.pedidoId);
  const ofertasVina = await consultar<Fila>(
    `SELECT o.feriante_id FROM ofertas o JOIN sub_pedidos s ON s.id = o.sub_pedido_id
      WHERE s.pedido_id = ?`, enVina.pedidoId);
  assert.deepEqual(ofertasVina.map((o) => o.feriante_id), [elena]);

  const enValpo = await crearPedido(pedido(FERIA_ID));
  await confirmarPago(enValpo.pedidoId);
  const ofertasValpo = await consultar<Fila>(
    `SELECT o.feriante_id FROM ofertas o JOIN sub_pedidos s ON s.id = o.sub_pedido_id
      WHERE s.pedido_id = ?`, enValpo.pedidoId);
  assert.ok(ofertasValpo.length > 0);
  assert.ok(!ofertasValpo.some((o) => o.feriante_id === elena), 'a Elena no le llega lo de Valparaíso');
});

test('un feriante se puede cambiar de feria', async () => {
  await actualizarFeriante('f-jose', { feriaId: MARGA });
  const f = await consultarUno<Fila>(`SELECT feria_id FROM feriantes WHERE id = 'f-jose'`);
  assert.equal(f!.feria_id, MARGA);
  await assert.rejects(() => actualizarFeriante('f-jose', { feriaId: 'nada' }), rechaza(422));
});

test('cada feria tiene su propio horario', () => {
  // Con el horario sin forzar, que es como corre el servidor de verdad.
  const fila = { dias: [2, 5], abre: '08:00', ultimo_pedido: '14:30', cierra: '16:00' };
  const propio = { dias: fila.dias, abre: fila.abre, ultimoPedido: fila.ultimo_pedido, cierra: fila.cierra };

  // Martes 6 de octubre de 2026, 10:00 en Chile (UTC-3).
  const martes = new Date('2026-10-06T13:00:00Z');
  assert.equal(estadoFeria(martes, propio).aceptandoPedidos, true);
  // El miércoles esa feria no se pone.
  const miercoles = new Date('2026-10-07T13:00:00Z');
  const e = estadoFeria(miercoles, propio);
  assert.equal(e.aceptandoPedidos, false);
  assert.equal(e.proxima?.dia, 'viernes');
  // En los tests el horario está forzado a «siempre abierto» para todas.
  assert.equal(horarioDeFeria(fila).dias.length, 7);
});

test('el horario de una feria se corrige y se valida', async () => {
  const f = await actualizarFeria(FERIA_ID, { abre: '07:30', ultimoPedido: '13:00', cierra: '15:30', dias: [6, 3] });
  assert.deepEqual(f.horario, { dias: [3, 6], abre: '07:30', ultimoPedido: '13:00', cierra: '15:30' });

  await assert.rejects(() => actualizarFeria(FERIA_ID, { abre: '7am' }), rechaza(422));
  await assert.rejects(() => actualizarFeria(FERIA_ID, { ultimoPedido: '18:00' }), rechaza(422));
  await assert.rejects(() => actualizarFeria(FERIA_ID, { dias: [] }), rechaza(422));
  await assert.rejects(() => actualizarFeria(FERIA_ID, { dias: [9] }), rechaza(422));
});

test('la lista oficial de la región está completa y bien formada', () => {
  const lineas = readFileSync(new URL('../src/datos/ferias-region-valparaiso.psv', import.meta.url), 'utf8')
    .trim().split('\n');
  assert.equal(lineas.length, 115);
  assert.ok(lineas.every((l) => l.split(' | ').length === 7));
  assert.ok(lineas.some((l) => l.startsWith('Valparaíso | Feria Libre de la Avenida Argentina')));
});
