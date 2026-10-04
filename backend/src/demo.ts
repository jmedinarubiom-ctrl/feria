/**
 * Recorre el flujo completo contra la API HTTP real, narrando cada
 * paso. Sirve para ver el sistema funcionando sin abrir las apps.
 *
 *   node src/servidor.ts        (en una terminal)
 *   node src/demo.ts            (en otra)
 */

const BASE = process.env.FERIA_API ?? 'http://localhost:4000';

/**
 * Teléfonos de la semilla. Cada actor entra con el suyo y recibe su
 * propio token: no hay ningún token compartido que permita actuar
 * en nombre de otro.
 */
const TELEFONOS: Record<string, string> = {
  'f-jose': '+56911111111',
  'f-ana': '+56922222222',
  'f-carmen': '+56933333333',
  'f-luis': '+56944444444',
  'f-pedro': '+56966666666',
  'f-rosa': '+56977777777',
  'r-diego': '+56900000001',
  'r-sofia': '+56900000002',
  'operador': '+56900000009',
};

const tokens: Record<string, string> = {};

const clp = (n: number) => '$' + n.toLocaleString('es-CL');
const titulo = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m\n${'─'.repeat(t.length)}`);
const linea = (t: string) => console.log('  ' + t);

async function api(metodo: string, camino: string, opciones: { actor?: string; cuerpo?: any } = {}) {
  const token = opciones.actor ? tokens[opciones.actor] : undefined;
  const r = await fetch(BASE + camino, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: metodo === 'POST' ? JSON.stringify(opciones.cuerpo ?? {}) : undefined,
  });
  const cuerpo = await r.json();
  if (!r.ok) throw new Error(`${metodo} ${camino} → ${r.status}: ${cuerpo.error}`);
  return cuerpo;
}

/** Ingreso por SMS: pide el código y lo canjea por una sesión. */
async function entrar(actor: string): Promise<void> {
  const telefono = TELEFONOS[actor];
  const { codigoDev } = await api('POST', '/auth/codigo', { cuerpo: { telefono } });
  if (!codigoDev) throw new Error('El servidor no devolvió el código: ¿NODE_ENV=production?');
  const sesion = await api('POST', '/auth/sesion',
    { cuerpo: { telefono, codigo: codigoDev, dispositivo: 'demo' } });
  tokens[actor] = sesion.token;
}

// ------------------------------------------------------------

titulo('0. Todos entran con su teléfono');

for (const actor of Object.keys(TELEFONOS)) await entrar(actor);
linea(`${Object.keys(tokens).length} sesiones abiertas, una por persona.`);
linea('Cada token identifica a alguien concreto: nadie puede actuar por otro.');

titulo('1. El cliente hace un pedido mixto');

const pedido = await api('POST', '/pedidos', {
  cuerpo: {
    clienteNombre: 'Juan Manuel',
    clienteTelefono: '+56999999999',
    direccion: 'Subida Ecuador 123, Valparaíso',
    lat: -33.0458, lng: -71.6197,
    notas: 'Timbre roto, llamar por teléfono.',
    items: [
      { productoId: 'p-tomate', cantidad: 2 },
      { productoId: 'p-cebolla', cantidad: 1 },
      { productoId: 'p-palta', cantidad: 1 },
      { productoId: 'p-merluza', cantidad: 1 },
    ],
  },
});
linea(`Pedido #${pedido.numero} creado.`);

let vista = await api('GET', `/pedidos/${pedido.pedidoId}`);
linea(`Total cobrado al cliente: ${clp(vista.total_venta)}`);
linea(`Se partió en ${vista.subPedidos.length} sub-pedidos (uno por rubro):`);
for (const s of vista.subPedidos) {
  linea(`   · ${s.rubro.padEnd(22)} ${clp(s.monto_feriante).padStart(8)} al feriante  → ${s.estado}`);
}

// ------------------------------------------------------------

titulo('2. Les suena el teléfono a los feriantes');

for (const f of ['f-jose', 'f-carmen', 'f-pedro']) {
  const t = await api('GET', '/feriante/tablero', { actor: f });
  for (const o of t.ofertas) {
    const items = o.items.map((i: any) => `${i.cantidad}× ${i.nombre}`).join(', ');
    linea(`${t.feriante.nombre.padEnd(16)} recibe: ${items} — gana ${clp(o.monto_feriante)}`);
  }
}

// ------------------------------------------------------------

titulo('3. Dos aceptan, el pescado no lo toma nadie');

const verduras = vista.subPedidos.find((s: any) => s.rubro_id === 'verduras');
const frutas = vista.subPedidos.find((s: any) => s.rubro_id === 'frutas');
const pescado = vista.subPedidos.find((s: any) => s.rubro_id === 'pescado');

await api('POST', `/subpedidos/${verduras.id}/aceptar`, { actor: 'f-jose' });
linea('José Sandoval toma las verduras.');

try {
  await api('POST', `/subpedidos/${verduras.id}/aceptar`, { actor: 'f-luis' });
} catch (e: any) {
  linea(`Luis Ovalle llega tarde: ${e.message.split(': ').pop()}`);
}

await api('POST', `/subpedidos/${frutas.id}/aceptar`, { actor: 'f-carmen' });
linea('Carmen Vidal toma las frutas.');

