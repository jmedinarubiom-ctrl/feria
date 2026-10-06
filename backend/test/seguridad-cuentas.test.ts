/**
 * Validación de cuentas: lo que impide entrar como otro.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';

import { cerrarDB, consultar, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { iniciar } from '../src/http/servidor.ts';
import { limpiarYSembrar } from './ayuda.ts';
import {
  pedirCodigo, crearSesion, verificarToken, codigoParaAlguien, fijarClaveOperador,
  ErrorAuth, FaltaClave,
} from '../src/dominio/auth.ts';
import { fijarPasarela } from '../src/dominio/pagos.ts';
import { deQuien, olvidarTodo } from '../src/http/freno.ts';
import { CONFIG } from '../src/config.ts';

let servidor: Server;
let base: string;

before(async () => {
  servidor = await iniciar(0, { memoria: true });
  base = `http://localhost:${(servidor.address() as AddressInfo).port}`;
});
after(async () => {
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await cerrarDB();
});
beforeEach(async () => { await limpiarYSembrar(); fijarPasarela(null); olvidarTodo(); });

const OPERADOR = '+56900000009';
const JOSE = '+56911111111';
const CAMILA = '+56987654321';
const CLAVE = 'una clave bien larga';

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

const codigoDe = async (telefono: string) => (await pedirCodigo(telefono)).codigoDev!;
const entrar = async (telefono: string) => crearSesion(telefono, await codigoDe(telefono), 'test');
const es = (codigo: number) => (e: unknown) => e instanceof ErrorAuth && e.codigo === codigo;

// ------------------------------------------------------------
// Adivinar el código de otro
// ------------------------------------------------------------

test('tras muchos intentos fallidos en el día, ese ingreso se detiene', async () => {
  const codigo = await codigoDe(JOSE);
  await ejecutar('UPDATE codigos_acceso SET fallos = ?', CONFIG.auth.maxFallosPorDia);

  // Ni con el código correcto, ni pidiendo otro.
  await assert.rejects(() => crearSesion(JOSE, codigo), es(429));
  await assert.rejects(() => pedirCodigo(JOSE), es(429));
  // A los demás no les afecta.
  assert.equal((await entrar(CAMILA)).rol, 'cliente');
});

test('cada código equivocado se cuenta', async () => {
  await codigoDe(JOSE);
  await assert.rejects(() => crearSesion(JOSE, '000000'), es(401));
  await assert.rejects(() => crearSesion(JOSE, '111111'), es(401));
  const r = await consultarUno<Fila>('SELECT SUM(fallos)::int AS n FROM codigos_acceso');
  assert.equal(r!.n, 2);
});

test('el operador puede sacar a alguien de su equipo del bloqueo dictándole un código', async () => {
  await codigoDe(JOSE);
  await ejecutar('UPDATE codigos_acceso SET fallos = ?', CONFIG.auth.maxFallosPorDia);

  const { codigo } = await codigoParaAlguien('f-jose', 'op-juan');
  const s = await crearSesion(JOSE, codigo);
  assert.equal(s.rol, 'feriante');
});

// ------------------------------------------------------------
// La clave del operador
// ------------------------------------------------------------

test('con clave, al operador no le basta el código del SMS', async () => {
  await fijarClaveOperador('op-juan', CLAVE);
  const codigo = await codigoDe(OPERADOR);

  await assert.rejects(() => crearSesion(OPERADOR, codigo), FaltaClave);
  await assert.rejects(() => crearSesion(OPERADOR, codigo, 'x', 'otra clave cualquiera'), FaltaClave);

  // El código sigue sirviendo: no se quemó por faltar la clave.
  const s = await crearSesion(OPERADOR, codigo, 'x', CLAVE);
  assert.equal(s.rol, 'operador');
  assert.equal((await consultar('SELECT id FROM sesiones')).length, 1);
});

test('la clave del operador tiene un largo mínimo y para cambiarla hay que saber la anterior', async () => {
  await assert.rejects(() => fijarClaveOperador('op-juan', 'corta'), es(422));
  await fijarClaveOperador('op-juan', CLAVE);

  await assert.rejects(() => fijarClaveOperador('op-juan', 'otra clave bien larga'), es(403));
  await assert.rejects(() => fijarClaveOperador('op-juan', 'otra clave bien larga', 'no es'), es(403));
  await fijarClaveOperador('op-juan', 'otra clave bien larga', CLAVE);

  const codigo = await codigoDe(OPERADOR);
  await assert.rejects(() => crearSesion(OPERADOR, codigo, 'x', CLAVE), FaltaClave);
});

test('cambiar la clave cierra las otras sesiones del operador', async () => {
  const vieja = await entrar(OPERADOR);
  const actual = await entrar(OPERADOR);
  const yo = await verificarToken(actual.token);

  await fijarClaveOperador('op-juan', CLAVE, undefined, yo.sesionId);

  await assert.rejects(() => verificarToken(vieja.token), es(401));
  assert.equal((await verificarToken(actual.token)).rol, 'operador');
});

test('por HTTP: la app se entera de que falta la clave, y la clave no sale nunca', async () => {
  await fijarClaveOperador('op-juan', CLAVE);
  const c = await pedir('POST', '/auth/codigo', { telefono: OPERADOR });

  const sin = await pedir('POST', '/auth/sesion', { telefono: OPERADOR, codigo: c.json.codigoDev });
  assert.equal(sin.estado, 401);
  assert.equal(sin.json.pideClave, true);

  const con = await pedir('POST', '/auth/sesion',
    { telefono: OPERADOR, codigo: c.json.codigoDev, clave: CLAVE });
  assert.equal(con.estado, 200);

  const yo = await pedir('GET', '/auth/yo', undefined, con.json.token);
  assert.equal(yo.json.conClave, true);
  assert.ok(!JSON.stringify(yo.json).includes('scrypt'), 'ni el hash de la clave sale del servidor');
});

test('solo el operador puede poner su clave', async () => {
  const jose = await entrar(JOSE);
  const r = await pedir('POST', '/operador/clave', { nueva: CLAVE }, jose.token);
  assert.equal(r.estado, 403);
});

// ------------------------------------------------------------
// Sesiones
// ------------------------------------------------------------

test('una sesión que no se usa hace un mes se cierra sola', async () => {
  const s = await entrar(JOSE);
  await ejecutar(`UPDATE sesiones SET ultima_at = now() - make_interval(days => ?)`,
    CONFIG.auth.diasSinUso + 1);

  await assert.rejects(() => verificarToken(s.token), es(401));
  const fila = await consultarUno<Fila>('SELECT revocada_at FROM sesiones');
  assert.ok(fila!.revocada_at, 'queda cerrada, no solo rechazada');
});

test('una sesión en uso sigue viva', async () => {
  const s = await entrar(JOSE);
  await ejecutar(`UPDATE sesiones SET ultima_at = now() - make_interval(days => 20)`);
  assert.equal((await verificarToken(s.token)).rol, 'feriante');
});

// ------------------------------------------------------------
// El teléfono de la cuenta no se cambia escribiendo otro
// ------------------------------------------------------------

test('quien entró con su teléfono no puede cambiarlo por otro desde el perfil', async () => {
  const s = await entrar(CAMILA);

  await pedir('POST', '/cliente/perfil',
    { nombre: 'Camila', telefonoContacto: '+56911111111' }, s.token);
  const yo = (await pedir('GET', '/auth/yo', undefined, s.token)).json.perfil;
  assert.equal(yo.telefono, CAMILA);
  assert.equal(yo.telefono_contacto, null);

  // Y el pedido sale con el número confirmado, mande lo que mande la app.
  const p = await pedir('POST', '/pedidos', {
    clienteNombre: 'Camila', clienteTelefono: '+56911111111', direccion: 'Subida Ecuador 123',
    lat: -33.04, lng: -71.61, items: [{ productoId: 'p-tomate', cantidad: 4 }],
  }, s.token);
  assert.equal(p.estado, 200);
  const visto = (await pedir('GET', `/pedidos/${p.json.pedidoId}`, undefined, s.token)).json;
  assert.equal(visto.cliente_telefono, CAMILA);
});

test('para poner o cambiar el número hay que confirmarlo con el código que llega a ese número', async () => {
  const s = await entrar(CAMILA);
  const NUEVO = '+56944443333';

  const c = await pedir('POST', '/cliente/telefono/codigo', { telefono: NUEVO }, s.token);
  assert.equal(c.estado, 200);
  // Sin el código, o con uno inventado, no cambia nada.
  const mal = await pedir('POST', '/cliente/telefono/confirmar',
    { telefono: NUEVO, codigo: '000000' }, s.token);
  assert.equal(mal.estado, 401);
  assert.equal((await pedir('GET', '/auth/yo', undefined, s.token)).json.perfil.telefono, CAMILA);

  const ok = await pedir('POST', '/cliente/telefono/confirmar',
    { telefono: NUEVO, codigo: c.json.codigoDev }, s.token);
  assert.equal(ok.estado, 200);
  assert.equal((await pedir('GET', '/auth/yo', undefined, s.token)).json.perfil.telefono, NUEVO);

  // Con el número nuevo se entra a la MISMA cuenta.
  assert.equal((await entrar(NUEVO)).actorId, s.actorId);
});

test('no se puede confirmar como propio el número de otra persona', async () => {
  const s = await entrar(CAMILA);
  // Aunque tuviera el código (acá lo tiene porque es desarrollo).
  const c = await pedir('POST', '/cliente/telefono/codigo', { telefono: JOSE }, s.token);
  const r = await pedir('POST', '/cliente/telefono/confirmar',
    { telefono: JOSE, codigo: c.json.codigoDev }, s.token);
  assert.equal(r.estado, 409);
  assert.equal((await pedir('GET', '/auth/yo', undefined, s.token)).json.perfil.telefono, CAMILA);
});

// ------------------------------------------------------------
// WebSocket y freno
// ------------------------------------------------------------

test('el WebSocket acepta el token en el primer mensaje, no en la dirección', async () => {
  const s = await entrar(OPERADOR);
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?rol=operador');
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ token: s.token }));
  await new Promise((r) => setTimeout(r, 150));

  const aviso = new Promise<any>((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
  const cliente = await entrar(CAMILA);
  const p = await pedir('POST', '/pedidos', {
    clienteNombre: 'Camila', direccion: 'Subida Ecuador 123', lat: -33.04, lng: -71.61,
    items: [{ productoId: 'p-tomate', cantidad: 4 }],
  }, cliente.token);
  const pago = await pedir('POST', '/pagos/iniciar', { pedidoId: p.json.pedidoId });
  await pedir('POST', `/dev/pagar/${pago.json.pagoId}`);
  assert.equal((await aviso).pedidoId, p.json.pedidoId);
  ws.close();
});

test('un WebSocket que manda un token falso se cierra', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?rol=operador');
  const cerrado = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ token: 'inventado' }));
  assert.equal(await cerrado, 1008);
});

test('con los proxies declarados, la IP no se puede inventar en la cabecera', () => {
  const req = (xff: string) => ({
    headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.1' },
  });
  const antes = process.env.PROXIES_DE_CONFIANZA;
  try {
    process.env.PROXIES_DE_CONFIANZA = '1';
    // El cliente inventó 1.1.1.1; el proxy agregó la de verdad al final.
    assert.equal(deQuien(req('1.1.1.1, 200.50.60.70')), '200.50.60.70');
    assert.equal(deQuien(req('9.9.9.9, 8.8.8.8, 200.50.60.70')), '200.50.60.70');
    delete process.env.PROXIES_DE_CONFIANZA;
    assert.equal(deQuien(req('1.1.1.1, 200.50.60.70')), '1.1.1.1', 'sin configurar, como siempre');
  } finally {
    if (antes === undefined) delete process.env.PROXIES_DE_CONFIANZA;
    else process.env.PROXIES_DE_CONFIANZA = antes;
  }
});

// ------------------------------------------------------------
// Un número que cambió de dueño
// ------------------------------------------------------------

import { fijarTransporteCorreo } from '../src/correo.ts';
import { FaltaCorreo, pedirCodigoPorCorreo, crearSesionPorCorreo } from '../src/dominio/auth.ts';
import { limpiarDatosViejos } from '../src/dominio/privacidad.ts';
import { crearPedido, confirmarPago } from '../src/dominio/despacho.ts';
import { FERIA_ID } from '../src/db/semilla.ts';

let correos: Array<{ a: string; texto: string }> = [];
const codigoDelCorreo = () => /\b(\d{6})\b/.exec(correos.at(-1)!.texto)![1];

/** Camila: entró con correo, confirmó su teléfono, y dejó de usar la app. */
async function camilaConCorreoYTelefono(diasSinUso: number) {
  correos = [];
  fijarTransporteCorreo(async (a, _asunto, texto) => {
    correos.push({ a, texto });
    return { enviado: true, proveedor: 'prueba' };
  });
  await pedirCodigoPorCorreo('camila@correo.cl');
  const s = await crearSesionPorCorreo('camila@correo.cl', codigoDelCorreo());
  await ejecutar('UPDATE clientes SET telefono = ? WHERE id = ?', CAMILA, s.actorId);
  await ejecutar(
    `UPDATE clientes SET ultima_actividad_at = now() - make_interval(days => ?) WHERE id = ?`,
    diasSinUso, s.actorId);
  // Los códigos de recién no cuentan para el freno de «pediste demasiados».
  await ejecutar('DELETE FROM codigos_acceso');
  correos = [];
  return s.actorId;
}

