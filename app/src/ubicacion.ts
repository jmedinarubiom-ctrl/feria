import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';

import { api } from './api';

/**
 * Manda la posición del repartidor mientras lleva un viaje.
 *
 * Solo mientras lo lleva: un repartidor no tiene por qué ser
 * seguido cuando terminó el turno, y el permiso se pide recién
 * cuando hay un pedido que justifica pedirlo.
 *
 * Los errores se tragan a propósito. Si el GPS falla, el reparto
 * tiene que seguir funcionando igual —la posición es información
 * de más, no parte del flujo— y una alerta cada diez segundos en
 * medio de la calle es peor que no tener el punto en el mapa.
 */
export function useEnviarUbicacion(activo: boolean): void {
  const vigente = useRef(false);

  useEffect(() => {
    if (!activo) return;
    vigente.current = true;
    let suscripcion: Location.LocationSubscription | null = null;

    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || !vigente.current) return;

      suscripcion = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          // En moto por Valparaíso, cada 15 s o cada 50 m alcanza
          // para seguir el viaje sin vaciar la batería.
          timeInterval: 15000,
          distanceInterval: 50,
        },
        ({ coords }) => {
          void api('POST', '/repartidor/ubicacion', {
            cuerpo: { lat: coords.latitude, lng: coords.longitude },
          }).catch(() => {});
        },
      );
    })();

    return () => {
      vigente.current = false;
      suscripcion?.remove();
    };
  }, [activo]);
}