await api('POST', `/subpedidos/${pescado.id}/rechazar`, { actor: 'f-pedro' });
await api('POST', `/subpedidos/${pescado.id}/rechazar`, { actor: 'f-rosa' });
linea('Las dos pescaderías dicen que no tienen.');
linea('La cascada se abre a toda la feria y nadie contesta…');

// Se fuerza el vencimiento de las rondas restantes para no esperar
// los 210 segundos reales de la cascada completa.
for (let i = 0; i < 3; i++) await api('POST', '/dev/vencer-ofertas');

vista = await api('GET', `/pedidos/${pedido.pedidoId}`);
const pescadoAhora = vista.subPedidos.find((s: any) => s.rubro_id === 'pescado');
linea(`El pescado queda en: \x1b[33m${pescadoAhora.estado}\x1b[0m  →  lo compras tú.`);

// ------------------------------------------------------------

titulo('4. Tu cola de autogestión');

const operador = await api('GET', '/operador/tablero', { actor: 'operador' });
for (const a of operador.autogestion) {
  const items = a.items.map((i: any) => `${i.cantidad}× ${i.nombre}`).join(', ');
  linea(`Pedido #${a.numero} — ${a.rubro}: ${items}  (costo ${clp(a.monto_feriante)})`);
}
linea(`Pedidos activos ahora mismo: ${operador.activos.length}`);

// ------------------------------------------------------------

titulo('5. Todos preparan y aparece el viaje');

await api('POST', `/subpedidos/${verduras.id}/listo`, { actor: 'f-jose' });
await api('POST', `/subpedidos/${frutas.id}/listo`, { actor: 'f-carmen' });
await api('POST', `/operador/autogestion/${pescado.id}/listo`, { actor: 'operador' });
linea('Verduras listas, frutas listas, pescado comprado por tú.');

const tableroRep = await api('GET', '/repartidor/tablero', { actor: 'r-diego' });
const viaje = tableroRep.disponibles[0];
linea(`Viaje disponible: ${viaje.retiros} retiros + entrega — paga ${clp(viaje.tarifa)}`);

await api('POST', `/viajes/${viaje.id}/aceptar`, { actor: 'r-diego' });
linea('Diego Araya lo toma.');

try {
  await api('POST', `/viajes/${viaje.id}/aceptar`, { actor: 'r-sofia' });
} catch (e: any) {
  linea(`Sofía Bustos llega tarde: ${e.message.split(': ').pop()}`);
}

// ------------------------------------------------------------

titulo('6. La ruta de Diego');

const activo = await api('GET', '/repartidor/tablero', { actor: 'r-diego' });
for (const p of activo.viajeActivo.paradas) {
  const items = p.items.map((i: any) => `${i.cantidad}× ${i.nombre}`).join(', ');
  linea(`${p.orden + 1}. [${p.tipo}] ${p.etiqueta}${items ? `\n        retira: ${items}` : ''}`);
}

for (const p of activo.viajeActivo.paradas) {
  await api('POST', `/paradas/${p.id}/completar`, { actor: 'r-diego' });
  await api('POST', '/repartidor/ubicacion', {
    actor: 'r-diego', cuerpo: { lat: -33.048 + Math.random() * 0.003, lng: -71.615 },
  });
  const v = await api('GET', `/pedidos/${pedido.pedidoId}`);
  linea(`   ✓ completada → pedido en estado ${v.estado}`);
}

// ------------------------------------------------------------

titulo('7. La tarde: a quién le pagas y cuánto');

const cierre = await api('GET', '/operador/tablero', { actor: 'operador' });
for (const f of cierre.liquidaciones.feriantes) {
  linea(`${f.nombre.padEnd(16)} ${f.puesto.padEnd(26)} ${String(f.cantidad).padStart(2)} ${f.cantidad === 1 ? 'bolsa ' : 'bolsas'}   ${clp(f.total).padStart(8)}`);
}
linea(`${''.padEnd(16)} ${''.padEnd(26)}          TOTAL ${clp(cierre.liquidaciones.totalAPagar).padStart(8)}`);

await api('POST', '/operador/liquidaciones/f-jose/pagar', { actor: 'operador' });
const conf = await api('POST', '/feriante/liquidacion/confirmar', { actor: 'f-jose' });
const hora = new Intl.DateTimeFormat('es-CL', {
  timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit',
}).format(new Date(conf.confirmadoAt));
linea(`\n  Le pagaste a José: ${clp(conf.total)} — él confirmó en su app a las ${hora}`);

// ------------------------------------------------------------

titulo('8. Cómo te fue hoy');

const m = cierre.metricas;
const pct = (v: number | null) => (v === null ? 's/d' : (v * 100).toFixed(0) + '%');
linea(`Pedidos: ${m.pedidos.total}   ·   Venta: ${clp(m.pedidos.venta)}`);
linea(`Ofertas enviadas: ${m.ofertas.enviadas}  (aceptadas ${m.ofertas.aceptadas}, rechazadas ${m.ofertas.rechazadas}, vencidas ${m.ofertas.vencidas})`);
linea(`Tasa de aceptación: ${pct(m.ofertas.tasaAceptacion)}`);
linea(`\x1b[33mTrabajo que terminaste haciendo tú: ${pct(m.subPedidos.tasaAutogestion)}\x1b[0m`);
linea('');
linea('Ese último número es el que decide si esto es un negocio o un empleo.');
console.log();
