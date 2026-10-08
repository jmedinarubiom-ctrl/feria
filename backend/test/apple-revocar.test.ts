import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { abrirDB, cerrarDB, consultarUno, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import {
  cifrar, descifrar, fijarTransporteApple, guardarPermisoApple, permisoAppleDe,
  puedeRevocarApple, revocarPermisoApple, secretoDeCliente,
} from '../src/dominio/apple.ts';
import { eliminarCuentaCliente } from '../src/dominio/privacidad.ts';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const llamadas: Array<{ camino: string; campos: Record<string, string> }> = [];
let appleResponde = true;

before(async () => {
  await abrirDB({ memoria: true });
  await sembrar();
  await ejecutar(`INSERT INTO clientes (id, nombre, apple_sub, correo_ingreso) VALUES ('cli-apple', 'Ana', 'sub-1', 'ana@example.com')`);
  fijarTransporteApple(async (camino, campos) => {
    llamadas.push({ camino, campos });
    if (!appleResponde) return { ok: false, estado: 400, datos: { error: 'invalid_grant' } };
    return camino === 'token'
      ? { ok: true, estado: 200, datos: { refresh_token: 'permiso-largo-de-apple' } }
      : { ok: true, estado: 200, datos: {} };
  });
});
after(async () => {
  for (const k of ['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'APPLE_CLIENT_IDS']) delete process.env[k];
  fijarTransporteApple(null); await cerrarDB();
});

test('sin la llave de Apple no se hace nada y nada falla', async () => {
  assert.equal(puedeRevocarApple(), false);
  assert.equal(await guardarPermisoApple('cli-apple', 'codigo'), false);
  assert.equal(await revocarPermisoApple('algo'), false);
  assert.equal(llamadas.length, 0);
});

test('con la llave: el secreto va firmado como Apple lo pide', () => {
  process.env.APPLE_CLIENT_IDS = 'cl.feria.app';
  process.env.APPLE_TEAM_ID = 'EQUIPO1234';
  process.env.APPLE_KEY_ID = 'LLAVE12345';
  // Como llega en una variable de entorno: con los saltos escritos.
  process.env.APPLE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n');
  assert.equal(puedeRevocarApple(), true);

  const [cab, cuerpo, firma] = secretoDeCliente(1_800_000_000).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(cab, 'base64url').toString()), { alg: 'ES256', kid: 'LLAVE12345' });
  const c = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
  assert.equal(c.iss, 'EQUIPO1234');
  assert.equal(c.sub, 'cl.feria.app');
  assert.equal(c.aud, 'https://appleid.apple.com');
  assert.ok(c.exp - c.iat <= 600);
  const valida = createVerify('SHA256').update(`${cab}.${cuerpo}`)
    .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(firma, 'base64url'));
  assert.equal(valida, true);
});

test('al entrar se guarda el permiso, cifrado', async () => {
  assert.equal(await guardarPermisoApple('cli-apple', 'codigo-de-un-uso'), true);
  assert.equal(llamadas.at(-1)!.camino, 'token');
  assert.equal(llamadas.at(-1)!.campos.code, 'codigo-de-un-uso');
  const fila = await consultarUno<any>(`SELECT apple_permiso FROM clientes WHERE id = 'cli-apple'`);
  assert.ok(fila.apple_permiso && !fila.apple_permiso.includes('permiso-largo'), 'no queda en claro en la base');
  assert.equal(await permisoAppleDe('cli-apple'), 'permiso-largo-de-apple');
  assert.equal(descifrar(cifrar('hola')), 'hola');
  assert.equal(descifrar('basura'), null);
});

test('al eliminar la cuenta se le devuelve el permiso a Apple', async () => {
  const permiso = await permisoAppleDe('cli-apple');
  await eliminarCuentaCliente('cli-apple');
  assert.equal(await revocarPermisoApple(permiso), true);
  const ultima = llamadas.at(-1)!;
  assert.equal(ultima.camino, 'revoke');
  assert.equal(ultima.campos.token, 'permiso-largo-de-apple');
  assert.equal(ultima.campos.token_type_hint, 'refresh_token');
  assert.equal(ultima.campos.client_id, 'cl.feria.app');
  assert.equal(await consultarUno(`SELECT 1 FROM clientes WHERE id = 'cli-apple'`), undefined);
});

test('si Apple rechaza, se informa y no se rompe nada', async () => {
  appleResponde = false;
  assert.equal(await revocarPermisoApple('otro'), false);
  await ejecutar(`INSERT INTO clientes (id, nombre, apple_sub) VALUES ('cli-apple-2', 'Beto', 'sub-2')`);
  assert.equal(await guardarPermisoApple('cli-apple-2', 'codigo-vencido'), false);
  appleResponde = true;
});
