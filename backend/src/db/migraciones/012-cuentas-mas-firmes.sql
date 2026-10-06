-- Validación de cuentas más firme.

-- Intentos fallidos por código, para poder poner un tope por día
-- a quien intenta adivinar el código de otro.
ALTER TABLE codigos_acceso ADD COLUMN IF NOT EXISTS fallos integer NOT NULL DEFAULT 0;
-- El código lo generó el operador desde el panel para dictárselo a
-- alguien de su equipo: es la salida cuando el tope lo dejó afuera.
ALTER TABLE codigos_acceso ADD COLUMN IF NOT EXISTS del_operador boolean NOT NULL DEFAULT false;

-- Segundo factor del operador: una clave además del código. El
-- operador puede cancelar pedidos, devolver plata y generar códigos
-- para entrar como cualquiera; que baste con ver un SMS es poco.
ALTER TABLE operadores ADD COLUMN IF NOT EXISTS clave_hash text;

-- El teléfono confirmado de un cliente no puede ser de dos cuentas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_telefono
  ON clientes(telefono) WHERE telefono IS NOT NULL;
