import { consultar, consultarUno, ejecutar, type Fila } from '../db/index.ts';
import { bus } from '../realtime/bus.ts';
import { enviarCorreo } from '../correo.ts';
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
    `SELECT p.*, c.correo_ingreso, c.email AS correo_perfil
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
    `Hola ${pedido.cliente_nombre}, recibimos el pago de tu pedido #${pedido.numero}.`,
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

  const html = `<!doctype html><html lang="es"><body style="font-family:system-ui,Arial,sans-serif;color:#1F2933;max-width:520px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 4px">Pedido #${pedido.numero}</h2>
<p style="color:#52606D;margin:0 0 16px">Hola ${limpio(pedido.cliente_nombre)}, recibimos tu pago.</p>
<table style="width:100%;border-collapse:collapse">
${items.map((i) => `<tr><td style="padding:6px 0;border-bottom:1px solid #E4E7EB">${i.cantidad} × ${limpio(i.nombre)} <span style="color:#7B8794">(${limpio(i.formato)})</span></td><td style="padding:6px 0;border-bottom:1px solid #E4E7EB;text-align:right">${plata(i.cantidad * i.precio_venta)}</td></tr>`).join('\n')}
<tr><td style="padding:6px 0">Despacho</td><td style="text-align:right">${plata(pedido.costo_despacho)}</td></tr>
<tr><td style="padding:6px 0"><b>Total pagado</b></td><td style="text-align:right"><b>${plata(pedido.total_venta)}</b></td></tr>
</table>
<p><b>Se entrega en:</b> ${limpio(pedido.direccion)}</p>
<p style="color:#52606D;font-size:13px">Los productos de feria se venden por formato aproximado: el peso exacto puede variar un poco. Si necesitas cambiar algo, llámanos al ${limpio(CONFIG.telefonoContacto)}.</p>
<p style="color:#7B8794;font-size:12px">Este correo es un respaldo de tu pedido, no una boleta.</p>
</body></html>`;

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
