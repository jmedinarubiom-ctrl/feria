import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirDB, cerrarDB, consultarUno, ejecutar, type Fila } from '../src/db/index.ts';
import { FERIA_ID } from '../src/db/semilla.ts';
import { limpiarYSembrar } from './ayuda.ts';
import { crearPedido } from '../src/dominio/despacho.ts';
import {
  iniciarPago, confirmarDesdePasarela, fijarPasarela, olvidarPasarela, pasarela,
  revisarCobro, revisarCobrosAbiertos, ErrorPago,
} from '../src/dominio/pagos.ts';
import {
  crearPasarelaMercadoPago, fijarTransporteMP, restaurarTransporteMP, pagoAvisado, esPublica,
} from '../src/pagos/mercadopago.ts';
import { cancelarPedido } from '../src/dominio/cancelacion.ts';

/**
 * Mercado Pago.
 *
 * Lo que se prueba no es el camino feliz —ese lo prueba Mercado
 * Pago— sino lo que pasa cuando el aviso miente, cuando el monto no
 * coincide y cuando el pago todavía no se define. Son los casos que
 * terminan despachando mercadería que nadie pagó.
 */

const CFG = {
  accessToken: 'APP_USR-llave-de-un-usuario-de-prueba',
  base: 'https://api.mercadopago.test',
  urlNotificacion: 'https://feria.cl/webhooks/mercadopago',
  urlRetorno: 'https://feria.cl/pagos/retorno',
  publica: true,
};

const CARRO = [{ productoId: 'p-tomate', cantidad: 4 }];
const base = () => ({
  feriaId: FERIA_ID,
  clienteNombre: 'Camila Rojas',
  clienteTelefono: '+56987654321',
  clienteEmail: 'camila@correo.cl',
  direccion: 'Pedro Montt 2200',
  lat: -33.0458, lng: -71.6197,
  items: CARRO,
});

/** Mercado Pago de mentira. */
let preferencias: any[] = [];
let pagos: Record<string, any> = {};
let reembolsos: any[] = [];
let cabecerasVistas: Record<string, string>[] = [];
/** Qué devuelve la búsqueda por orden de comercio. */
let busquedas: Record<string, any> = {};

before(async () => {
  await abrirDB({ memoria: true });
  fijarPasarela(crearPasarelaMercadoPago(CFG));
  fijarTransporteMP(async (url, { metodo, cuerpo, cabeceras }) => {
    cabecerasVistas.push(cabeceras);
    if (url.endsWith('/checkout/preferences')) {
      preferencias.push(cuerpo);
      return {
        id: 'pref-123',
        init_point: 'https://mp.cl/pagar/prod',
        sandbox_init_point: 'https://mp.cl/pagar/sandbox',
      };
    }
    if (url.includes('/v1/payments/search')) {
      const orden = new URL(url).searchParams.get('external_reference')!;
      const r = busquedas[orden];
      if (r === 'explota') throw new Error('Mercado Pago: se cayó');
      return { results: r ?? [] };
    }
    const refund = /\/v1\/payments\/([^/]+)\/refunds$/.exec(url);
    if (refund && metodo === 'POST') {
      reembolsos.push({ pago: refund[1], cuerpo });
      return { id: 'refund-1', status: 'approved' };
    }
    const consulta = /\/v1\/payments\/([^/]+)$/.exec(url);
    if (consulta) {
      const p = pagos[consulta[1]];
      if (!p) throw new Error('Mercado Pago: Payment not found');
      return p;
    }
    throw new Error('ruta inesperada: ' + url);
  });
});

after(async () => { restaurarTransporteMP(); fijarPasarela(null); await cerrarDB(); });

beforeEach(async () => {
  await limpiarYSembrar();
  preferencias = []; pagos = {}; reembolsos = []; cabecerasVistas = []; busquedas = {};
});

/** Deja listo un pago iniciado y devuelve con qué consultarlo. */
async function pedidoConCobro() {
  const { pedidoId, numero } = await crearPedido(base());
  const { url, pagoId } = await iniciarPago(pedidoId, 'camila@correo.cl');
  const fila = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  return { pedidoId, numero, url, pagoId, orden: fila!.orden_comercio };
}

// ============================================================

