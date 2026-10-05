-- El comprador también entra con su teléfono.
--
-- Hasta acá el cliente no tenía cuenta: sus datos y sus pedidos
-- vivían solo en su teléfono. Ahora cualquier número chileno que
-- confirma el código por SMS queda registrado como cliente.
CREATE TABLE IF NOT EXISTS clientes (
  id          text PRIMARY KEY,
  telefono    text NOT NULL UNIQUE,
  nombre      text NOT NULL DEFAULT '',
  email       text,
  direccion   text,
  creado_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente_id text REFERENCES clientes(id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id, creado_at);

-- Las sesiones aceptan el rol nuevo.
ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_rol_check;
ALTER TABLE sesiones ADD CONSTRAINT sesiones_rol_check
  CHECK (rol IN ('feriante', 'repartidor', 'operador', 'cliente'));

-- Quien pide ser feriante o repartidor queda cargado pero inactivo
-- y con esta marca, hasta que el operador lo apruebe.
ALTER TABLE feriantes ADD COLUMN IF NOT EXISTS pendiente boolean NOT NULL DEFAULT false;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS pendiente boolean NOT NULL DEFAULT false;
