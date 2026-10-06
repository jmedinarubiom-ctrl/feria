import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, type NavigatorScreenParams } from '@react-navigation/native';
import {
  createBottomTabNavigator, type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, E, R, T } from '../tema';
import { ProveedorCliente, useCliente } from './estado';
import Inicio from './Inicio';
import Feria from './Feria';
import Pedidos from './Pedidos';
import PerfilPantalla from './Perfil';
import Categoria from './Categoria';
import Producto from './Producto';
import Carrito from './Carrito';
import Pago from './Pago';
import Seguimiento from './Seguimiento';
import ConPerfil from './CrearPerfil';

/**
 * La app del cliente.
 *
 * Cuatro pestañas abajo —inicio, feria, pedidos, perfil— y una pila
 * encima para lo que es un paso y no un lugar: categoría, producto,
 * carrito, pago, seguimiento. Esas tapan la barra a propósito: una
 * vez que empezó a pagar, no hay nada más que hacer en la app.
 */

type Pestanas = {
  Inicio: undefined;
  Feria: undefined;
  Pedidos: undefined;
  Perfil: undefined;
};

type Pila = {
  Pestanas: NavigatorScreenParams<Pestanas>;
  Categoria: { rubroId: string; nombre: string };
  Producto: { producto: any };
  Carrito: undefined;
  Pago: undefined;
  Seguimiento: { pedidoId: string };
};

const Tabs = createBottomTabNavigator<Pestanas>();
const Stack = createNativeStackNavigator<Pila>();

const ICONOS: Record<keyof Pestanas, string> = {
  Inicio: '🧺',
  Feria: '📍',
  Pedidos: '🧾',
  Perfil: '👤',
};

/** Barra de pestañas propia: la del sistema no se parece al diseño. */
function Barra({ state, navigation }: BottomTabBarProps) {
  const inset = useSafeAreaInsets();
  const { unidades } = useCliente();

  return (
    <View style={[e.barra, { paddingBottom: Math.max(inset.bottom, E.s) }]}>
      {state.routes.map((ruta, i) => {
        const activa = state.index === i;
        const nombre = ruta.name as keyof Pestanas;
        return (
          <Pressable
            key={ruta.key}
            onPress={() => navigation.navigate(ruta.name)}
            style={e.pestana}
            accessibilityRole="button"
            accessibilityState={{ selected: activa }}
          >
            <View style={[e.icono, activa && { backgroundColor: C.verdeSuave }]}>
              <Text style={{ fontSize: 17, opacity: activa ? 1 : 0.45 }}>{ICONOS[nombre]}</Text>
              {nombre === 'Inicio' && unidades > 0 ? (
                <View style={e.globo}>
                  <Text style={e.globoTexto}>{unidades}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[T.micro, activa && { color: C.verdeOscuro,
                          fontFamily: T.destacado.fontFamily }]}>
              {nombre}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Pestanas({ onSalir, alEliminarCuenta }: {
  onSalir: () => void; alEliminarCuenta: () => void;
}) {
  return (
    <Tabs.Navigator
      tabBar={(p) => <Barra {...p} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: C.fondo } }}
    >
      <Tabs.Screen name="Inicio">
        {({ navigation }) => <Inicio navegar={(p, a) => navigation.navigate(p as never, a as never)} />}
      </Tabs.Screen>
      <Tabs.Screen name="Feria">
        {({ navigation }) => <Feria navegar={(p, a) => navigation.navigate(p as never, a as never)} />}
      </Tabs.Screen>
      <Tabs.Screen name="Pedidos">
        {({ navigation }) => <Pedidos navegar={(p, a) => navigation.navigate(p as never, a as never)} />}
      </Tabs.Screen>
      <Tabs.Screen name="Perfil">
        {() => <PerfilPantalla onSalir={onSalir} alEliminarCuenta={alEliminarCuenta} />}
      </Tabs.Screen>
    </Tabs.Navigator>
  );
}

export default function AppCliente({ onSalir, alEliminarCuenta, telefono, cuentaId }: {
  onSalir: () => void; alEliminarCuenta: () => void; telefono: string; cuentaId: string;
}) {
  return (
    // `key`: al cambiar de cuenta se arma todo de nuevo, sin restos
    // del carro ni del perfil de la anterior.
    <ProveedorCliente key={cuentaId} telefono={telefono} cuentaId={cuentaId}>
      <NavigationContainer>
        {/* Arriba, una sola vez para toda la app: sin esto el saludo
            queda debajo del reloj. Abajo lo resuelve cada pantalla,
            porque la barra de pestañas y los botones flotantes no se
            separan del borde con la misma medida. */}
        <SafeAreaView style={{ flex: 1, backgroundColor: C.fondo }} edges={['top']}>
        <ConPerfil onSalir={onSalir}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: C.fondo },
          }}
        >
          <Stack.Screen name="Pestanas">
            {() => <Pestanas onSalir={onSalir} alEliminarCuenta={alEliminarCuenta} />}
          </Stack.Screen>

          <Stack.Screen name="Categoria">
            {({ route, navigation }) => (
              <Categoria
                rubroId={route.params.rubroId}
                nombre={route.params.nombre}
                navegar={(p, a) => navigation.navigate(p as never, a as never)}
                volver={() => navigation.goBack()}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="Producto">
            {({ route, navigation }) => (
              <Producto
                producto={route.params.producto}
                navegar={(p, a) => navigation.navigate(p as never, a as never)}
                volver={() => navigation.goBack()}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="Carrito">
            {({ navigation }) => (
              <Carrito
                navegar={(p, a) => navigation.navigate(p as never, a as never)}
                volver={() => navigation.goBack()}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="Pago">
            {({ navigation }) => (
              <Pago
                // Al pagar, el seguimiento reemplaza el pago: volver
                // atrás no debe llevar a pagar un pedido ya pagado.
                navegar={(p, a) => navigation.replace(p as never, a as never)}
                volver={() => navigation.goBack()}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="Seguimiento">
            {({ route, navigation }) => (
              <Seguimiento
                pedidoId={route.params.pedidoId}
                volver={() => (navigation.canGoBack()
                  ? navigation.goBack()
                  : navigation.navigate('Pestanas'))}
              />
            )}
          </Stack.Screen>
        </Stack.Navigator>
        </ConPerfil>
        </SafeAreaView>
      </NavigationContainer>
    </ProveedorCliente>
  );
}

const e = StyleSheet.create({
  barra: {
    flexDirection: 'row',
    backgroundColor: C.superficie,
    borderTopWidth: 1, borderTopColor: C.borde,
    paddingTop: E.s,
    ...Platform.select({
      ios: {
        shadowColor: C.sombra, shadowOpacity: 0.06,
        shadowRadius: 12, shadowOffset: { width: 0, height: -2 },
      },
      default: {},
    }),
  },
  pestana: { flex: 1, alignItems: 'center', gap: 2, userSelect: 'none' },
  icono: {
    width: 44, height: 28, borderRadius: R.pastilla,
    alignItems: 'center', justifyContent: 'center',
  },
  globo: {
    position: 'absolute', top: -2, right: 4,
    minWidth: 15, height: 15, borderRadius: 8, paddingHorizontal: 3,
    backgroundColor: C.marca, alignItems: 'center', justifyContent: 'center',
  },
  globoTexto: {
    color: '#FFFFFF', fontFamily: T.destacado.fontFamily, fontSize: 9, lineHeight: 12,
  },
});
