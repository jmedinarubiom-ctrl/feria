import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { limpiarYSembrar } from './ayuda.ts';
import {
  normalizarTelefono, pedirCodigo, crearSesion, verificarToken,
  cerrarSesion, cerrarTodas, ErrorAuth, codigoParaAlguien,
} from '../src/dominio/auth.ts';
import { CONFIG } from '../src/config.ts';

const JOSE = '+56911111111';
const DIEGO = '+56900000001';
const OPERADOR = '+56900000009';

before(async () => { await abrirDB({ memoria: true }); });
after(async () => { await cerrarDB(); });

beforeEach(limpiarYSembrar);

/** Pide un código y lo lee: en desarrollo el servidor lo devuelve. */
async function codigoDe(telefono: string): Promise<string> {
  const r = await pedirCodigo(telefono);
  assert.ok(r.codigoDev, 'en desarrollo el código viene en la respuesta');
  return r.codigoDev!;
}

// ============================================================

test('acepta el número escrito de cualquier forma', () => {
  for (const escrito of ['+56911111111', '56911111111', '911111111', '+56 9 1111 1111', '9 1111-1111']) {
    assert.equal(normalizarTelefono(escrito), JOSE, `falló con "${escrito}"`);
  }
});

test('rechaza números que no son chilenos válidos', () => {
  for (const malo of ['', '123', 'hola', '+1 555 0100', '9111111111111']) {
    assert.throws(() => normalizarTelefono(malo), ErrorAuth);
  }
});

test('el feriante entra con su teléfono y queda con sesión', async () => {
  const codigo = await codigoDe(JOSE);
  const s = await crearSesion(JOSE, codigo, 'iPhone de José');

  assert.equal(s.rol, 'feriante');
  assert.equal(s.actorId, 'f-jose');
  assert.equal(s.nombre, 'José Sandoval');
  assert.ok(s.token.length > 30);

  const yo = await verificarToken(s.token);
  assert.equal(yo.actorId, 'f-jose');
  assert.equal(yo.rol, 'feriante');
});

test('el teléfono decide el rol', async () => {
  const rep = await crearSesion(DIEGO, await codigoDe(DIEGO));
  assert.equal(rep.rol, 'repartidor');
  assert.equal(rep.actorId, 'r-diego');

  const op = await crearSesion(OPERADOR, await codigoDe(OPERADOR));
  assert.equal(op.rol, 'operador');
});

test('el token nunca se guarda en limpio', async () => {
  const s = await crearSesion(JOSE, await codigoDe(JOSE));
  const fila = await consultarUno<Fila>('SELECT * FROM sesiones LIMIT 1');
  assert.notEqual(fila!.token_hash, s.token);
  assert.ok(!JSON.stringify(fila).includes(s.token), 'el token no aparece en ninguna columna');
});

test('el código tampoco se guarda en limpio', async () => {
  const codigo = await codigoDe(JOSE);
  const fila = await consultarUno<Fila>('SELECT * FROM codigos_acceso LIMIT 1');
  assert.notEqual(fila!.codigo_hash, codigo);
  assert.ok(!JSON.stringify(fila).includes(codigo));
});

test('un código equivocado no entra', async () => {
  await codigoDe(JOSE);
  await assert.rejects(() => crearSesion(JOSE, '000000'), ErrorAuth);
});

test('el código muere después de varios intentos fallidos', async () => {
  await codigoDe(JOSE);
  for (let i = 0; i < CONFIG.auth.maxIntentos; i++) {
    await assert.rejects(() => crearSesion(JOSE, '999999'), ErrorAuth);
  }
  // Pasado el tope ya no sirve ni el correcto: hay que pedir otro.
  await assert.rejects(() => crearSesion(JOSE, '999999'),
    (e: ErrorAuth) => e.codigo === 429);
});

test('un código no se puede usar dos veces', async () => {
  const codigo = await codigoDe(JOSE);
  await crearSesion(JOSE, codigo);
  await assert.rejects(() => crearSesion(JOSE, codigo), ErrorAuth);
});

test('pedir un código nuevo invalida el anterior', async () => {
  const viejo = await codigoDe(JOSE);
  const nuevo = await codigoDe(JOSE);
  assert.notEqual(viejo, nuevo);

  await assert.rejects(() => crearSesion(JOSE, viejo), ErrorAuth);
  const s = await crearSesion(JOSE, nuevo);
  assert.equal(s.actorId, 'f-jose');
});

test('un código vencido no entra', async () => {
  const codigo = await codigoDe(JOSE);
  await ejecutar(`UPDATE codigos_acceso SET expira_at = now() - interval '1 minute'`);
  await assert.rejects(() => crearSesion(JOSE, codigo), ErrorAuth);
});

test('frena el envío repetido de SMS al mismo número', async () => {
  for (let i = 0; i < CONFIG.auth.maxEnviosPorVentana; i++) await pedirCodigo(JOSE);
  await assert.rejects(() => pedirCodigo(JOSE), (e: ErrorAuth) => e.codigo === 429);
});

test('un número desconocido recibe la misma respuesta que uno registrado', async () => {
  const r = await pedirCodigo('+56988887777');
  assert.equal(r.enviado, true, 'no delata qué números están registrados');
  assert.match(r.codigoDev!, /^\d{6}$/, 'y recibe su código: es un cliente nuevo');

  // Pedir el código no registra a nadie: el número todavía no
  // demostró ser de quien lo escribió.
  const antes = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM clientes');
  assert.equal(antes!.n, 0);
});

