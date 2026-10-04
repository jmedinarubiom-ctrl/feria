-- La foto del producto.
--
-- `esquema.sql` ya la trae, pero `CREATE TABLE IF NOT EXISTS` no
-- toca una tabla que ya existe: cualquier base creada antes de esto
-- se queda sin la columna y el catálogo falla al guardar una foto.
ALTER TABLE productos ADD COLUMN IF NOT EXISTS imagen_url text;
