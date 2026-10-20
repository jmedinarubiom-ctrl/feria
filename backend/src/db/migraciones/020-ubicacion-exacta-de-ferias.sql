-- Ubicación de cada feria según la dirección del Localizador de
-- Ferias Libres de ODEPA, ubicada con OpenStreetMap (octubre 2026).
-- Las que salen de un cruce de calles o de un número de calle quedan
-- confirmadas; las que son un tramo largo, aproximadas, para que el
-- operador las afine en el panel.

-- Av. Argentina entre Rancagua y Victoria: el punto anterior estaba
-- casi un kilómetro al oeste.
UPDATE ferias SET lat = -33.0500, lng = -71.6028, ubicacion_revisada = true
 WHERE id = 'feria-av-argentina';
-- Valencia 275, esquina Aviador Figueroa (Villa Alemana).
UPDATE ferias SET lat = -33.0592, lng = -71.3670, ubicacion_revisada = true
 WHERE id = 'feria-molino-prat';
-- New Memory esquina Los Crespones (Peñablanca, Villa Alemana).
UPDATE ferias SET lat = -33.0474, lng = -71.3475, ubicacion_revisada = true
 WHERE id = 'feria-pena-blanca';
-- 25 Poniente con 1 Sur (Quinto Sector, Gómez Carreño).
UPDATE ferias SET lat = -32.9884, lng = -71.5274, ubicacion_revisada = true
 WHERE id = 'feria-gomez-carreno-5';
-- Lecho del estero, junto al puente Los Castaños; se entra por Batuco.
UPDATE ferias SET lat = -33.0250, lng = -71.5440, ubicacion_revisada = false
 WHERE id = 'feria-marga-marga';
-- Avenida Pacífico, Tercer Sector: la calle es larga, punto aproximado.
UPDATE ferias SET lat = -32.9940, lng = -71.5185, ubicacion_revisada = false
 WHERE id = 'feria-gomez-carreno-3';
-- Perú 151, El Belloto: a una cuadra y media de Freire, aproximado.
UPDATE ferias SET lat = -33.0478, lng = -71.4086, ubicacion_revisada = false
 WHERE id = 'feria-belloto';
