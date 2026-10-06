-- Quién aceptó qué versión de los términos y de la política de
-- privacidad, y cuándo. Una fila por aceptación: si el texto
-- cambia, se vuelve a pedir y queda la historia.
CREATE TABLE IF NOT EXISTS aceptaciones (
  actor_id   text NOT NULL,
  rol        text NOT NULL,
  version    text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, version)
);
