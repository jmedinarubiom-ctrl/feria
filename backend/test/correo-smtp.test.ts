/**
 * El envío por SMTP, contra un servidor de correo de mentira.
 *
 * No prueba a Gmail —eso necesita una cuenta de verdad— sino que el
 * correo sale bien armado, que se autentica, y que un rechazo se
 * convierte en un mensaje que se entiende.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

import { enviarCorreo, proveedorCorreo, fijarTransporteCorreo } from '../src/correo.ts';

let servidor: Server;
let recibidos: Array<{ de: string; para: string; cuerpo: string; usuario: string; clave: string }> = [];
let claveBuena = 'abcdefghijklmnop';

/** Un SMTP mínimo: saluda, pide usuario y clave, recibe un correo. */
function atender(s: Socket) {
  let de = ''; let para = ''; let usuario = ''; let clave = '';
  let modo: 'comandos' | 'usuario' | 'clave' | 'datos' = 'comandos';
  let cuerpo = ''; let resto = '';
  const di = (t: string) => s.write(t + '\r\n');
  di('220 correo.test listo');
  s.on('data', (d) => {
    resto += d.toString('utf8');
    for (;;) {
      if (modo === 'datos') {
        const fin = resto.indexOf('\r\n.\r\n');
        if (fin < 0) return;
        cuerpo = resto.slice(0, fin); resto = resto.slice(fin + 5);
        recibidos.push({ de, para, cuerpo, usuario, clave });
        modo = 'comandos'; di('250 recibido');
        continue;
      }
      const salto = resto.indexOf('\r\n');
      if (salto < 0) return;
      const linea = resto.slice(0, salto); resto = resto.slice(salto + 2);
      if (modo === 'usuario') {
        usuario = Buffer.from(linea, 'base64').toString(); modo = 'clave'; di('334 UGFzc3dvcmQ6');
      } else if (modo === 'clave') {
        clave = Buffer.from(linea, 'base64').toString(); modo = 'comandos';
        di(clave === claveBuena ? '235 adelante' : '535 5.7.8 Username and Password not accepted');
      } else if (/^EHLO/i.test(linea)) { s.write('250-correo.test\r\n250 AUTH LOGIN\r\n');
      } else if (/^AUTH LOGIN/i.test(linea)) { modo = 'usuario'; di('334 VXNlcm5hbWU6');
      } else if (/^MAIL FROM:/i.test(linea)) { de = linea; di('250 ok');
      } else if (/^RCPT TO:/i.test(linea)) { para = linea; di('250 ok');
      } else if (/^DATA/i.test(linea)) { modo = 'datos'; di('354 adelante');
      } else if (/^QUIT/i.test(linea)) { di('221 chao'); s.end();
      } else { di('250 ok'); }
    }
  });
  s.on('error', () => {});
}

const previo = { ...process.env };

before(async () => {
  servidor = createServer(atender);
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
});
after(async () => {
  process.env = previo;
  await new Promise((r) => servidor.close(r));
});
beforeEach(() => {
  recibidos = [];
  fijarTransporteCorreo(null);
  process.env.CORREO_SMTP_SERVIDOR = '127.0.0.1';
  process.env.CORREO_SMTP_PUERTO = String((servidor.address() as AddressInfo).port);
  process.env.CORREO_SMTP_USUARIO = 'feria@gmail.com';
  // Como la muestra Google: con espacios.
  process.env.CORREO_SMTP_CLAVE = 'abcd efgh ijkl mnop';
  delete process.env.CORREO_REMITENTE;
  delete process.env.RESEND_API_KEY;
});

test('con usuario y clave configurados, el correo sale por SMTP', async () => {
  assert.equal(proveedorCorreo(), 'smtp');

  const r = await enviarCorreo('camila@correo.cl', '418757 es tu código de la Feria',
    'Tu código para entrar a la Feria es 418757.');

  assert.deepEqual(r, { enviado: true, proveedor: 'smtp' });
  assert.equal(recibidos.length, 1);
  const c = recibidos[0];
  assert.match(c.para, /camila@correo\.cl/);
  assert.match(c.de, /feria@gmail\.com/);
  assert.equal(c.usuario, 'feria@gmail.com');
  assert.equal(c.clave, 'abcdefghijklmnop', 'la clave va sin los espacios con que la muestra Google');
  assert.match(c.cuerpo, /From: "?Feria App"? <feria@gmail\.com>/);
  assert.match(c.cuerpo, /418757/);
});

test('una clave equivocada no revienta: dice qué revisar', async () => {
  process.env.CORREO_SMTP_CLAVE = 'la clave normal de la cuenta';

  const r = await enviarCorreo('camila@correo.cl', 'Prueba', 'Hola');

  assert.equal(r.enviado, false);
  assert.match(r.detalle!, /contraseña de aplicación/);
  assert.equal(recibidos.length, 0);
});

test('si el servidor de correo no responde, se avisa en vez de quedarse esperando', async () => {
  process.env.CORREO_SMTP_PUERTO = '1';   // nadie escucha ahí
  const r = await enviarCorreo('camila@correo.cl', 'Prueba', 'Hola');
  assert.equal(r.enviado, false);
  assert.match(r.detalle!, /No se pudo conectar/);
});

test('sin nada configurado, el correo sale por consola', () => {
  delete process.env.CORREO_SMTP_USUARIO;
  assert.equal(proveedorCorreo(), 'consola');
});
