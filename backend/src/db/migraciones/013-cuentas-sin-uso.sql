-- Cuándo se usó por última vez la cuenta de un cliente.
--
-- Las compañías reasignan los números que nadie usa. Con esta fecha
-- se puede (a) pedir una segunda prueba a quien vuelve después de
-- meses y (b) vaciar las cuentas abandonadas, para que el dueño
-- nuevo de un número no encuentre nada del anterior.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ultima_actividad_at timestamptz NOT NULL DEFAULT now();