test('con MP_SANDBOX usa el checkout viejo de sandbox', async () => {
  // Las credenciales antiguas con prefijo TEST- necesitan la otra
  // dirección. Se elige por configuración, no adivinando del token:
  // MP dejó de usar el prefijo y la adivinanza quedó siempre falsa.
  fijarPasarela(crearPasarelaMercadoPago({ ...CFG, sandboxViejo: true }));
  try {
    const { url } = await pedidoConCobro();
    assert.equal(url, 'https://mp.cl/pagar/sandbox');
  } finally {
    fijarPasarela(crearPasarelaMercadoPago(CFG));
  }
});

test('crea la preferencia y manda al cliente al checkout', async () => {
  const { url, pagoId, orden } = await pedidoConCobro();

  assert.equal(preferencias.length, 1);
  const p = preferencias[0];
  assert.equal(p.items[0].unit_price, 11300, 'el monto que paga el cliente');
  assert.equal(p.items[0].currency_id, 'CLP');
  assert.equal(p.external_reference, orden, 'el hilo con nuestro pedido');
  assert.equal(p.notification_url, CFG.urlNotificacion);
  assert.equal(p.payment_methods.installments, 1, 'sin cuotas: el margen no las aguanta');

  // Lo que hace que el cobro sea de prueba son las credenciales, no
  // la dirección: con un usuario de prueba se usa el checkout normal.
  assert.equal(url, 'https://mp.cl/pagar/prod');
  assert.match(cabecerasVistas[0].authorization, /^Bearer APP_USR-/);

  const fila = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  assert.equal(fila!.proveedor, 'mercadopago');
  assert.equal(fila!.referencia_externa, 'pref-123');
  assert.equal(fila!.estado, 'INICIADO');
});

test('el pedido no sale a la feria hasta que Mercado Pago confirma', async () => {
  const { pedidoId } = await pedidoConCobro();
  const antes = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(antes!.estado, 'PENDIENTE_PAGO', 'nadie prepara mercadería de algo sin pagar');
});

test('un pago aprobado despacha el pedido y guarda el medio', async () => {
  const { pedidoId, orden } = await pedidoConCobro();
  pagos['pay-900'] = {
    id: 'pay-900', status: 'approved', external_reference: orden,
    transaction_amount: 11300, payment_type_id: 'bank_transfer',
    payment_method_id: 'webpay', status_detail: 'accredited',
  };

  const r = await confirmarDesdePasarela('pay-900');
  assert.equal(r.pagado, true);

  const pedido = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.notEqual(pedido!.estado, 'PENDIENTE_PAGO', 'ya salió a la feria');

  const pago = await consultarUno<Fila>(
    'SELECT * FROM pagos WHERE orden_comercio = ?', orden);
  assert.equal(pago!.estado, 'PAGADO');
  assert.equal(pago!.medio, 'transferencia');
  assert.equal(pago!.referencia_externa, 'pay-900',
    'se guarda el id del pago, no el de la preferencia: el reembolso va contra ese');
});

test('un monto distinto al del pedido no despacha nada', async () => {
  // El caso que importa: alguien manipuló el checkout y pagó menos.
  const { pedidoId, orden } = await pedidoConCobro();
  pagos['pay-901'] = {
    id: 'pay-901', status: 'approved', external_reference: orden,
    transaction_amount: 1000, payment_type_id: 'credit_card',
  };

  await assert.rejects(() => confirmarDesdePasarela('pay-901'),
    (e: ErrorPago) => e.codigo === 409);

  const pedido = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.equal(pedido!.estado, 'PENDIENTE_PAGO');
});

test('un pago pendiente no se da por rechazado', async () => {
  // Una transferencia en curso todavía puede llegar. Cerrarla acá
  // sería perder la venta por adelantarse.
  const { orden } = await pedidoConCobro();
  pagos['pay-902'] = {
    id: 'pay-902', status: 'pending', external_reference: orden,
    transaction_amount: 11300, payment_type_id: 'bank_transfer',
  };

  const r = await confirmarDesdePasarela('pay-902');
  assert.equal(r.pagado, false);

  const pago = await consultarUno<Fila>('SELECT estado FROM pagos WHERE orden_comercio = ?', orden);
  assert.equal(pago!.estado, 'INICIADO', 'sigue abierto, MP vuelve a avisar');
});

