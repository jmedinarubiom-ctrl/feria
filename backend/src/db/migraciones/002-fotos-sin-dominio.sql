-- Las fotos propias se guardan sin dominio.
--
-- Al principio el panel guardaba la URL entera, con el host desde
-- el que se subió. Eso apunta a un servidor concreto: el día que la
-- feria cambie de dominio —o que alguien mire el catálogo desde el
-- teléfono y no desde el computador donde corre todo— esas fotos no
-- cargan. El camino relativo lo resuelve cada cliente contra su
-- propio servidor.
UPDATE productos
   SET imagen_url = regexp_replace(imagen_url, '^https?://[^/]+(/fotos/)', '\1')
 WHERE imagen_url ~ '^https?://[^/]+/fotos/[0-9a-f]{32}\.(jpg|png|webp)$';