test('un número nuevo que confirma su código queda como cliente', async () => {
  const { codigoDev } = await pedirCodigo('+56988887777');
  const s = await crearSesion('9 8888 7777', codigoDev!);
  assert.equal(s.rol, 'cliente');

  // La segunda vez es la misma persona, no otra cuenta.
  const otra = await crearSesion('+56988887777', (await pedirCodigo('+56988887777')).codigoDev!);
  assert.equal(otra.actorId, s.actorId);
  const n = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM clientes');
  assert.equal(n!.n, 1);
});

test('en producción sin SMS, a un cliente se le dice que no hay ingreso', async () => {
  const anterior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.FERIA_SECRETO ??= 'secreto-de-test';
  try {
    await assert.rejects(() => pedirCodigo('+56988887777'),
      (e: unknown) => e instanceof ErrorAuth && e.codigo === 503);
    // Al equipo sí: el operador le dicta el código desde el panel.
    assert.equal((await pedirCodigo(JOSE)).enviado, true);
  } finally {
    process.env.NODE_ENV = anterior;
  }
});

test('un token inventado no vale', async () => {
  await assert.rejects(() => verificarToken('token-falso'), ErrorAuth);
  await assert.rejects(() => verificarToken(undefined), ErrorAuth);
  await assert.rejects(() => verificarToken(''), ErrorAuth);
});

test('cerrar sesión invalida el token en el acto', async () => {
  const s = await crearSesion(JOSE, await codigoDe(JOSE));
  const yo = await verificarToken(s.token);

  await cerrarSesion(yo.sesionId);
  await assert.rejects(() => verificarToken(s.token), ErrorAuth);
});

test('perdió el teléfono: se cierran todas sus sesiones', async () => {
  const a = await crearSesion(JOSE, await codigoDe(JOSE), 'teléfono viejo');
  const b = await crearSesion(JOSE, await codigoDe(JOSE), 'teléfono nuevo');

  assert.equal(await cerrarTodas('f-jose'), 2);
  await assert.rejects(() => verificarToken(a.token), ErrorAuth);
  await assert.rejects(() => verificarToken(b.token), ErrorAuth);
});

test('una sesión vencida no vale', async () => {
  const s = await crearSesion(JOSE, await codigoDe(JOSE));
  await ejecutar(`UPDATE sesiones SET expira_at = now() - interval '1 day'`);
  await assert.rejects(() => verificarToken(s.token), ErrorAuth);
});

test('el código de un teléfono no sirve para otro', async () => {
  const codigoDeJose = await codigoDe(JOSE);
  await codigoDe(DIEGO);
  // El hash incluye el teléfono, así que el código de José no
  // puede canjearse en la cuenta de Diego.
  await assert.rejects(() => crearSesion(DIEGO, codigoDeJose), ErrorAuth);
});

test('el contador de intentos sobrevive al error', async () => {
  // Regresión: el incremento vivía dentro de la transacción que
  // lanzaba el error, así que el ROLLBACK lo borraba y el código
  // se podía probar infinitas veces.
  await codigoDe(JOSE);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => crearSesion(JOSE, '000000'), ErrorAuth);
  }
  const fila = await consultarUno<Fila>('SELECT intentos FROM codigos_acceso LIMIT 1');
  assert.equal(fila!.intentos, 3, 'los intentos quedan grabados');
});

test('dos canjes simultáneos del mismo código crean una sola sesión', async () => {
  const codigo = await codigoDe(JOSE);
  const r = await Promise.allSettled([
    crearSesion(JOSE, codigo, 'teléfono A'),
    crearSesion(JOSE, codigo, 'teléfono B'),
  ]);

  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'solo una gana');
  const n = await consultarUno<Fila>('SELECT COUNT(*)::int AS n FROM sesiones');
  assert.equal(n!.n, 1);
});

test('el operador puede generar un código y pasarlo él', async () => {
  // Diez personas que se ven todos los sábados no justifican pagar
  // un SMS por ingreso. El operador lo dicta en la feria.
  const r = await codigoParaAlguien('f-jose', 'op-juan');
  assert.equal(r.nombre, 'José Sandoval');
  assert.match(r.codigo, /^\d{6}$/);

  // Y el código sirve de verdad para entrar.
  const s = await crearSesion('+56911111111', r.codigo, 'iPhone de José');
  assert.equal(s.rol, 'feriante');
  assert.equal(s.actorId, 'f-jose');
});

test('generar uno nuevo invalida el anterior', async () => {
  const a = await codigoParaAlguien('f-ana', 'op-juan');
  const b = await codigoParaAlguien('f-ana', 'op-juan');
  await assert.rejects(() => crearSesion('+56922222222', a.codigo, 'x'), ErrorAuth);
  const s = await crearSesion('+56922222222', b.codigo, 'x');
  assert.equal(s.actorId, 'f-ana');
});

test('queda registrado quién generó el código y para quién', async () => {
  // Con este código el operador puede entrar como cualquiera. Es un
  // poder real y tiene que dejar rastro.
  await codigoParaAlguien('r-diego', 'op-juan');
  const ev = await consultarUno<Fila>(
    `SELECT * FROM eventos WHERE entidad = 'auth' AND entidad_id = 'r-diego'
        AND tipo = 'código generado por el operador' ORDER BY id DESC LIMIT 1`);
  assert.ok(ev, 'sin rastro no hay forma de auditarlo');
  assert.equal(ev!.detalle.operadorId, 'op-juan');
});

test('un id que no existe no genera nada', async () => {
  await assert.rejects(() => codigoParaAlguien('no-existe', 'op-juan'),
    (e: ErrorAuth) => e.codigo === 404);
});