test('quien vuelve tras meses con su teléfono confirma además por su correo', async () => {
  const cuenta = await camilaConCorreoYTelefono(CONFIG.auth.diasParaSegundaPrueba + 5);
  const sms = await codigoDe(CAMILA);

  // Con el SMS solo —lo que tendría el dueño nuevo del número— no entra.
  await assert.rejects(() => crearSesion(CAMILA, sms), (e: unknown) =>
    e instanceof FaltaCorreo && e.correo === 'ca•••@correo.cl');
  assert.equal(correos.length, 1, 'se le mandó el código al correo de la cuenta');
  assert.equal(correos[0].a, 'camila@correo.cl');
  assert.equal((await consultar('SELECT id FROM sesiones WHERE revocada_at IS NULL AND actor_id = ?', cuenta)).length, 1,
    'solo la sesión vieja: no se abrió ninguna nueva');

  // Preguntar de nuevo no manda otro correo.
  await assert.rejects(() => crearSesion(CAMILA, sms), FaltaCorreo);
  assert.equal(correos.length, 1);

  // Un código inventado tampoco.
  await assert.rejects(() => crearSesion(CAMILA, sms, 'x', undefined, '000000'), FaltaCorreo);

  // Con los dos códigos, sí. Y es su cuenta de siempre.
  const s = await crearSesion(CAMILA, sms, 'x', undefined, codigoDelCorreo());
  assert.equal(s.actorId, cuenta);
  fijarTransporteCorreo(null);
});

