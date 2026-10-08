import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDB, cerrarDB, consultarUno, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import {
  avisoAlCliente, avisosDeCancelacion, avisosDeRetiro, enviarRecordatorios,
  fijarTransporte, restaurarTransporte, type MensajePush,
} from '../src/realtime/push.ts';

const enviados: MensajePush[] = [];

before(async () => {
  await abrirDB({ memoria: true });
  await sembrar();
  fijarTransporte(async (lote) => { enviados.push(...lote); return { data: lote.map(() => ({ status: 'ok' })) } as any; });
  const feria = await consultarUno<{ id: string }>('SELECT id FROM ferias ORDER BY id LIMIT 1');
  await ejecutar(`UPDATE feriantes SET push_token = 'tok-jose' WHERE id = 'f-jose'`);
  const rep = await consultarUno<{ id: string }>('SELECT id FROM repartidores ORDER BY id LIMIT 1');
  await ejecutar(`UPDATE repartidores SET push_token = 'tok-rep' WHERE id = ?`, rep!.id);
  await ejecutar(`INSERT INTO clientes (id, nombre, telefono, push_token) VALUES ('cli-a', 'Ana', '+56987650031', 'tok-ana')`);
  const pedido = (id: string, estado: string, hace: string) => ejecutar(
    `INSERT INTO pedidos (id, feria_id, cliente_id, cliente_nombre, cliente_telefono, direccion, lat, lng,
                          total_productos, costo_despacho, total_venta, estado, creado_at)
     VALUES (?, ?, 'cli-a', 'Ana', '+56987650031', 'Calle 1', -33.04, -71.61, 9000, 2000, 11000, ?, now() - ?::interval)`,
    id, feria!.id, estado, hace);
  await pedido('ped-reciente', 'PENDIENTE_PAGO', '2 minutes');
  await pedido('ped-olvidado', 'PENDIENTE_PAGO', '10 minutes');
  await pedido('ped-curso', 'EN_PREPARACION', '40 minutes');
  await ejecutar(
    `INSERT INTO sub_pedidos (id, pedido_id, rubro_id, estado, monto_feriante, feriante_id, aceptado_at)
     VALUES ('sub-lento', 'ped-curso', 'verduras', 'ACEPTADO', 2000, 'f-jose', now() - interval '25 minutes')`);
  await ejecutar(
    `INSERT INTO viajes (id, pedido_id, repartidor_id, estado, tarifa, creado_at)
     VALUES ('via-quieto', 'ped-curso', ?, 'ASIGNADO', 2500, now() - interval '30 minutes')`, rep!.id);
});
after(async () => { restaurarTransporte(); await cerrarDB(); });

test('recordatorios: pago olvidado, pedido sin marcar listo y viaje sin retirar; una sola vez', async () => {
  assert.equal(await enviarRecordatorios(), 3);
  const titulos = enviados.map((m) => `${m.to}: ${m.title}`);
  assert.ok(titulos.some((t) => t.startsWith('tok-ana') && /espera el pago/.test(t)), titulos.join(' | '));
  assert.ok(titulos.some((t) => t.startsWith('tok-jose') && /Está listo/.test(t)));
  assert.ok(titulos.some((t) => t.startsWith('tok-rep') && /te espera en la feria/.test(t)));
  // El pedido recién hecho todavía no se recuerda.
  assert.equal(enviados.filter((m) => /espera el pago/.test(m.title)).length, 1);

  enviados.length = 0;
  assert.equal(await enviarRecordatorios(), 0, 'al minuto siguiente no insiste');
  assert.equal(enviados.length, 0);
});

test('al cancelar se avisa al feriante que lo tenía y al repartidor del viaje', async () => {
  const avisos = await avisosDeCancelacion(
    { tipo: 'pedido:cancelado', pedidoId: 'ped-curso', numero: 1234, ferianteIds: ['f-jose', 'f-sin-token'] });
  assert.deepEqual(avisos.map((a) => a.to).sort(), ['tok-jose', 'tok-rep']);
  assert.match(avisos.find((a) => a.to === 'tok-jose')!.body, /No lo sigas preparando/);
  assert.match(avisos.find((a) => a.to === 'tok-rep')!.body, /No sigas la ruta/);
});

test('cuando un repartidor toma el viaje, el puesto sabe quién va a retirar', async () => {
  const rep = await consultarUno<{ id: string; nombre: string }>('SELECT id, nombre FROM repartidores ORDER BY id LIMIT 1');
  const avisos = await avisosDeRetiro({ tipo: 'viaje:cambio', viajeId: 'via-quieto', estado: 'ASIGNADO', repartidorId: rep!.id });
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].to, 'tok-jose');
  assert.ok(avisos[0].title.startsWith(rep!.nombre.split(' ')[0]));
  // Otros cambios del viaje no avisan a los puestos.
  assert.equal((await avisosDeRetiro({ tipo: 'viaje:cambio', viajeId: 'via-quieto', estado: 'EN_RUTA', repartidorId: rep!.id })).length, 0);
});

test('al comprador también se le avisa cuando el pedido vence sin pago', async () => {
  const a = await avisoAlCliente('ped-olvidado', 'EXPIRADO');
  assert.equal(a?.to, 'tok-ana');
  assert.match(a!.title, /venció/);
});