test('un pago rechazado cierra el cobro', async () => {
  const { orden } = await pedidoConCobro();
  pagos['pay-903'] = {
    id: 'pay-903', status: 'rejected', external_reference: orden,
    transaction_amount: 11300, status_detail: 'cc_rejected_insufficient_amount',
  };

  const r = await confirmarDesdePasarela('pay-903');
  assert.equal(r.pagado, false);

  const pago = await consultarUno<Fila>('SELECT estado FROM pagos WHERE orden_comercio = ?', orden);
  assert.equal(pago!.estado, 'RECHAZADO');
});

test('un aviso de un pago que no conocemos no rompe nada', async () => {
  // Cualquiera puede golpear el webhook con un id inventado.
  pagos['pay-ajeno'] = {
    id: 'pay-ajeno', status: 'approved', external_reference: 'feria-9999-aaaa',
    transaction_amount: 999999,
  };
  await assert.rejects(() => confirmarDesdePasarela('pay-ajeno'),
    (e: ErrorPago) => e.codigo === 404);
});

test('confirmar dos veces el mismo pago no despacha dos veces', async () => {
  // MP reintenta el aviso: tiene que ser idempotente.
  const { orden } = await pedidoConCobro();
  pagos['pay-904'] = {
    id: 'pay-904', status: 'approved', external_reference: orden,
    transaction_amount: 11300, payment_type_id: 'account_money',
  };

  const a = await confirmarDesdePasarela('pay-904');
  const b = await confirmarDesdePasarela('pay-904');
  assert.equal(a.pagado, true);
  assert.equal(b.pagado, true);

  const n = await consultarUno<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM eventos
      WHERE entidad = 'pago' AND tipo = 'pagado'`);
  assert.equal(n!.n, 1, 'un solo evento de pago');
});

test('el reembolso va contra el pago, no contra la preferencia', async () => {
  const { pedidoId, orden } = await pedidoConCobro();
  pagos['pay-905'] = {
    id: 'pay-905', status: 'approved', external_reference: orden,
    transaction_amount: 11300, payment_type_id: 'credit_card',
  };
  await confirmarDesdePasarela('pay-905');

  const r = await cancelarPedido({ pedidoId, motivo: 'se acabó el tomate' });
  assert.equal(r.reembolso.solicitado, true);
  assert.equal(reembolsos.length, 1);
  assert.equal(reembolsos[0].pago, 'pay-905', 'no "pref-123"');
  assert.equal(reembolsos[0].cuerpo.amount, 11300);

  // Reintentar no puede devolver dos veces.
  const clave = cabecerasVistas.at(-1)!['X-Idempotency-Key'];
  assert.ok(clave && clave.includes(orden), 'la devolución lleva clave de idempotencia');
});

test('no se reembolsa por una pasarela distinta a la que cobró', async () => {
  // Si se cambió de pasarela entre el cobro y la cancelación, hacer
  // el reembolso por la nueva no devuelve nada y oculta el problema.
  const { pedidoId, orden } = await pedidoConCobro();
  pagos['pay-906'] = {
    id: 'pay-906', status: 'approved', external_reference: orden,
    transaction_amount: 11300, payment_type_id: 'credit_card',
  };
  await confirmarDesdePasarela('pay-906');
  await ejecutar(`UPDATE pagos SET proveedor = 'flow' WHERE orden_comercio = ?`, orden);

  const r = await cancelarPedido({ pedidoId, motivo: 'prueba' });
  assert.equal(reembolsos.length, 0, 'no se llamó a Mercado Pago');
  assert.equal(r.reembolso.motivo, 'anotado sin pasarela');
});

// ============================================================
// El aviso de Mercado Pago
// ============================================================

test('reconoce el aviso de pago en todos sus formatos', () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.equal(pagoAvisado(q('type=payment&data.id=123'), {}), '123');
  assert.equal(pagoAvisado(q('topic=payment&id=456'), {}), '456');
  assert.equal(pagoAvisado(q(''), { type: 'payment', data: { id: 789 } }), '789');
  assert.equal(pagoAvisado(q(''), { topic: 'payment', id: '321' }), '321');
});

test('ignora los avisos que no son de un pago', () => {
  const q = (s: string) => new URLSearchParams(s);
  // MP avisa de planes, facturas y contracargos por el mismo webhook.
  assert.equal(pagoAvisado(q('type=plan&data.id=1'), {}), null);
  assert.equal(pagoAvisado(q('topic=merchant_order&id=1'), {}), null);
  assert.equal(pagoAvisado(q(''), {}), null);
  // Y un id que no es un número no se le pasa a la API.
  assert.equal(pagoAvisado(q('type=payment&data.id=../../admin'), {}), null);
  assert.equal(pagoAvisado(q('type=payment&data.id='), {}), null);
});

// ============================================================
// Revisión sin webhook
// ============================================================

test('sin webhook, el cobro se confirma igual preguntando', async () => {
  // El caso de desarrollo —y el de producción cuando MP deshabilita
  // el aviso—: nadie avisa, y el cliente ya pagó.
  const { pedidoId, orden, pagoId } = await pedidoConCobro();
  pagos['pay-910'] = {
    id: 'pay-910', status: 'approved', external_reference: orden,
    transaction_amount: 11300, payment_type_id: 'account_money',
  };
  busquedas[orden] = [pagos['pay-910']];

  const r = await revisarCobro(pagoId);
  assert.equal(r.pagado, true, 'lo encontró por la orden de comercio');

  const pedido = await consultarUno<Fila>('SELECT estado FROM pedidos WHERE id = ?', pedidoId);
  assert.notEqual(pedido!.estado, 'PENDIENTE_PAGO');
});

test('si hubo varios intentos se queda con el aprobado', async () => {
  // Tarjeta rechazada y después transferencia: el pago bueno es el
  // segundo, aunque no sea el más reciente en la lista.
  const { orden, pagoId } = await pedidoConCobro();
  busquedas[orden] = [
    { id: 'pay-malo', status: 'rejected', external_reference: orden, transaction_amount: 11300 },
    { id: 'pay-bueno', status: 'approved', external_reference: orden,
      transaction_amount: 11300, payment_type_id: 'bank_transfer' },
  ];
  pagos['pay-bueno'] = busquedas[orden][1];

  const r = await revisarCobro(pagoId);
  assert.equal(r.pagado, true);
  const pago = await consultarUno<Fila>('SELECT * FROM pagos WHERE id = ?', pagoId);
  assert.equal(pago!.referencia_externa, 'pay-bueno');
});

test('un cobro que nadie pagó sigue abierto', async () => {
  const { pagoId } = await pedidoConCobro();
  const r = await revisarCobro(pagoId);
  assert.equal(r.pagado, false);
  const pago = await consultarUno<Fila>('SELECT estado FROM pagos WHERE id = ?', pagoId);
  assert.equal(pago!.estado, 'INICIADO', 'no se cierra por no encontrarlo todavía');
});

test('la revisión en lote no se frena porque uno falle', async () => {
  const a = await pedidoConCobro();
  const b = await pedidoConCobro();
  // El primero revienta al buscarlo; el segundo está pagado.
  busquedas[a.orden] = 'explota';
  pagos['pay-911'] = {
    id: 'pay-911', status: 'approved', external_reference: b.orden,
    transaction_amount: 11300, payment_type_id: 'credit_card',
  };
  busquedas[b.orden] = [pagos['pay-911']];

  // Los cobros recién creados no se miran: el cliente todavía está
  // en el checkout. Con `desdeSegundos: 0` se fuerza la revisión.
  const r = await revisarCobrosAbiertos({ desdeSegundos: 0 });
  assert.equal(r.confirmados, 1, 'el que sí estaba pagado se confirmó');

  const pagoB = await consultarUno<Fila>('SELECT estado FROM pagos WHERE id = ?', b.pagoId);
  assert.equal(pagoB!.estado, 'PAGADO');
});

test('no revisa un cobro recién creado', async () => {
  // Mientras el cliente está en el checkout no hay nada que
  // preguntar, y preguntarlo cuesta una llamada a la API por vuelta.
  await pedidoConCobro();
  const r = await revisarCobrosAbiertos();
  assert.equal(r.revisados, 0);
});

test('sin credenciales, en desarrollo se puede seguir probando', async () => {
  // Un `.env` con PASARELA=mercadopago y el token todavía vacío es
  // exactamente lo que tiene alguien que recién clona el proyecto.
  // Reventar ahí no deja probar nada.
  const previo = { ...process.env };
  try {
    fijarPasarela(null); olvidarPasarela();
    process.env.PASARELA = 'mercadopago';
    delete process.env.MP_ACCESS_TOKEN;
    delete process.env.FLOW_API_KEY;
    process.env.NODE_ENV = 'development';

    assert.equal(pasarela(), null, 'avisa y sigue');

    const { pedidoId } = await crearPedido(base());
    const { pagoId } = await iniciarPago(pedidoId, 'c@c.cl');
    assert.ok(pagoId, 'el pedido se puede recorrer igual');
  } finally {
    process.env = previo;
    olvidarPasarela();
    fijarPasarela(crearPasarelaMercadoPago(CFG));
  }
});

test('sin credenciales, en producción es un error y no un pedido gratis', async () => {
  const previo = { ...process.env };
  try {
    fijarPasarela(null); olvidarPasarela();
    process.env.PASARELA = 'mercadopago';
    delete process.env.MP_ACCESS_TOKEN;
    process.env.NODE_ENV = 'production';

    assert.throws(() => pasarela(), (e: ErrorPago) => e.codigo === 503);
  } finally {
    process.env = previo;
    olvidarPasarela();
    fijarPasarela(crearPasarelaMercadoPago(CFG));
  }
});

test('con URL de localhost no manda lo que Mercado Pago rechaza', async () => {
  // El error real: con `back_urls` apuntando a localhost, MP
  // contesta «auto_return invalid» y no se puede cobrar nada. En
  // desarrollo se omiten y el cobro funciona igual.
  fijarPasarela(crearPasarelaMercadoPago({
    ...CFG, urlRetorno: 'http://localhost:4000/pagos/retorno',
    urlNotificacion: 'http://localhost:4000/webhooks/mercadopago', publica: false,
  }));
  try {
    await pedidoConCobro();
    const p = preferencias.at(-1)!;
    assert.equal(p.auto_return, undefined);
    assert.equal(p.back_urls, undefined);
    assert.equal(p.notification_url, undefined);
  } finally {
    fijarPasarela(crearPasarelaMercadoPago(CFG));
  }
});

test('con un dominio de verdad sí los manda', async () => {
  fijarPasarela(crearPasarelaMercadoPago({ ...CFG, publica: true }));
  try {
    await pedidoConCobro();
    const p = preferencias.at(-1)!;
    assert.equal(p.auto_return, 'approved');
    assert.equal(p.back_urls.success, CFG.urlRetorno);
    assert.equal(p.notification_url, CFG.urlNotificacion);
  } finally {
    fijarPasarela(crearPasarelaMercadoPago(CFG));
  }
});

test('distingue una dirección pública de una local', () => {
  for (const u of ['https://feria.cl', 'https://api.feria.cl/x']) {
    assert.equal(esPublica(u), true, u);
  }
  // Una IP de la red local tampoco le sirve a Mercado Pago.
  for (const u of ['http://localhost:4000', 'http://127.0.0.1:4000',
                   'http://192.168.1.26:4000', 'http://10.0.0.5', 'no-es-una-url']) {
    assert.equal(esPublica(u), false, u);
  }
});

test('la dirección pública se normaliza venga como venga', async () => {
  // Render entrega el host pelado, sin esquema. Sin normalizarlo el
  // webhook queda apuntando a una dirección inválida y los pagos no
  // se confirman solos — y eso solo se descubre en producción.
  const previo = { ...process.env };
  try {
    for (const [entrada, esperada] of [
      ['feria.onrender.com', 'https://feria.onrender.com'],
      ['https://feria.cl', 'https://feria.cl'],
      ['https://feria.cl/', 'https://feria.cl'],
      ['http://localhost:4000', 'http://localhost:4000'],
    ] as const) {
      process.env.URL_PUBLICA = entrada;
      const { CONFIG } = await import(`../src/config.ts?v=${encodeURIComponent(entrada)}`);
      assert.equal(CONFIG.urlPublica, esperada, entrada);
    }
  } finally {
    process.env = previo;
  }
});
