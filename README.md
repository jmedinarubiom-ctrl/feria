# Feria

Sistema de pedidos a domicilio para ferias libres, modelo **vendedor único**:
la plataforma cobra al cliente, los feriantes aceptan pedidos por broadcast,
un repartidor retira en los puestos y entrega, y a los feriantes se les paga
en efectivo en la tarde.

Feria de referencia: **Av. Argentina, Valparaíso**.

---

## Qué hay acá

```
feria/
├── backend/       Motor de despacho — Node 24 + PostgreSQL, sin build
└── app/           App móvil — Expo (cliente, feriante, repartidor, operador)
```

El backend es el corazón: catálogo, pedidos, broadcast a los feriantes, cascada
de ofertas y rutas de retiro. El cobro lo hace Mercado Pago.

---

## Cómo revisarlo

```bash
./probar.sh
```

Levanta el backend, siembra pedidos en distintos estados y abre la app en el
simulador de iPhone. Con `./probar.sh telefono` muestra un QR para escanear con
Expo Go desde el celular (tiene que estar en la misma wifi).

Los códigos de ingreso salen por la consola del backend **y** en la propia
pantalla, así que no hace falta Twilio para probar.

---

## Cómo correrlo

Requiere **Node 24+**. No hay paso de compilación: Node ejecuta TypeScript directo,
y no hace falta instalar ninguna base de datos.

```bash
cd feria/backend && npm install && npm start
```

Sin `DATABASE_URL` el servidor levanta **PGlite**: PostgreSQL compilado a
WebAssembly, corriendo dentro del mismo proceso. Es Postgres de verdad —mismo
dialecto, mismas transacciones— así que lo que funciona en desarrollo funciona
igual en el servidor. Con `DATABASE_URL` usa Postgres real.

En otra terminal:

```bash
cd feria/app && npm install && npx expo start
```

Escaneá el QR con Expo Go. La app detecta sola la IP del computador donde
corre el backend, así que no hay que configurar direcciones a mano.

### Ver el flujo completo sin abrir la app

```bash
cd feria/backend && npm run demo
```

Narra un pedido de punta a punta: se parte por rubro, dos feriantes aceptan,
el pescado no lo toma nadie y cae en tu cola, el repartidor recorre los
puestos, y al final muestra a quién le pagas y cuánto.

### Tests

```bash
cd feria/backend && npm test
```

103 tests corriendo contra PostgreSQL real (PGlite en memoria).

Del motor: la carrera de aceptación —incluidas dos aceptaciones simultáneas—,
la cascada, el fallback a autogestión, el armado del viaje, las liquidaciones y
la idempotencia del webhook.

De la sesión: el tope de intentos por código, que el código y el token nunca se
guarden en limpio, que un número desconocido reciba la misma respuesta que uno
registrado, y que cerrar sesión invalide el token en el acto.

Del push: que solo se avise a los feriantes del rubro, que el aviso venza junto
con la oferta, que los tokens muertos se limpien solos y que una caída de Expo
no tumbe un despacho.

Del cobro: que el despacho se cobre y se vuelva gratis en el umbral, que un
carro bajo el mínimo se rechace y que el margen del día cuadre.

De la auditoría (`test/auditoria.test.ts`): siete casos que reproducían bugs
reales encontrados revisando el código, y que ahora fijan el comportamiento
correcto.

Del horario: que la hora se calcule en Valparaíso y no en el servidor, que deje
de tomar pedidos antes de que cierre la feria, y los límites exactos.

De la cancelación: que a un feriante que ya aceptó se le pague igual, que las ofertas abiertas se
cierren sin castigar a nadie, y que un fallo del reembolso no impida cancelar.

Del catálogo: que cambiar un precio no altere pedidos existentes, que no se
pueda vender bajo el costo y que un producto apagado siga listado.

Del pago: que un pedido sin pagar no llegue a ningún feriante, que se cobre el
total con despacho, que un aviso repetido no despache dos
veces, que un monto que no coincide se rechace, y que sin pasarela configurada
en producción no se regale mercadería.

---

## Desplegar

Hay un `Dockerfile` listo. Sirve en Railway, Render, Fly o cualquier cosa que
corra un contenedor.

