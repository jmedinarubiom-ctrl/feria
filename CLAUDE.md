# Feria Av. Argentina — estado del proyecto

App de delivery para la feria libre de Av. Argentina, Valparaíso.
Escrito en español de Chile (tuteo: *tienes*, *puedes*, *avísame* —
nunca voseo rioplatense).

## El modelo de negocio, que es lo que explica el diseño

- **Vendedor único**: la plataforma cobra y es la responsable
  tributaria. Juan Manuel es el operador.
- **No hay picker**. Cuando entra un pedido se parte por rubro y
  cada parte se **ofrece a todos los feriantes del rubro**. El
  primero que acepta se lo queda.
- **El repartidor va a ese puesto exacto** a retirar, y después
  entrega.
- **A los feriantes se les paga en efectivo, en persona, en la
  tarde.** No por la app.
- **Autogestión**: si nadie acepta en las tres rondas, el pedido
  **no se pierde ni se cancela** — cae en la cola del operador y va
  él a comprarlo. Es un estado real del sistema, no una excepción.

## Cómo correrlo

    ./probar.sh              # backend + datos de ejemplo + Metro
    ./feria.sh               # backend + túnel público (desde cualquier red)
    ./respaldar.sh           # respaldo de base y fotos

    cd backend && npm test   # 162 pruebas
    cd app && npx tsc --noEmit

El panel de administración está en `http://localhost:4000/admin`.

## Usuarios de prueba

Entran por SMS sin contraseña. Sin Twilio configurado el código sale
por pantalla y por la consola del servidor.

| Rol | Teléfono |
|---|---|
| Operador (Juan Manuel) | `+56900000009` |
| Feriante (José, verduras) | `+56911111111` |
| Repartidor (Diego) | `+56900000001` |
| Repartidor (Sofía) | `+56900000002` |

Hay ocho feriantes, `f-jose` a `f-hector`; ver `backend/src/db/semilla.ts`.
El cliente no tiene cuenta: *"Entrar como cliente (prueba)"*.

## Decisiones que no hay que deshacer

- **El motor tiene que estar siempre encendido.** Las ofertas vencen
  a los 90 segundos contados por un reloj *dentro* del proceso. Un
  hosting que duerme el servicio rompe el producto. Por eso el plan
  gratuito de Render no sirve.
- **El webhook de pago no es la fuente de verdad.** Se pierde. El
  servidor le pregunta a la pasarela por los cobros abiertos cada 8
  segundos (`revisarCobrosAbiertos`). El webhook es el camino
  rápido, no el único.
- **El punto del pedido lo decide el servidor**, geocodificando la
  dirección escrita. No se confía en lo que manda la app.
- **El cliente no puede cancelar.** Del otro lado hay un feriante
  apartando mercadería. Se resuelve por teléfono. Cancelar es solo
  del operador.
- **Las fotos de referencia viajan con el código** (`backend/src/fotos`),
  no en disco de datos: así un despliegue no deja el catálogo sin
  imágenes. Las que sube el operador sí van a `FERIA_DATOS`.

## Lo que falta, en orden

1. **Desplegar.** Todo listo: `render.yaml`, `DESPLEGAR.md`. Falta
   que Juan Manuel ponga tarjeta (~USD 14/mes). Mientras tanto
   `./feria.sh` da una dirección pública desde su Mac, pero
   localtunnel es inestable: ya falló tres veces (cambió de
   subdominio, 408, 503).
2. **Boleta electrónica (SII).** Único bloqueante legal. Es el
   vendedor único: la boleta de cada venta es suya.
3. **Probar el driver de Postgres.** Nunca corrió contra un Postgres
   real, solo PGlite. El plan era usar un Supabase gratis para
   ejercitarlo antes de desplegar.
4. **Correo de respaldo al cliente** por cada pedido. No existe.
5. **Logo en alta.** El original es 266×302; el ícono de 1024 px es
   una ampliación de 2,4×. Para publicar en tiendas hace falta el
   archivo grande.

Sin auditar todavía: qué pasa si el backend se cae a mitad de un
pedido, concurrencia bajo carga real, accesibilidad.

## Cuentas y credenciales

- **GitHub**: `jmedinarubiom-ctrl/feria` (privado).
- **Expo**: cuenta `jmedinar`, proyecto `feria`. El `projectId` ya
  está en `app.json`, así que el push funciona en un build de
  verdad — no en Expo Go, que no lo soporta desde el SDK 53.
- **Mercado Pago**: hay credenciales **de prueba** en `backend/.env`
  (usuario de prueba `TESTUSER3721328324878363343`). Las de
  producción requieren verificar identidad con cédula, trámite que
  quedó pendiente.
- **Render**: cuenta creada, sin servicios. Pide tarjeta.

`backend/.env` no está en el repositorio. `backend/.env.example` sí,
con todo explicado.

## Android

    cd app && npx eas-cli build --platform android --profile apk

El APK sale apuntando a lo que diga `EXPO_PUBLIC_FERIA_API` en
`eas.json`. Una app standalone no puede descubrir el backend sola:
en Expo Go esa dirección sale de Metro, y en un APK no hay Metro.

Si queda apuntando mal, **no hace falta recompilar**: en la pantalla
de ingreso se toca la dirección de abajo y se escribe otra.
