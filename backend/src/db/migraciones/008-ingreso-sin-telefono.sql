-- El comprador puede entrar sin teléfono: con un código al correo,
-- con Google o con Apple. El teléfono deja de ser obligatorio para
-- un cliente (para feriantes y repartidores lo sigue siendo).
ALTER TABLE clientes ALTER COLUMN telefono DROP NOT NULL;
ALTER TABLE sesiones ALTER COLUMN telefono DROP NOT NULL;

-- El correo con el que entra, ya confirmado. Es distinto de `email`,
-- que es el de contacto que escribe en el pedido y nadie verificó.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS correo_ingreso text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_correo
  ON clientes(correo_ingreso) WHERE correo_ingreso IS NOT NULL;

-- El identificador que Google y Apple dan de cada persona. No
-- cambia aunque cambie de correo.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS apple_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_google
  ON clientes(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_apple
  ON clientes(apple_sub) WHERE apple_sub IS NOT NULL;
