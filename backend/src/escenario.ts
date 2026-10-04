/**
 * Deja la feria con pedidos en distintos estados, para poder abrir
 * cualquier rol y ver algo real en vez de pantallas vacías.
 *
 *   node src/escenario.ts
 */

const BASE = process.env.FERIA_API ?? 'http://localhost:4000';

const TELEFONOS: Record<string, string> = {
  'f-jose': '+56911111111',
  'f-ana': '+56922222222',
  'f-carmen': '+56933333333',
  'f-pedro': '+56966666666',
  'r-diego': '+56900000001',
  'operador': '+56900000009',
};
const tokens: Record<string, string> = {};

async function api(metodo: string, camino: string, o: { actor?: string; cuerpo?: any } = {}) {
  const token = o.actor ? tokens[o.actor] : undefined;
  const r = await fetch(BASE + camino, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: metodo === 'POST' ? JSON.stringify(o.cuerpo ?? {}) : undefined,
  });
  const cuerpo = await r.json();
  if (!r.ok) throw new Error(`${metodo} ${camino} → ${r.status}: ${cuerpo.error}`);
  return cuerpo;
}

async function entrar(actor: string) {
  const telefono = TELEFONOS[actor];
  const { codigoDev } = await api('POST', '/auth/codigo', { cuerpo: { telefono } });
  const s = await api('POST', '/auth/sesion',
    { cuerpo: { telefono, codigo: codigoDev, dispositivo: 'escenario' } });
  tokens[actor] = s.token;
}

/** Crea un pedido y lo deja pagado, listo para ofertarse. */
async function pedir(items: Array<{ productoId: string; cantidad: number }>) {
  const p = await api('POST', '/pedidos', {
    cuerpo: {
      clienteNombre: 'Juan Manuel',
      clienteTelefono: '+56999999999',
      clienteEmail: 'juan@correo.cl',
      direccion: 'Subida Ecuador 123, Valparaíso',
      lat: -33.0458, lng: -71.6197,
      notas: 'Timbre roto, llamar por teléfono.',
      items,
    },
  });
  const pago = await api('POST', '/pagos/iniciar',
    { cuerpo: { pedidoId: p.pedidoId, email: 'juan@correo.cl' } });
  if (pago.pagoId) await api('POST', `/dev/pagar/${pago.pagoId}`);
  return p;
}

const ofertaDe = async (actor: string, rubro: string) => {
  const t = await api('GET', '/feriante/tablero', { actor });
  return t.ofertas.find((o: any) => o.rubro_id === rubro);
};

// ------------------------------------------------------------

for (const a of Object.keys(TELEFONOS)) await entrar(a);

// 1) Uno esperando que alguien lo tome: José y Ana ven la oferta viva.
await pedir([{ productoId: 'p-tomate', cantidad: 4 }]);

// 2) Uno tomado y preparado: le deja un viaje disponible a Diego.
const b = await pedir([{ productoId: 'p-palta', cantidad: 2 }]);
const oB = await ofertaDe('f-carmen', 'frutas');
if (oB) {
  await api('POST', `/subpedidos/${oB.sub_pedido_id}/aceptar`, { actor: 'f-carmen' });
  await api('POST', `/subpedidos/${oB.sub_pedido_id}/listo`, { actor: 'f-carmen' });
}

// 3) Uno entregado: pone plata en las liquidaciones de la tarde.
const c = await pedir([{ productoId: 'p-merluza', cantidad: 2 }]);
const oC = await ofertaDe('f-pedro', 'pescado');
if (oC) {
  await api('POST', `/subpedidos/${oC.sub_pedido_id}/aceptar`, { actor: 'f-pedro' });
  await api('POST', `/subpedidos/${oC.sub_pedido_id}/listo`, { actor: 'f-pedro' });
  const tab = await api('GET', '/repartidor/tablero', { actor: 'r-diego' });
  const viaje = tab.disponibles.find((v: any) => v.numero === c.numero);
  if (viaje) {
    await api('POST', `/viajes/${viaje.id}/aceptar`, { actor: 'r-diego' });
    const activo = await api('GET', '/repartidor/tablero', { actor: 'r-diego' });
    for (const p of activo.viajeActivo.paradas) {
      await api('POST', `/paradas/${p.id}/completar`, { actor: 'r-diego' });
    }
  }
}

// 4) Uno que nadie tomó: aparece en tu cola de autogestión.
await pedir([{ productoId: 'p-huevos', cantidad: 3 }]);
for (let i = 0; i < 3; i++) await api('POST', '/dev/vencer-ofertas');

// ------------------------------------------------------------

const t = await api('GET', '/operador/tablero', { actor: 'operador' });
const clp = (n: number) => '$' + Math.round(n).toLocaleString('es-CL');

console.log(`
  La feria quedó así:

    · 1 pedido ofertándose        → José y Ana tienen una oferta viva
    · 1 preparado                 → Diego tiene un viaje disponible
    · 1 entregado                 → Pedro tiene ${clp(t.liquidaciones.totalAPagar)} por cobrar
    · ${t.autogestion.length} en autogestión            → te toca ir a comprarlo

  Entra con estos teléfonos (el código sale en la consola del backend
  y también en la propia pantalla):

    José Sandoval  (verduras)   +56 9 1111 1111
    Carmen Vidal   (frutas)     +56 9 3333 3333
    Pedro Cáceres  (pescado)    +56 9 6666 6666
    Diego Araya    (repartidor) +56 9 0000 0001
    Tú            (operador)   +56 9 0000 0009
`);
