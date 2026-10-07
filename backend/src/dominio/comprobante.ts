import { consultar, consultarUno, ejecutar, type Fila } from '../db/index.ts';
import { bus } from '../realtime/bus.ts';
import { enviarCorreo, plantillaCorreo } from '../correo.ts';
import { CONFIG } from '../config.ts';

/**
 * El correo de respaldo de un pedido pagado.
 *
 * No es la boleta —esa es del SII y va por otro camino—: es el
 * detalle de lo que pidió y a dónde va, para que el cliente tenga
 * algo en su correo si la app no abre o cambia de teléfono.
 */
const plata = (n: number): string => '$' + Math.round(n).toLocaleString('es-CL');
const limpio = (t: unknown): string =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function enviarComprobante(pedidoId: string): Promise<boolean> {
  const pedido = await consultarUno<Fila>(
    `SELECT p.*, c.correo_ingreso, c.email AS correo_perfil,
            (SELECT fe.nombre FROM ferias fe WHERE fe.id = p.feria_id) AS feria_nombre
       FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id
      WHERE p.id = ?`, pedidoId);
  if (!pedido) return false;
  const destino = pedido.cliente_email ?? pedido.correo_ingreso ?? pedido.correo_perfil;
  if (!destino) return false;

  // El candado va antes del envío: dos confirmaciones del mismo
  // pago no pueden mandar dos correos.
  const mio = await ejecutar(
    'UPDATE pedidos SET comprobante_at = now() WHERE id = ? AND comprobante_at IS NULL', pedidoId);
  if (mio.afectadas !== 1) return false;

  const items = await consultar<Fila>(
    `SELECT i.nombre, i.formato, i.cantidad, i.precio_venta
       FROM items i JOIN sub_pedidos s ON s.id = i.sub_pedido_id
      WHERE s.pedido_id = ? ORDER BY i.nombre`, pedidoId);

  const lineas = items.map((i) =>
    `${i.cantidad} × ${i.nombre} (${i.formato}) — ${plata(i.cantidad * i.precio_venta)}`);
  const texto = [
    `Hola ${pedido.cliente_nombre}, recibimos el pago de tu pedido #${pedido.numero}`
      + (pedido.feria_nombre ? ` en ${pedido.feria_nombre}.` : '.'),
    '',
    ...lineas,
    '',
    `Productos: ${plata(pedido.total_productos)}`,
    `Despacho: ${plata(pedido.costo_despacho)}`,
    `Total pagado: ${plata(pedido.total_venta)}`,
    '',
    `Se entrega en: ${pedido.direccion}`,
    '',
    'Los productos de feria se venden por formato aproximado: el peso exacto puede variar un poco.',
    `Si necesitas cambiar algo, llámanos al ${CONFIG.telefonoContacto}.`,
    '',
    'Este correo es un respaldo de tu pedido, no una boleta.',
  ].join('\n');

  const html = plantillaCorreo(`    <h2 style="margin:0 0 4px;font-size:20px">Pedido #${pedido.numero}</h2>
    <p style="color:#6B7670;margin:0 0 16px;font-size:15px">Hola ${limpio(pedido.cliente_nombre)}, recibimos tu pago.${pedido.feria_nombre ? ` Lo compramos en <b>${limpio(pedido.feria_nombre)}</b>.` : ''}</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
${items.map((i) => `<tr><td style="padding:8px 0;border-bottom:1px solid #EDEFED">${i.cantidad} × ${limpio(i.nombre)} <span style="color:#6B7670">(${limpio(i.formato)})</span></td><td style="padding:8px 0;border-bottom:1px solid #EDEFED;text-align:right;white-space:nowrap">${plata(i.cantidad * i.precio_venta)}</td></tr>`).join('\n')}
    <tr><td style="padding:8px 0;color:#6B7670">Despacho</td><td style="text-align:right;color:#6B7670">${plata(pedido.costo_despacho)}</td></tr>
    <tr><td style="padding:10px 0 0;font-size:17px"><b>Total pagado</b></td><td style="padding:10px 0 0;text-align:right;font-size:17px;color:#146C54"><b>${plata(pedido.total_venta)}</b></td></tr>
    </table>
    <p style="margin:20px 0 0;padding:12px 14px;background:#F4F6F4;border-radius:12px;font-size:14px;line-height:1.5"><b>Se entrega en:</b><br>${limpio(pedido.direccion)}</p>
    <p style="color:#6B7670;font-size:13px;line-height:1.5;margin:16px 0 0">Los productos de feria se venden por formato aproximado: el peso exacto puede variar un poco. Si necesitas cambiar algo, llámanos al ${limpio(CONFIG.telefonoContacto)}.</p>`,
    'Este correo es un respaldo de tu pedido, no una boleta.');

  const r = await enviarCorreo(destino, `Feria App: tu pedido #${pedido.numero}`, texto, html);
  if (!r.enviado) {
    // Se suelta el candado: la próxima confirmación lo reintenta.
    await ejecutar('UPDATE pedidos SET comprobante_at = NULL WHERE id = ?', pedidoId);
    console.error('[comprobante] no salió el del pedido', pedido.numero, r.detalle ?? '');
  }
  return r.enviado;
}

let enganchado = false;

/** Manda el comprobante cuando un pedido queda pagado. */
export function iniciarComprobantes(): void {
  if (enganchado) return;
  enganchado = true;
  bus.on('mensaje', (m) => {
    if (m.tipo !== 'pedido:cambio' || m.estado !== 'PAGADO') return;
    const envio = enviarComprobante(m.pedidoId)
      .then(() => undefined)
      .catch((e) => console.error('[comprobante]', e));
    (globalThis as any).EdgeRuntime?.waitUntil?.(envio);
  });
}
