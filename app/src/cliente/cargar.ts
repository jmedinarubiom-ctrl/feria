import { useCallback, useEffect, useState } from 'react';

import { api } from '../api';

/**
 * Carga un endpoint, con error visible y reintento.
 *
 * Antes cada pantalla hacía `api(...).then(setDatos).catch(() => {})`
 * y dejaba el estado en null. Cuando la petición fallaba —la feria
 * sin señal, el servidor reiniciando, el freno por IP— la pantalla
 * se quedaba girando para siempre y la única salida era cerrar la
 * app. Tragarse el error no lo hace desaparecer: lo esconde.
 */
export type Recurso<T> = {
  datos: T | null;
  error: string | null;
  cargando: boolean;
  recargar: () => void;
};

export function useRecurso<T = any>(camino: string | null): Recurso<T> {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [intento, setIntento] = useState(0);

  const recargar = useCallback(() => setIntento((n) => n + 1), []);

  useEffect(() => {
    if (!camino) { setCargando(false); return; }
    let vigente = true;
    setCargando(true);
    api('GET', camino)
      .then((d) => { if (vigente) { setDatos(d); setError(null); } })
      .catch((e: any) => { if (vigente) setError(e.message ?? 'No se pudo cargar.'); })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [camino, intento]);

  return { datos, error, cargando, recargar };
}
