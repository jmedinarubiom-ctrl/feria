import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { api } from '../api';

/**
 * Carro y datos del cliente, guardados en el teléfono.
 *
 * El cliente no tiene cuenta en el servidor —esa parte vive en la
 * app de compra con su propio login—, así que su nombre, dirección
 * y los pedidos que hizo se guardan acá. Antes la dirección estaba
 * escrita en el código y todos los pedidos iban al mismo lugar.
 */

export type Perfil = {
  /** El punto exacto de entrega que marcó, si marcó uno. */
  punto?: { lat: number; lng: number; precisionM?: number; direccion: string } | null;
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

  /**
   * Ya se sabe si la cuenta tiene perfil o no. Antes de esto no se
   * puede decidir si mostrar «crea tu perfil».
   */
  perfilListo: boolean;

  /** El número confirmado de la cuenta, si tiene. No se edita a mano. */
  telefonoVerificado: string | null;
  /** Vuelve a leer la cuenta del servidor. */
  refrescarCuenta: () => Promise<void>;

  /** La feria en la que compra. Se recuerda entre una vez y otra. */
  feriaId: string;
  elegirFeria: (id: string) => void;

  /** Ids de los pedidos hechos desde este teléfono, del más nuevo al más viejo. */
  misPedidos: string[];
  registrarPedido: (pedidoId: string) => Promise<void>;
};

const Ctx = createContext<Estado | null>(null);

/** Las copias de antes, sin dueño. Se borran al entrar. */
const CLAVES_VIEJAS = ['feria.perfil', 'feria.mis-pedidos'];
const CLAVE_FERIA = 'feria.elegida';
export const FERIA_INICIAL = 'feria-av-argentina';

const leer = async (clave: string): Promise<string | null> => {
  try {
    return Platform.OS === 'web'
      ? localStorage.getItem(clave)
      : await SecureStore.getItemAsync(clave);
  } catch {
    return null;
  }
};

const borrar = async (clave: string): Promise<void> => {
  try {
    if (Platform.OS === 'web') localStorage.removeItem(clave);
    else await SecureStore.deleteItemAsync(clave);
  } catch {
    // Nada que hacer: si no se pudo borrar, igual ya no se lee.
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

export function ProveedorCliente({ children, telefono, cuentaId }: {
  children: React.ReactNode;
  /** El número de la cuenta: ya está confirmado por SMS. */
  telefono: string;
  /** De quién son los datos que se guardan en el teléfono. */
  cuentaId: string;
}) {
  // Lo guardado en el teléfono es de UNA cuenta. Antes había una
  // sola copia para todas: quien entraba con un correo nuevo en un
  // teléfono ya usado heredaba el nombre, la dirección y los
  // pedidos del anterior, y la app ni le ofrecía crear su perfil.
  const CLAVE_PERFIL = `feria.perfil.${cuentaId}`;
  const CLAVE_PEDIDOS = `feria.mis-pedidos.${cuentaId}`;

  const [carro, setCarro] = useState<Record<string, number>>({});
  const [perfil, setPerfil] = useState<Perfil>(PERFIL_INICIAL);
  const [misPedidos, setMisPedidos] = useState<string[]>([]);
  const [feriaId, setFeriaId] = useState(FERIA_INICIAL);
  const [perfilListo, setPerfilListo] = useState(false);
  const [telefonoVerificado, setTelefonoVerificado] = useState<string | null>(null);

  const refrescarCuenta = async () => {
    const yo = await api('GET', '/auth/yo');
    const confirmado: string | null = yo.perfil?.telefono ?? null;
    setTelefonoVerificado(confirmado);
    if (confirmado) setPerfil((actual) => ({ ...actual, telefono: confirmado }));
  };

  useEffect(() => {
    void (async () => {
      // Primero lo guardado en el teléfono, que está al instante y
      // funciona sin señal; después la cuenta, que es la que vale:
      // así los datos y los pedidos siguen al cliente si cambia de
      // teléfono.
      for (const vieja of CLAVES_VIEJAS) await borrar(vieja);

      const p = await leer(CLAVE_PERFIL);
      const local: Perfil = { ...PERFIL_INICIAL, ...(p ? JSON.parse(p) : {}) };
      setPerfil({ ...local, telefono: local.telefono || telefono });
      const ped = await leer(CLAVE_PEDIDOS);
      setMisPedidos(ped ? JSON.parse(ped) : []);
      const elegida = await leer(CLAVE_FERIA);
      if (elegida) setFeriaId(elegida);

      try {
        const [yo, mios] = await Promise.all([
          api('GET', '/auth/yo'), api('GET', '/cliente/pedidos'),
        ]);
        const cuenta = yo.perfil ?? {};
        setTelefonoVerificado(cuenta.telefono ?? null);
        // Manda la cuenta. La copia del teléfono solo rellena lo
        // que el servidor todavía no tiene.
        setPerfil((actual) => ({
          ...actual,
          nombre: cuenta.nombre || actual.nombre || '',
          email: cuenta.email || actual.email || '',
          direccion: cuenta.direccion || actual.direccion || '',
          telefono: cuenta.telefono || cuenta.telefono_contacto || actual.telefono || telefono,
        }));
        setMisPedidos(mios.pedidos);
        await escribir(CLAVE_PEDIDOS, JSON.stringify(mios.pedidos));
      } catch {
        // Sin señal se sigue con lo guardado.
      }
      setPerfilListo(true);
    })();
  }, [telefono, cuentaId]);

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
      void api('POST', '/cliente/perfil', {
        cuerpo: {
          nombre: p.nombre, email: p.email, direccion: p.direccion, telefonoContacto: p.telefono,
        },
      }).catch(() => {});
    },
    perfilCompleto: !!(perfil.nombre.trim() && perfil.telefono.trim() && perfil.direccion.trim()),

    perfilListo,
    telefonoVerificado,
    refrescarCuenta,

    feriaId,
    elegirFeria: (id) => {
      // El carro es de una feria: los precios son los mismos, pero
      // el pedido lo prepara y lo reparte esa feria, ese día.
      if (id !== feriaId) setCarro({});
      setFeriaId(id);
      void escribir(CLAVE_FERIA, id);
    },

    misPedidos,
    registrarPedido: async (pedidoId) => {
      const lista = [pedidoId, ...misPedidos.filter((x) => x !== pedidoId)].slice(0, 30);
      setMisPedidos(lista);
      await escribir(CLAVE_PEDIDOS, JSON.stringify(lista));
    },
  }), [carro, perfil, misPedidos, feriaId, perfilListo, cuentaId, telefonoVerificado]);

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useCliente(): Estado {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCliente fuera de ProveedorCliente');
  return v;
}
