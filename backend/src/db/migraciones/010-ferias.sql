-- Más de una feria.
--
-- `feria_id` ya existía en feriantes y en pedidos, pero era un
-- texto suelto: no había dónde decir qué días abre cada feria ni si
-- ya se reparte desde ella. Las filas las carga la semilla, con los
-- datos del Localizador Nacional de Ferias Libres de ODEPA y ASOF.
CREATE TABLE IF NOT EXISTS ferias (
  id             text PRIMARY KEY,
  nombre         text NOT NULL,
  comuna         text NOT NULL,
  -- Dónde se pone: calle principal y entre cuáles.
  calle          text NOT NULL,
  -- 0 = domingo … 6 = sábado.
  dias           integer[] NOT NULL,
  abre           text NOT NULL,          -- 'HH:MM', hora de Chile
  ultimo_pedido  text NOT NULL,
  cierra         text NOT NULL,
  -- false = está en la lista pero todavía no se reparte desde ahí.
  activa         boolean NOT NULL DEFAULT false,
  -- De dónde salió el dato, para saber contra qué revisarlo.
  fuente         text,
  creado_at      timestamptz NOT NULL DEFAULT now()
);
