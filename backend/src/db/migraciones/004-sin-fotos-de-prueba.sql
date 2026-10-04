-- Saca las fotos subidas a mano durante las pruebas.
--
-- El catálogo ahora trae una foto de referencia por producto, que
-- viene con el código. `imagen_url` queda para cuando alguien suba
-- la foto real del puesto; mientras tanto, vacío significa «usá la
-- de referencia».
UPDATE productos SET imagen_url = NULL WHERE imagen_url LIKE '/fotos/%';