1. Crea una base Postgres administrada (Railway, Render, Neon y Supabase tienen
   plan gratis para empezar).
2. Configura las variables de `.env.example` en el servicio. `DATABASE_URL` y
   `FERIA_SECRETO` son obligatorias: sin la segunda el servidor no arranca en
   producción, a propósito.
3. Despliega. El esquema se aplica solo al arrancar.

```bash
# Generar el secreto
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Cuidado con `FERIA_SECRETO`:** si cambia, todas las sesiones abiertas dejan
de valer y los ocho feriantes tienen que volver a entrar. Guardalo donde no se
pierda.

El endpoint `/salud` sirve como health check y dice contra qué base está
corriendo. `/dev/vencer-ofertas` se apaga solo cuando `NODE_ENV=production`.

**Sobre las migraciones:** el esquema se aplica con `CREATE ... IF NOT EXISTS`,
que alcanza para crear todo de cero pero no modifica tablas que ya existen. En
cuanto el esquema empiece a cambiar en producción, esto tiene que pasar a
migraciones numeradas.

### Entrar a la app

Se entra con el teléfono: llega un código de 6 dígitos y queda una sesión de
90 días. **El rol lo decide el servidor según el número**, nadie elige de qué
lado del mostrador está.

Sin Twilio configurado los códigos no se mandan por SMS: salen por la consola
del servidor y además vienen en la respuesta, así que se puede probar sin
contratar nada. Teléfonos de la semilla:

| Quién | Teléfono |
|---|---|
| José Sandoval (verduras) | `+56 9 1111 1111` |
| Ana Poblete (verduras y frutas) | `+56 9 2222 2222` |
| Carmen Vidal (frutas) | `+56 9 3333 3333` |
| Pedro Cáceres (pescado) | `+56 9 6666 6666` |
| Diego Araya (repartidor) | `+56 9 0000 0001` |
| Operador | `+56 9 0000 0009` |

El cliente entra igual, con su teléfono: cualquier otro celular chileno queda
registrado como cliente la primera vez que confirma su código.

---

## Cómo funciona la sesión

```
El feriante escribe su número
   ↓
Código de 6 dígitos por SMS, vence en 5 minutos
   ↓  (5 intentos y el código muere; 3 códigos por número cada 15 min)
Se canjea por un token de 90 días, guardado en el llavero del teléfono
   ↓
Cada petición lleva Authorization: Bearer <token>
```

Ni el código ni el token se guardan en limpio: en la base viven sus hashes. Y
pedir un código para un número que no está registrado devuelve exactamente lo
mismo que para uno que sí, para que nadie pueda averiguar quiénes son los
feriantes probando números.

Si alguien pierde el teléfono, `POST /auth/salir-de-todos` cierra todas sus
sesiones de una.

---

## Identidad visual

Verde manzana sobre blanco, tipografías redondas: la marca es fresca y amable,
no una herramienta técnica. Todo sale de `app/src/tema.ts` — colores, escala
tipográfica y radios. No hay colores sueltos en las pantallas.

- **Verde de marca** `#8FC33F`, con `#5F8F28` para texto sobre claro y `#4E8127`
  en la hoja de la manzana.
- **Neutros con una pizca de verde** (`#FBFCF8`, `#F2F6EA`, `#E1E8D5`) para que
  no se vean grises sueltos al lado del acento.
- **Fredoka** para lo que grita —el monto de una oferta— y **Nunito** para lo
  que se lee. Las dos redondas, como las letras del logo.

El fondo es claro también por una razón práctica: la app se usa en la calle a
las nueve de la mañana, y **bajo el sol una pantalla clara con texto oscuro se
lee mucho mejor que una oscura**, porque tiene más luminancia contra la luz
ambiente. La primera versión era oscura justificada al revés.

El logotipo se dibuja con la tipografía más un SVG (`app/src/Logotipo.tsx`) en
vez de una imagen, así escala sin pixelarse. La «i» va sin punto (`ı`, U+0131)
porque la manzana **es** el punto.

### Los íconos

