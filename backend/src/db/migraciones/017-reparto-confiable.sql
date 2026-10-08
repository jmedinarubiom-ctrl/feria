-- Prueba de entrega: un código que el cliente le dicta al repartidor.
-- Si no se pudo pedir (no había nadie con el código), queda el motivo.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_entrega text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_sin_codigo text;

-- Un producto que el puesto no tenía: no se entrega ni se cobra.
ALTER TABLE items ADD COLUMN IF NOT EXISTS faltante boolean NOT NULL DEFAULT false;

-- La tarifa con que nació el viaje: la vigente sube si nadie lo toma.
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS tarifa_base integer;

-- Repartidores por feria. Sin feria = reparte para todas.
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS feria_id text REFERENCES ferias(id);

-- Lo que opinó el cliente, una vez por pedido.
CREATE TABLE IF NOT EXISTS calificaciones (
  pedido_id  text PRIMARY KEY REFERENCES pedidos(id) ON DELETE CASCADE,
  estrellas  integer NOT NULL CHECK (estrellas BETWEEN 1 AND 5),
  comentario text,
  creado_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE feriantes ADD COLUMN IF NOT EXISTS estrellas_suma integer NOT NULL DEFAULT 0;
ALTER TABLE feriantes ADD COLUMN IF NOT EXISTS estrellas_n integer NOT NULL DEFAULT 0;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS estrellas_suma integer NOT NULL DEFAULT 0;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS estrellas_n integer NOT NULL DEFAULT 0;
