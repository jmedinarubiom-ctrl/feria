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

    cd backend && npm test   # 218 pruebas (6 de carreras se saltan sin Postgres)
    cd backend && DATABASE_URL=… npm run test:postgres   # todas, contra Postgres real. VACÍA esa base.
    cd app && npx tsc --noEmit

El panel de administración está en `http://localhost:4000/admin`.

## Usuarios de prueba

Nadie tiene contraseña. Feriantes, repartidores y el operador entran
con un código por SMS a su teléfono. El comprador puede entrar igual,
o con un código al correo, o con Google o Apple (estos dos, apagados
hasta configurar las cuentas). Sin proveedor configurado el código
sale por pantalla y por la consola del servidor. Un número o correo
que no es de nadie queda registrado como cliente la primera vez que
confirma su código.

| Rol | Teléfono |
|---|---|
| Operador (Juan Manuel) | `+56900000009` |
| Feriante (José, verduras) | `+56911111111` |
| Repartidor (Diego) | `+56900000001` |
| Repartidor (Sofía) | `+56900000002` |

Hay ocho feriantes, `f-jose` a `f-hector`; ver `backend/src/db/semilla.ts`.
Son solo de desarrollo: con `NODE_ENV=production` la base arranca sin
gente, y los feriantes y repartidores de verdad se cargan en el panel
(Gente → Agregar).
Para probar como cliente: cualquier otro celular chileno, por ejemplo
`+56987654321`, o cualquier correo.

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
- **El comprador tiene cuenta por teléfono.** `POST /pedidos` exige
  sesión de cliente y el pedido queda con su `cliente_id`. Los
  campos del cuerpo se copian de a uno; nunca `...c.cuerpo`.
- **Correo, Google y Apple solo dan cuenta de comprador.** Los
  roles de la feria se abren únicamente con el teléfono, que es el
  número confirmado al que se llama. Quien entró sin teléfono no
  puede pedir ser feriante ni repartidor.
- **Los tokens de Google y Apple se verifican en el servidor**
  (`dominio/externo.ts`): firma, emisor, para qué app y vencimiento.
  Nunca se le cree a la app quién es la persona.
- **Nadie se hace feriante o repartidor solo.** Desde la app se
  pide (Perfil → «¿Tienes un puesto o repartes?») y queda pendiente
  hasta que el operador lo aprueba en el panel. Mientras, y si lo
  rechazan o lo dan de baja, ese número entra como cliente.
- **Lo que no es del operador no muestra costos.** `/catalogo` y
  `/pedidos/:id` no traen `precio_costo` ni `monto_feriante`. Un
  pedido lo ve el operador y el cliente que lo hizo, nadie más.
- **El WebSocket se identifica con el token**, no con `?rol=` en la
  URL. Solo el cliente entra sin token, con el id de su pedido.
- **Un pago que llega tarde revive el pedido expirado.** Plata
  cobrada es un pedido que sale.
- **Solo Mercado Pago, y sin Shopify.** Se sacaron Flow y el webhook
  de Shopify: los pedidos entran solo por la app y se cobran solo
  con Mercado Pago. La interfaz `Pasarela` queda para los tests.
- **Las fotos de referencia viajan con el código** (`backend/src/fotos`),
  no en disco de datos: así un despliegue no deja el catálogo sin
  imágenes. Las que sube el operador sí van a `FERIA_DATOS`.

## Lo que falta, en orden

1. **Desplegar.** Todo listo: `render.yaml`, `DESPLEGAR.md`. Render
   no es obligatorio — `DESPLEGAR.md` tiene las alternativas; la más
   barata razonable es Render solo servidor + Supabase gratis
   (~USD 7/mes). Falta que Juan Manuel decida y ponga tarjeta.
   Mientras tanto `./feria.sh` da una dirección pública desde su
   Mac, pero localtunnel es inestable: ya falló tres veces (cambió
   de subdominio, 408, 503). Con `./feria.sh` el código de ingreso
   NO sale en la pantalla del teléfono (`FERIA_EXPUESTA=1`): se
   genera en el panel, Gente → Código.
   Para abrir hace falta además al menos un ingreso para
   compradores: el más barato es el código al correo (Resend); SMS
   es Twilio y cada mensaje se paga. Google y Apple están
   programados pero sin probar contra los servicios reales: faltan
   las cuentas (pasos en `DESPLEGAR.md`).
2. **Boleta electrónica (SII).** Único bloqueante legal. Es el
   vendedor único: la boleta de cada venta es suya.
3. ~~Probar el driver de Postgres.~~ Hecho contra PostgreSQL 18
   local (`npm run test:postgres`). Falta solo verlo contra la base
   administrada que se elija.
4. **Correo de respaldo al cliente** por cada pedido. No existe.
5. **Logo en alta.** El original es 266×302; el ícono de 1024 px es
   una ampliación de 2,4×. Para publicar en tiendas hace falta el
   archivo grande.

El APK instalado es anterior al WebSocket con token: sigue
funcionando, pero se entera de los cambios cada 5 segundos en vez
de al instante. Hay que recompilarlo.

Pendientes conocidos, sin resolver:

- Una misma persona no puede ser feriante y comprar con el mismo
  número: el teléfono decide un solo rol.
- El freno por IP confía en `x-forwarded-for`, que se puede
  falsificar. Arreglarlo bien exige saber cuántos proxies pone el
  hosting adelante; adivinar mal deja a todos compartiendo un límite.
- Un viaje sin repartidor que lo tome no le avisa a nadie: solo se
  ve en «Pedidos en curso».
- El feriante confirma en su app solo el pago de HOY. Si se le paga
  al día siguiente, no tiene dónde confirmarlo.
- La ubicación de un feriante nuevo queda vacía (no hay dónde
  ponerla en el panel): su parada sale sin botón de mapa.

Sin auditar todavía: carga real (las carreras sí están probadas) y
accesibilidad.

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