Se generan con `node app/herramientas/generar-iconos.ts`, que escribe los PNG a
mano con `zlib`. No hay ImageMagick en la máquina y no valía la pena agregar una
dependencia nativa para dibujar una manzana.

La forma sale de fundir tres círculos («metaballs») en vez de unirlos: la unión
dura deja muescas donde se cruzan los bordes, y eso en un ícono se nota. Encima
va un círculo que muerde el tope para la hendidura.

Si cambia el verde de la marca, se edita el script y se vuelve a correr — no hay
que rehacer nada a mano.

---

## Horario de la feria

```
Miércoles y sábado · abre 07:00 · último pedido 13:30 · cierra 15:00
```

**El último pedido es antes del cierre a propósito.** Entre que se oferta, un
feriante prepara, el repartidor recorre los puestos y llega al domicilio pasa
más de una hora; un pedido aceptado a las 14:55 no alcanza a salir.

Fuera de horario el pedido se rechaza con el mensaje de cuándo abre, y la app
del cliente lo muestra **antes** de que arme el carro, no al ir a pagar. La hora
se calcula en Valparaíso, no en el servidor.

Se configura en `backend/src/config.ts`.

Para desarrollar un martes hay `FERIA_SIEMPRE_ABIERTA=1`, que abre la feria
todos los días. Se ignora cuando `NODE_ENV=production`: dejarla abierta de
verdad un martes significa pedidos que nadie puede cumplir.

**Un pago que llega tarde sí entra**, aunque la reserva del pedido ya haya
vencido: la plata ya se cobró, y rechazarlo dejaría al cliente sin pedido y sin
devolución.

---

## Cómo se cobra

```
El cliente arma el carro
   ↓
Pedido creado en PENDIENTE_PAGO    ← no sale a la feria todavía
   ↓
Checkout alojado de Mercado Pago (tarjeta o transferencia)
   ↓
Mercado Pago avisa → le volvemos a preguntar a Mercado Pago
   ↓
PAGADO → recién ahora se ofrece a los feriantes
```

**Nada se despacha antes de cobrar.** Sin ese estado, ocho feriantes podían
ponerse a preparar mercadería de un pedido que nadie pagó.

El checkout es alojado: el cliente paga en la página de Mercado Pago y vuelve. Por la
app nunca pasa un número de tarjeta, así que el sistema queda fuera del alcance
de PCI.

**La confirmación de Mercado Pago no se cree.** El aviso llega por HTTP abierto y
cualquiera puede inventarlo, así que al recibirlo se le pregunta a Mercado Pago con
una petición nuestra, y además se compara el monto: si no coincide con el del
pedido, no se despacha nada.

Los pedidos de gente que abrió el checkout y no volvió expiran solos a los
20 minutos.

### Precios

```
Productos (precio fijo de plataforma)
+ Despacho $2.500          ← gratis sobre $25.000
─────────────────────────
= Lo que paga el cliente

Pedido mínimo: $8.000
```

El despacho es **ingreso**, y la tarifa del repartidor es **costo**. No son el
mismo número y no tienen por qué serlo: un pedido de tres rubros cuesta $3.500
de reparto, así que los pedidos de un solo puesto subsidian a los de varios.

Los dos umbrales son las palancas del negocio:

- **Envío gratis sobre $25.000.** Al cliente le conviene agregar mercadería
  antes que pagar el envío, y a ti te conviene que la agregue: el reparto
  cuesta lo mismo lleve poco o mucho.
- **Pedido mínimo de $8.000.** Debajo de eso ningún pedido paga su propio
  viaje. Hay un test que lo demuestra con los precios reales del catálogo.

Están en `backend/src/config.ts`. Cambialos con los datos de la tabla `pedidos`,
no por intuición.

### Pagos a feriantes

Lo **ganado** y lo **entregado** son cosas separadas. Si le pagas a media tarde
y después toma dos pedidos más, su app muestra los tres números:

```
ganó $12.000 · recibió $6.000 · le deben $6.000
```

Y si le pagas la diferencia, tiene que volver a confirmar: confirmó haber
recibido otra cantidad. Sin esa separación, decirle «ya cobraste todo» cuando
todavía le debes es una discusión asegurada a la hora de cerrar.

