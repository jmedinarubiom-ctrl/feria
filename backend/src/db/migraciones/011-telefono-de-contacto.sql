-- El teléfono al que llamar al cliente.
--
-- `telefono` es con el que entra, ya confirmado por SMS; quien
-- entra con correo o con Google no tiene. Este es el que escribe
-- en su perfil para que el repartidor lo pueda llamar.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefono_contacto text;
