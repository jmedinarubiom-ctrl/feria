/**
 * El comprador entra sin teléfono: código al correo, Google o Apple.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { cerrarDB, consultar, consultarUno, type Fila } from '../src/db/index.ts';
import { iniciar } from '../src/http/servidor.ts';
import { limpiarYSembrar } from './ayuda.ts';
import {
  pedirCodigoPorCorreo, crearSesionPorCorreo, crearSesionExterna, normalizarCorreo, ErrorAuth,
} from '../src/dominio/auth.ts';
import { verificarTokenExterno, fijarLlaves } from '../src/dominio/externo.ts';
import { fijarTransporteCorreo } from '../src/correo.ts';
import { fijarPasarela } from '../src/dominio/pagos.ts';
import { olvidarTodo } from '../src/http/freno.ts';

let servidor: Server;
let base: string;
let correos: Array<{ a: string; asunto: string; texto: string }> = [];

// Llaves propias que hacen de Google y de Apple.
const par = (kid: string) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privada: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' } };
};
const GOOGLE = par('g1');
const APPLE = par('a1');
const AJENA = par('g1');   // mismo kid, otra llave: la firma no calza

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function firmar(datos: object, privada: KeyObject, cabecera: object = { alg: 'RS256', kid: 'g1' }) {
  const cuerpo = `${b64(cabecera)}.${b64(datos)}`;
  const firma = createSign('RSA-SHA256').update(cuerpo).sign(privada).toString('base64url');
  return `${cuerpo}.${firma}`;
}

const enUnaHora = () => Math.floor(Date.now() / 1000) + 3600;
const deGoogle = (extra: object = {}) => ({
  iss: 'https://accounts.google.com', aud: 'cliente-google-ios', sub: 'g-123',
  email: 'Camila@Gmail.com', email_verified: true, name: 'Camila Rojas', exp: enUnaHora(), ...extra,
});

before(async () => {
  servidor = await iniciar(0, { memoria: true });
  base = `http://localhost:${(servidor.address() as AddressInfo).port}`;
  process.env.GOOGLE_CLIENT_IDS = 'cliente-google-ios, cliente-google-android';
  process.env.APPLE_CLIENT_IDS = 'cl.feria.app';
  fijarLlaves(async (url) => (url.includes('google') ? [GOOGLE.jwk] : [APPLE.jwk]));
  fijarTransporteCorreo(async (a, asunto, texto) => {
    correos.push({ a, asunto, texto });
    return { enviado: true, proveedor: 'prueba' };
  });
});

after(async () => {
  fijarLlaves(null);
  fijarTransporteCorreo(null);
  delete process.env.GOOGLE_CLIENT_IDS;
  delete process.env.APPLE_CLIENT_IDS;
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await cerrarDB();
});

beforeEach(async () => {
  await limpiarYSembrar();
  fijarPasarela(null);
  olvidarTodo();
  correos = [];
});

const pedir = async (metodo: string, camino: string, cuerpo?: unknown, token?: string) => {
  const r = await fetch(base + camino, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { estado: r.status, json: await r.json().catch(() => null) as any };
};

/** El código que llegó en el último correo. */
const codigoRecibido = () => /\b(\d{6})\b/.exec(correos.at(-1)!.texto)![1];

// ------------------------------------------------------------
// Código al correo
// ------------------------------------------------------------

test('el correo se acepta escrito de varias formas y se rechaza lo que no es', () => {
  assert.equal(normalizarCorreo('  Camila@Gmail.COM '), 'camila@gmail.com');
  for (const malo of ['', 'camila', 'camila@', '@gmail.com', 'a b@c.cl', 'x@y']) {
    assert.throws(() => normalizarCorreo(malo), ErrorAuth, malo);
  }
});

