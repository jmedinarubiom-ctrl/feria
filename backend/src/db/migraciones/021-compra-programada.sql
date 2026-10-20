-- Compra programada: el pedido se prepara en la mañana y lo reparte
-- un camión al cierre de la feria, junto con los demás.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS modalidad text NOT NULL DEFAULT 'AHORA'
  CHECK (modalidad IN ('AHORA', 'PROGRAMADO'));
-- «16:00–19:00»: lo que se le prometió al cliente.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ventana text;

-- La ruta del camión: un chofer, una feria, un día.
CREATE TABLE IF NOT EXISTS rutas (
  id            text PRIMARY KEY,
  feria_id      text NOT NULL REFERENCES ferias(id),
  fecha         date NOT NULL,
  repartidor_id text NOT NULL REFERENCES repartidores(id),
  estado        text NOT NULL DEFAULT 'ARMADA' CHECK (estado IN ('ARMADA', 'EN_CURSO', 'TERMINADA')),
  km_total      numeric,
  creado_at     timestamptz NOT NULL DEFAULT now(),
  iniciada_at   timestamptz,
  terminada_at  timestamptz
);
CREATE INDEX IF NOT EXISTS rutas_repartidor ON rutas (repartidor_id, estado);

-- Un viaje programado no se le ofrece a las motos: espera la ruta.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS programado boolean NOT NULL DEFAULT false;
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS ruta_id text REFERENCES rutas(id);
-- El lugar de la entrega dentro de la ruta (0 = la primera).
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS orden_ruta integer;
CREATE INDEX IF NOT EXISTS viajes_ruta ON viajes (ruta_id, orden_ruta);
