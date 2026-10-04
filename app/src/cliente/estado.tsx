import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Carro y datos del cliente, guardados en el teléfono.
 *
 * El cliente no tiene cuenta en el servidor —esa parte vive en la
 * app de compra con su propio login—, así que su nombre, dirección
 * y los pedidos que hizo se guardan acá. Antes la dirección estaba
 * escrita en el código y todos los pedidos iban al mismo lugar.
 */

export type Perfil = {
  nombre: string;
  telefono: string;
  email: string;
  direccion: string;
  lat: number;
  lng: number;
};

const PERFIL_INICIAL: Perfil = {
  nombre: '',
  telefono: '',
  email: '',
  direccion: '',
  // Centro de Valparaíso, hasta que haya geocodificación de verdad.
  lat: -33.0458,
  lng: -71.6197,
};

type Estado = {
  carro: Record<string, number>;
  agregar: (productoId: string, cantidad?: number) => void;
  quitar: (productoId: string) => void;
  fijarCantidad: (productoId: string, cantidad: number) => void;
  vaciar: () => void;
  unidades: number;

  perfil: Perfil;
  guardarPerfil: (p: Perfil) => Promise<void>;
  perfilCompleto: boolean;

  /** Ids de los pedidos hechos desde este teléfono, del más nuevo al más viejo. */
  misPedidos: string[];
  registrarPedido: (pedidoId: string) => Promise<void>;
};

const Ctx = createContext<Estado | null>(null);

const CLAVE_PERFIL = 'feria.perfil';
const CLAVE_PEDIDOS = 'feria.mis-pedidos';

const leer = async (clave: string): Promise<string | null> => {
  try {
    return Platform.OS === 'web'
      ? localStorage.getItem(clave)
      : await SecureStore.getItemAsync(clave);
  } catch {
    return null;
  }
};

const escribir = async (clave: string, valor: string): Promise<void> => {
  try {
    if (Platform.OS === 'web') localStorage.setItem(clave, valor);
    else await SecureStore.setItemAsync(clave, valor);
  } catch {
    // Sin almacenamiento la app sigue andando; solo no recuerda.
  }
};

export function ProveedorCliente({ children }: { children: React.ReactNode }) {
  const [carro, setCarro] = useState<Record<string, number>>({});
  const [perfil, setPerfil] = useState<Perfil>(PERFIL_INICIAL);
  const [misPedidos, setMisPedidos] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const p = await leer(CLAVE_PERFIL);
      if (p) setPerfil({ ...PERFIL_INICIAL, ...JSON.parse(p) });
      const ped = await leer(CLAVE_PEDIDOS);
      if (ped) setMisPedidos(JSON.parse(ped));
    })();
  }, []);

  const valor = useMemo<Estado>(() => ({
    carro,
    agregar: (id, cantidad = 1) =>
      setCarro((c) => ({ ...c, [id]: (c[id] ?? 0) + cantidad })),
    quitar: (id) => setCarro(({ [id]: _, ...resto }) => resto),
    fijarCantidad: (id, cantidad) => setCarro((c) => {
      if (cantidad <= 0) {
        const { [id]: _, ...resto } = c;
        return resto;
      }
      return { ...c, [id]: cantidad };
    }),
    vaciar: () => setCarro({}),
    unidades: Object.values(carro).reduce((a, b) => a + b, 0),

    perfil,
    guardarPerfil: async (p) => {
      setPerfil(p);
      await escribir(CLAVE_PERFIL, JSON.stringify(p));
    },
    perfilCompleto: !!(perfil.nombre.trim() && perfil.telefono.trim() && perfil.direccion.trim()),

    misPedidos,
    registrarPedido: async (pedidoId) => {
      const lista = [pedidoId, ...misPedidos.filter((x) => x !== pedidoId)].slice(0, 30);
      setMisPedidos(lista);
      await escribir(CLAVE_PEDIDOS, JSON.stringify(lista));
    },
  }), [carro, perfil, misPedidos]);

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useCliente(): Estado {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCliente fuera de ProveedorCliente');
  return v;
}