### El catálogo

Los precios se editan desde la app, en la pestaña **Catálogo** del panel de
operador. Está pensada para usarse parado en la calle un viernes: se toca un
precio, el margen se recalcula mientras escribes, y se guarda de a un producto.

Dos cosas que impiden perder plata sin darse cuenta:

- **No deja vender bajo el costo.** Es un error, no un aviso: un dedo torpe a
  las seis de la mañana que deja el tomate bajo costo cuesta plata todo el
  sábado, y nadie lo mira hasta la noche.
- **Cambiar un precio no toca los pedidos que ya existen.** Los items guardan su
  propia copia, así que el cliente paga lo que vio y al feriante se le paga lo
  que se le prometió. Hay un test que lo comprueba.

Los productos se pueden apagar sin borrarlos —fuera de temporada no se venden
pero vuelven— y cada cambio de precio queda en el historial, para poder
responder «¿cuándo subió el tomate y en cuánto?».

### El número que importa

El panel del operador muestra la cuenta completa de lo entregado en el día:

```
Ingresos                 $11.300
Mercadería a feriantes   -$6.000
Repartidores             -$2.500
Comisiones                 -$655
────────────────────────────────
Te queda                  $2.145   (19% de la venta)
```

Sin esa tarjeta solo se ve la venta, que sube igual aunque cada pedido pierda
plata. Las comisiones se estiman con `TASA_COMISIONES` (por defecto 3,8%:
Mercado Pago Checkout Pro con el dinero al instante, 3,19% + IVA).

---

## Cancelación

```
Antes de entregar  →  cancela el operador, y al feriante se le paga igual
Ya se entregó      →  no se cancela; eso es un reclamo
```

**El cliente no puede cancelar solo.** Del otro lado hay gente que ya se movió
—un feriante apartando mercadería, un repartidor en camino— y esa decisión
necesita a alguien que sepa en qué estado está el pedido, no un botón. En la app
del cliente, donde estaba el botón, ahora hay un teléfono.

Eso además cierra un agujero: la ruta de cancelar era pública y el identificador
del pedido hacía de credencial.

**Al feriante que ya aceptó se le paga igual.** Apartó la mercadería de buena fe
y no tiene culpa de que el pedido se cayera; cobrarle el error sería la forma
más rápida de que deje de contestar el teléfono. Esos sub-pedidos quedan
marcados como `compensado` y entran en su liquidación de la tarde igual que una
entrega normal.

Eso significa que **una cancelación cuesta plata de verdad**, así que aparece
como una línea propia en la cuenta del día:

```
Comisiones                 -$655
Cancelaciones (1)        -$6.000
────────────────────────────────
Te queda                 -$6.000
```

El reembolso se pide a Mercado Pago fuera de la transacción: si la pasarela no responde,
la cancelación ocurre igual —lo importante es que nadie siga preparando un
pedido muerto— y queda anotado en `/operador/reembolsos-pendientes` para
resolverlo a mano.

---

## Notificaciones

El aviso al feriante sale por la **API de Expo**, que habla con APNs y FCM sin
que haya que configurar Firebase ni certificados de Apple.

```
Se abre una ronda de ofertas
   ↓  (después del COMMIT, nunca antes)
Push al teléfono de cada feriante del rubro
   título:  $4.200 · Verduras        ← el monto primero
   cuerpo:  2× Tomate, 1× Cebolla
   ttl:     lo que le queda a la oferta
```

Tres detalles que no son adorno:

- **El TTL vence junto con la oferta.** Un aviso que llega a los tres minutos
  manda al feriante a una pantalla vacía, que es peor que no avisar.
- **Canal propio en Android para las ofertas**, en importancia máxima. El
  usuario puede silenciar un canal pero no la app puede juntarlos: si las
  ofertas compartieran canal con los avisos menores, silenciar uno silenciaría
  el otro.
- **`interruptionLevel: timeSensitive` en iOS**, que es lo más cerca de una
  llamada entrante que se puede estar sin ser una app de VoIP: atraviesa los
  modos de concentración.

Los tokens muertos se limpian solos: si Expo responde `DeviceNotRegistered`
—alguien desinstaló la app— el `push_token` se borra de la base.

