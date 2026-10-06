-- Cuándo se le mandó al cliente el correo con el detalle de su
-- pedido. Sirve de candado: un pago que se confirma dos veces (el
-- webhook y la revisión) no manda dos correos.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comprobante_at timestamptz;