test('a quien usa la app seguido no se le pide nada más', async () => {
  const cuenta = await camilaConCorreoYTelefono(10);
  const s = await crearSesion(CAMILA, await codigoDe(CAMILA));
  assert.equal(s.actorId, cuenta);
  assert.equal(correos.length, 0);
  fijarTransporteCorreo(null);
});

test('por HTTP la app se entera de que falta el código del correo', async () => {
  await camilaConCorreoYTelefono(CONFIG.auth.diasParaSegundaPrueba + 5);
  const c = await pedir('POST', '/auth/codigo', { telefono: CAMILA });
  const r = await pedir('POST', '/auth/sesion', { telefono: CAMILA, codigo: c.json.codigoDev });
  assert.equal(r.estado, 401);
  assert.equal(r.json.pideCorreo, true);
  assert.equal(r.json.correo, 'ca•••@correo.cl');

  const ok = await pedir('POST', '/auth/sesion',
    { telefono: CAMILA, codigo: c.json.codigoDev, codigoCorreo: codigoDelCorreo() });
  assert.equal(ok.estado, 200);
  fijarTransporteCorreo(null);
});

test('una cuenta abandonada un año se vacía: el dueño nuevo del número parte de cero', async () => {
  const vieja = await entrar(CAMILA);
  await pedir('POST', '/cliente/perfil', { nombre: 'Camila Rojas', direccion: 'Subida Ecuador 123' }, vieja.token);
  await ejecutar(`UPDATE clientes SET ultima_actividad_at = now() - make_interval(days => ?)`,
    CONFIG.retencion.cuentasInactivasDias + 1);

  const r = await limpiarDatosViejos();
  assert.equal(r.cuentasSinUso, 1);

  // Alguien entra con ese número después: es otra cuenta, vacía.
  const nueva = await entrar(CAMILA);
  assert.notEqual(nueva.actorId, vieja.actorId);
  const perfil = (await pedir('GET', '/auth/yo', undefined, nueva.token)).json.perfil;
  assert.equal(perfil.nombre, '');
  assert.equal(perfil.direccion, null);
  assert.deepEqual((await pedir('GET', '/cliente/pedidos', undefined, nueva.token)).json.pedidos, []);
});

