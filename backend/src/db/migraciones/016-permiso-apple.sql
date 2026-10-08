-- El permiso que Apple le dio a la app para una cuenta creada con
-- «Iniciar sesión con Apple». Se guarda cifrado y sirve para una
-- sola cosa: devolvérselo a Apple (revocarlo) cuando la persona
-- elimina su cuenta, que es lo que Apple exige.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS apple_permiso text;
