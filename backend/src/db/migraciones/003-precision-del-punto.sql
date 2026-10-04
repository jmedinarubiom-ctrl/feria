-- Qué tan confiable es el punto del pedido.
--
-- Antes todos los pedidos tenían las coordenadas del centro de
-- Valparaíso y nadie podía saberlo mirando la fila. Ahora el
-- servidor geocodifica la dirección y anota con qué precisión la
-- encontró: 'house' es la casa, 'calle (...)' es la cuadra, y
-- 'feria' significa que no la encontró y el repartidor tiene que
-- leer la dirección escrita.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS geo_precision text;
