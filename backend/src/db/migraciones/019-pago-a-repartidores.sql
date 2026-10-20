-- Lo que se le paga a cada repartidor por día, como con los feriantes.
CREATE TABLE IF NOT EXISTS liquidaciones_reparto (
  id              text PRIMARY KEY,
  repartidor_id   text NOT NULL REFERENCES repartidores(id),
  fecha           date NOT NULL,
  monto_total     integer NOT NULL,
  cantidad_viajes integer NOT NULL,
  pagado_at       timestamptz,
  confirmado_at   timestamptz,
  UNIQUE (repartidor_id, fecha)
);

-- Si la ubicación de la feria la confirmó el operador. Desde ahí se
-- mide el despacho: con una ubicación equivocada se cobra mal.
ALTER TABLE ferias ADD COLUMN IF NOT EXISTS ubicacion_revisada boolean NOT NULL DEFAULT false;
UPDATE ferias SET ubicacion_revisada = true WHERE id = 'feria-av-argentina';
-- Puntos aproximados del resto, para no medir desde Valparaíso. Hay
-- que confirmarlos en el panel antes de abrir cada feria.
UPDATE ferias SET lat = -33.0265, lng = -71.5500 WHERE id = 'feria-marga-marga' AND lat IS NULL;
UPDATE ferias SET lat = -32.9930, lng = -71.5390 WHERE id = 'feria-gomez-carreno-3' AND lat IS NULL;
UPDATE ferias SET lat = -32.9875, lng = -71.5335 WHERE id = 'feria-gomez-carreno-5' AND lat IS NULL;
UPDATE ferias SET lat = -33.0430, lng = -71.4085 WHERE id = 'feria-belloto' AND lat IS NULL;
UPDATE ferias SET lat = -33.0330, lng = -71.3760 WHERE id = 'feria-molino-prat' AND lat IS NULL;
UPDATE ferias SET lat = -33.0560, lng = -71.3500 WHERE id = 'feria-pena-blanca' AND lat IS NULL;
