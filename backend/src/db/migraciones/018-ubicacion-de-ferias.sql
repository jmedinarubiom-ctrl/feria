-- Dónde queda cada feria: desde ahí se mide el despacho.
ALTER TABLE ferias ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE ferias ADD COLUMN IF NOT EXISTS lng double precision;
-- Av. Argentina, entre Rancagua y Victoria (Valparaíso).
UPDATE ferias SET lat = -33.0472, lng = -71.6127 WHERE id = 'feria-av-argentina' AND lat IS NULL;
-- Los kilómetros con que se calculó el despacho de cada pedido.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS distancia_km numeric(6, 2);
