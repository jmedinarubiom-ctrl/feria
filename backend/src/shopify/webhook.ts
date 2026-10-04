import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PedidoEntrante, ItemEntrante } from '../dominio/despacho.ts';
import { consultarUno, type Fila } from '../db/index.ts';

/**
 * Verifica la firma HMAC del webhook de Shopify.
 *
 * Sin esto, cualquiera que conozca la URL puede inyectar pedidos
 * falsos y hacer que ocho feriantes preparen mercadería que nadie
 * pagó. Se compara en tiempo constante.
 */
export function firmaValida(cuerpoCrudo: Buffer, firmaHeader: string | undefined, secreto: string): boolean {
  if (!firmaHeader) return false;
  const esperado = createHmac('sha256', secreto).update(cuerpoCrudo).digest();
  let recibido: Buffer;
  try {
    recibido = Buffer.from(firmaHeader, 'base64');
  } catch {
    return false;
  }
  if (recibido.length !== esperado.length) return false;
  return timingSafeEqual(recibido, esperado);
}

type LineItemShopify = { variant_id?: number | string; quantity: number; title?: string };

/**
 * Traduce un pedido de Shopify al modelo interno.
 *
 * El enlace se hace por `shopify_variant_id` guardado en la tabla
 * de productos: Shopify manda su propio id de variante y acá hay
 * que saber a qué producto (y por lo tanto a qué rubro) corresponde.
 */
export async function traducirPedido(payload: any, feriaIdPorDefecto: string): Promise<PedidoEntrante> {
  const envio = payload.shipping_address ?? payload.billing_address ?? {};
  const items: ItemEntrante[] = [];
  const sinMapear: string[] = [];

  for (const li of (payload.line_items ?? []) as LineItemShopify[]) {
    const variante = String(li.variant_id ?? '');
    const producto = await consultarUno<Fila>(
      'SELECT id FROM productos WHERE shopify_variant_id = ? AND activo', variante);
    if (!producto) {
      sinMapear.push(li.title ?? variante);
      continue;
    }
    items.push({ productoId: producto.id, cantidad: li.quantity });
  }

  if (sinMapear.length > 0) {
    // Fallar ruidosamente: despachar un pedido incompleto es peor
    // que rechazarlo, porque el cliente pagó por todo.
    throw new Error(
      `Line items de Shopify sin producto asociado: ${sinMapear.join(', ')}. ` +
      `Completa shopify_variant_id en la tabla productos.`);
  }

  const nombre = [envio.first_name, envio.last_name].filter(Boolean).join(' ')
    || payload.customer?.first_name
    || payload.email
    || 'Cliente';

  // El despacho ya se le cobró al cliente en el checkout de Shopify,
  // así que se toma de ahí en vez de recalcularlo: si no coincidiera,
  // el cliente pagó una cosa y la base diría otra.
  const despacho = Math.round(
    ((payload.shipping_lines ?? []) as Array<{ price?: string | number }>)
      .reduce((a, l) => a + Number(l.price ?? 0), 0));

  return {
    shopifyOrderId: String(payload.admin_graphql_api_id ?? payload.id),
    costoDespacho: Number.isFinite(despacho) ? despacho : 0,
    feriaId: payload.note_attributes?.find((a: any) => a.name === 'feria_id')?.value ?? feriaIdPorDefecto,
    clienteNombre: nombre,
    clienteTelefono: envio.phone ?? payload.phone ?? payload.customer?.phone ?? 's/n',
    clienteEmail: payload.email ?? payload.contact_email ?? payload.customer?.email ?? null,
    direccion: [envio.address1, envio.address2, envio.city].filter(Boolean).join(', ') || 's/d',
    lat: Number(envio.latitude ?? 0),
    lng: Number(envio.longitude ?? 0),
    notas: payload.note ?? null,
    items,
  };
}