test('un comprador entra con el código que le llega al correo', async () => {
  await pedirCodigoPorCorreo('Camila@Gmail.com');
  assert.equal(correos.length, 1);
  assert.equal(correos[0].a, 'camila@gmail.com');

  const s = await crearSesionPorCorreo('camila@gmail.com', codigoRecibido());
  assert.equal(s.rol, 'cliente');

  // La próxima vez es la misma cuenta.
  await pedirCodigoPorCorreo('camila@gmail.com');
  const otra = await crearSesionPorCorreo('CAMILA@gmail.com', codigoRecibido());
  assert.equal(otra.actorId, s.actorId);
  assert.equal((await consultar('SELECT id FROM clientes')).length, 1);
});

test('un código equivocado no entra, y el de un correo no sirve para otro', async () => {
  await pedirCodigoPorCorreo('camila@gmail.com');
  const codigo = codigoRecibido();
  await assert.rejects(() => crearSesionPorCorreo('camila@gmail.com', '000000'), ErrorAuth);
  await assert.rejects(() => crearSesionPorCorreo('otra@gmail.com', codigo), ErrorAuth);
  assert.equal((await consultar('SELECT id FROM clientes')).length, 0);
});

test('pedir muchos códigos al mismo correo se frena', async () => {
  for (let i = 0; i < 3; i++) await pedirCodigoPorCorreo('camila@gmail.com');
  await assert.rejects(() => pedirCodigoPorCorreo('camila@gmail.com'),
    (e: unknown) => e instanceof ErrorAuth && e.codigo === 429);
});

test('con correo se compra de punta a punta, dejando un teléfono de contacto', async () => {
  const c = await pedir('POST', '/auth/codigo', { correo: 'camila@gmail.com' });
  assert.equal(c.estado, 200);
  const s = await pedir('POST', '/auth/sesion',
    { correo: 'camila@gmail.com', codigo: codigoRecibido() });
  assert.equal(s.json.rol, 'cliente');
  const token = s.json.token;

  const pedido = {
    clienteNombre: 'Camila Rojas', direccion: 'Subida Ecuador 123',
    lat: -33.04, lng: -71.61, items: [{ productoId: 'p-tomate', cantidad: 4 }],
  };
  // No hay número confirmado: el repartidor tiene que tener a quién llamar.
  assert.equal((await pedir('POST', '/pedidos', pedido, token)).estado, 422);

  const ok = await pedir('POST', '/pedidos', { ...pedido, clienteTelefono: '+56 9 8765 4321' }, token);
  assert.equal(ok.estado, 200);
  assert.deepEqual((await pedir('GET', '/cliente/pedidos', undefined, token)).json.pedidos,
    [ok.json.pedidoId]);
});

test('quien entró con correo no puede pedir ser feriante: hace falta su teléfono', async () => {
  await pedirCodigoPorCorreo('camila@gmail.com');
  const s = await crearSesionPorCorreo('camila@gmail.com', codigoRecibido());
  const r = await pedir('POST', '/cliente/postular',
    { tipo: 'feriante', nombre: 'Camila', puesto: 'P1', rubros: ['frutas'] }, s.token);
  assert.equal(r.estado, 409);
  assert.match(r.json.error, /teléfono/);
});

test('el correo de un feriante no le da su cuenta de feriante', async () => {
  // Aunque alguien conozca o comparta un correo, los roles de la
  // feria solo se abren con el teléfono.
  await pedirCodigoPorCorreo('jose@gmail.com');
  const s = await crearSesionPorCorreo('jose@gmail.com', codigoRecibido());
  assert.equal(s.rol, 'cliente');
});

// ------------------------------------------------------------
// Google y Apple
// ------------------------------------------------------------

test('entra con Google y queda como cliente con su nombre y correo', async () => {
  const r = await pedir('POST', '/auth/externo',
    { proveedor: 'google', idToken: firmar(deGoogle(), GOOGLE.privada) });
  assert.equal(r.estado, 200, JSON.stringify(r.json));
  assert.equal(r.json.rol, 'cliente');
  assert.equal(r.json.nombre, 'Camila Rojas');

  const c = await consultarUno<Fila>('SELECT * FROM clientes');
  assert.equal(c!.google_sub, 'g-123');
  assert.equal(c!.correo_ingreso, 'camila@gmail.com');

  // Volver a entrar no crea otra cuenta.
  const otra = await pedir('POST', '/auth/externo',
    { proveedor: 'google', idToken: firmar(deGoogle(), GOOGLE.privada) });
  assert.equal(otra.json.actorId, r.json.actorId);
});

