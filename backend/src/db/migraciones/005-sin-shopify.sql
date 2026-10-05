-- Shopify ya no va.
--
-- Los pedidos entran por la app propia y se cobran con Mercado Pago.
-- Estas columnas enlazaban el catálogo y los pedidos con una tienda
-- de Shopify que no existe: nadie las escribe ni las lee.
DROP INDEX IF EXISTS idx_productos_variante;
ALTER TABLE productos DROP COLUMN IF EXISTS shopify_variant_id;
ALTER TABLE pedidos DROP COLUMN IF EXISTS shopify_order_id;