Si Expo se cae, el despacho sigue igual. El push es un extra sobre el aviso por
WebSocket, no un requisito; hay un test que lo comprueba.

### ⚠️ Push no funciona en Expo Go

Desde el SDK 53 las notificaciones remotas se sacaron de Expo Go. Para
probarlas hace falta un **development build**:

```bash
cd feria/app && npx eas init && npx expo run:ios
```

`eas init` escribe el `projectId` en `app.json`, que es lo que necesita la app
para pedir su token de push. Sin él la app no revienta: muestra un aviso de que
las notificaciones están apagadas y sigue funcionando con el WebSocket.

---

## Cómo funciona el despacho

```
Cliente paga
   ↓
El pedido se parte en SUB-PEDIDOS, uno por rubro
   (ningún puesto vende verdura, fruta y pescado a la vez)
   ↓
Cada sub-pedido sale a ofertarse por separado:
   Ronda 1 — feriantes del rubro, mejor reputación, 90 s
   Ronda 2 — todos los del rubro, 60 s
   Ronda 3 — toda la feria, 60 s
   ↓
Gana el primero que acepta (UPDATE condicional: no hay empates)
   ↓
Si nadie acepta → AUTOGESTIÓN: cae en tu cola y lo compras tú
   ↓
Con todos los sub-pedidos asignados se arma el VIAJE:
   una parada por puesto (agrupadas si el mismo puesto tomó varios)
   + la entrega al cliente
   ↓
Repartidor recorre en orden → ENTREGADO
   ↓
En la tarde: liquidación por feriante, pago en efectivo,
el feriante confirma en su app que recibió
```

La autogestión **no es un error**: es el estado que garantiza que ningún
cliente se quede sin pedido. Está en el modelo de datos, en las métricas y
en tu panel.

### Los parámetros que son el producto

En `backend/src/config.ts`: cuántas rondas, a cuántos feriantes, cuántos
segundos por ventana, cuánto paga un viaje. Cambiar esos números cambia la
experiencia más que cualquier pantalla. Ajústalos con los datos de la tabla
`ofertas`, no por intuición.

---

## Las métricas que importan

En tu panel de operador:

| Métrica | Qué te dice |
|---|---|
| **Tasa de aceptación** | Cuántas ofertas terminan en un feriante diciendo que sí |
| **Lo hiciste tú** | Qué porción del trabajo terminaste haciendo personalmente |

La segunda es la que decide si esto es un negocio o un empleo. Si se mantiene
alta, no tienes una plataforma: tienes un trabajo de comprador con pasos extra.
La columna se pone naranja sobre 15% y roja sobre 30%.

---

## Antes de abrirlo al público

Estas cosas están resueltas de forma provisoria a propósito, para poder
probar en la feria esta semana. No las dejes así:

- **Configurar Twilio.** La autenticación está lista, pero sin `TWILIO_*` los
  códigos salen por consola en vez de por mensaje. Es la única pieza que falta
  para que el ingreso funcione con feriantes reales.
- **Development build para el push.** El envío está construido y probado, pero
  las notificaciones remotas no corren en Expo Go: hace falta `eas init` y un
  development build. Hasta entonces la app avisa que están apagadas.
- **Mapa real.** El repartidor abre Apple Maps con las coordenadas. Falta el
  mapa embebido con la ruta y el seguimiento en vivo para el cliente
  (Mapbox o Google Maps SDK).
- **Contador y SII.** Eres vendedor único: emites boleta al cliente y compras
  a feriantes que no dan documento. Eso se resuelve con **factura de compra
  con retención**. Anda a un contador antes de escalar, no después.

---

## Lo que hay que probar antes de programar más

Un grupo de WhatsApp con 8 feriantes y dos sábados de pedidos hechos a mano.
La pregunta no es si el software funciona — funciona, hay tests. La pregunta
es si **el feriante contesta el teléfono a las 9 de la mañana con el puesto
lleno**. Si no contesta en WhatsApp, tampoco va a contestar en la app.

Ese es el único riesgo que puede matar el proyecto, y no se resuelve con
código.