test('Google y el código por correo llegan a la misma cuenta', async () => {
  await pedirCodigoPorCorreo('camila@gmail.com');
  const porCorreo = await crearSesionPorCorreo('camila@gmail.com', codigoRecibido());

  const quien = await verificarTokenExterno('google', firmar(deGoogle(), GOOGLE.privada));
  const porGoogle = await crearSesionExterna(quien);
  assert.equal(porGoogle.actorId, porCorreo.actorId);
});

test('un correo que Google no verificó no une cuentas', async () => {
  await pedirCodigoPorCorreo('camila@gmail.com');
  const duena = await crearSesionPorCorreo('camila@gmail.com', codigoRecibido());

  const quien = await verificarTokenExterno('google',
    firmar(deGoogle({ sub: 'g-impostor', email_verified: false }), GOOGLE.privada));
  assert.equal(quien.correo, null);
  const otro = await crearSesionExterna(quien);
  assert.notEqual(otro.actorId, duena.actorId);
});

test('entra con Apple; el nombre lo manda la app porque Apple no lo pone', async () => {
  const idToken = firmar({
    iss: 'https://appleid.apple.com', aud: 'cl.feria.app', sub: 'a-999',
    email: 'x7k@privaterelay.appleid.com', email_verified: 'true', exp: enUnaHora(),
  }, APPLE.privada, { alg: 'RS256', kid: 'a1' });

  const r = await pedir('POST', '/auth/externo', { proveedor: 'apple', idToken, nombre: 'Tomás Rey' });
  assert.equal(r.estado, 200, JSON.stringify(r.json));
  assert.equal(r.json.nombre, 'Tomás Rey');
  assert.equal((await consultarUno<Fila>('SELECT apple_sub FROM clientes'))!.apple_sub, 'a-999');
});

test('un token falsificado, vencido o hecho para otra app no entra', async () => {
  const rechazado = async (idToken: string, que: string) => {
    await assert.rejects(() => verificarTokenExterno('google', idToken),
      (e: unknown) => e instanceof ErrorAuth && e.codigo === 401, que);
  };
  await rechazado(firmar(deGoogle(), AJENA.privada), 'firmado con otra llave');
  await rechazado(firmar(deGoogle({ exp: 1_600_000_000 }), GOOGLE.privada), 'vencido');
  await rechazado(firmar(deGoogle({ aud: 'app-de-otro' }), GOOGLE.privada), 'para otra aplicación');
  await rechazado(firmar(deGoogle({ iss: 'https://evil.example' }), GOOGLE.privada), 'otro emisor');
  await rechazado(firmar(deGoogle(), GOOGLE.privada, { alg: 'RS256', kid: 'no-existe' }), 'llave desconocida');
  await rechazado(`${b64({ alg: 'none', kid: 'g1' })}.${b64(deGoogle())}.`, 'sin firma');
  await rechazado('esto-no-es-un-token', 'basura');
  // Un token de Google presentado como de Apple tampoco.
  await assert.rejects(() => verificarTokenExterno('apple', firmar(deGoogle(), GOOGLE.privada)), ErrorAuth);
  assert.equal((await consultar('SELECT id FROM clientes')).length, 0);
});

test('sin configurar, Google y Apple están apagados y la app lo sabe', async () => {
  const antes = process.env.GOOGLE_CLIENT_IDS;
  delete process.env.GOOGLE_CLIENT_IDS;
  try {
    const m = await pedir('GET', '/auth/metodos');
    assert.deepEqual(m.json, { sms: true, correo: true, google: false, apple: true });
    const r = await pedir('POST', '/auth/externo',
      { proveedor: 'google', idToken: firmar(deGoogle(), GOOGLE.privada) });
    assert.equal(r.estado, 503);
  } finally {
    process.env.GOOGLE_CLIENT_IDS = antes;
  }
});
