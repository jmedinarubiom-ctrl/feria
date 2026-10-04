import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  deQuien, pasar, limpiar, olvidarTodo, cuantasVentanas, LIMITE_POR_MINUTO,
} from '../src/http/freno.ts';

/** Freno por IP. Lo que protege es que la feria siga respondiendo. */

beforeEach(() => olvidarTodo());

test('deja pasar el uso normal', () => {
  for (let i = 0; i < LIMITE_POR_MINUTO; i++) {
    assert.equal(pasar('1.2.3.4'), 0, `petición ${i + 1}`);
  }
});

test('corta al pasarse y dice cuánto esperar', () => {
  for (let i = 0; i < LIMITE_POR_MINUTO; i++) pasar('1.2.3.4');
  const espera = pasar('1.2.3.4');
  assert.ok(espera > 0 && espera <= 60, `esperar ${espera}s`);
});

test('una IP que se pasa no afecta a las demás', () => {
  for (let i = 0; i < LIMITE_POR_MINUTO + 10; i++) pasar('1.2.3.4');
  assert.equal(pasar('5.6.7.8'), 0, 'el resto de la feria tiene que poder comprar');
});

test('la ventana se renueva al minuto', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < LIMITE_POR_MINUTO + 5; i++) pasar('1.2.3.4', t0);
  assert.ok(pasar('1.2.3.4', t0 + 59_000) > 0);
  assert.equal(pasar('1.2.3.4', t0 + 61_000), 0);
});

test('detrás de un proxy mira la IP del cliente, no la del proxy', () => {
  // Sin esto el límite sería global: todas las peticiones llegan
  // con la IP del proxy y la primera persona deja fuera al resto.
  assert.equal(
    deQuien({ headers: { 'x-forwarded-for': '200.1.2.3, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } }),
    '200.1.2.3');
  assert.equal(deQuien({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  assert.equal(deQuien({ headers: {} }), 'desconocida');
});

test('el mapa no crece para siempre', () => {
  const t0 = 2_000_000;
  for (let i = 0; i < 500; i++) pasar(`10.0.0.${i}`, t0);
  assert.equal(cuantasVentanas(), 500);
  assert.equal(limpiar(t0 + 61_000), 500);
  assert.equal(cuantasVentanas(), 0);
});
