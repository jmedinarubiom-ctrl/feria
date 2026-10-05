-- Dar de baja sin borrar.
--
-- Un feriante que deja la feria no se puede borrar: sus pedidos y
-- sus liquidaciones siguen siendo historia. Con `activo = false`
-- deja de recibir ofertas y no puede entrar, y todo lo que hizo
-- queda como estaba.
ALTER TABLE feriantes ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;