test('una cuenta en uso no se toca, y una con pedido en curso tampoco', async () => {
  const activa = await entrar(CAMILA);
  const conPedido = await entrar('+56912345678');
  const { pedidoId } = await crearPedido({
    feriaId: FERIA_ID, clienteId: conPedido.actorId, clienteNombre: 'Otra',
    clienteTelefono: '+56912345678', direccion: 'Calle 1', lat: -33, lng: -71,
    items: [{ productoId: 'p-tomate', cantidad: 4 }],
  });
  await confirmarPago(pedidoId);
  await ejecutar(`UPDATE clientes SET ultima_actividad_at = now() - make_interval(days => 400) WHERE id = ?`,
    conPedido.actorId);

  const r = await limpiarDatosViejos();
  assert.equal(r.cuentasSinUso, 0);
  assert.equal((await consultar('SELECT id FROM clientes')).length, 2);
  assert.equal((await verificarToken(activa.token)).rol, 'cliente');
});

test('usar la app cuenta como actividad', async () => {
  const s = await entrar(CAMILA);
  await ejecutar(`UPDATE clientes SET ultima_actividad_at = now() - make_interval(days => 200)`);
  await ejecutar(`UPDATE sesiones SET ultima_at = now() - interval '2 hours'`);
  await verificarToken(s.token);
  const c = await consultarUno<Fila>('SELECT ultima_actividad_at FROM clientes');
  assert.ok(Date.now() - c!.ultima_actividad_at.getTime() < 60_000);
});
