# Poner la feria en internet

Hoy el backend corre en tu computador. Para usarlo un sábado de
verdad tiene que vivir en un servidor: encendido siempre, con
dirección fija y HTTPS.

Todo lo que se puede dejar preparado está hecho. Lo que falta son
dos cuentas que solo puedes crear tú.

---

## ¿Tiene que ser Render?

No. Render es donde quedó preparado, no un requisito. Lo que el
backend necesita de verdad son tres cosas, y cualquier lugar que las
dé sirve:

1. **Un proceso que no se duerma.** Las ofertas vencen por un reloj
   que corre dentro del servidor. Esto es lo único que cuesta plata:
   los planes gratuitos (Render free y parecidos) apagan el servicio
   cuando nadie lo usa.
2. **Una base Postgres**, o un disco que no se borre (sin
   `DATABASE_URL` el backend guarda todo en PGlite, en `FERIA_DATOS`).
3. **HTTPS con dirección fija**, para la app y para Mercado Pago.

Con eso, de más caro a más barato (precios aproximados, revísalos
antes de decidir):

| Opción | Costo | Qué cambia |
|---|---|---|
| Render, servidor + base (lo que arma `render.yaml`) | ~USD 14/mes | Nada: es el camino ya preparado. Respaldos diarios de la base incluidos. |
| Render solo el servidor + base gratis en Supabase | ~USD 7/mes | Borras el bloque `databases:` de `render.yaml` y pones `DATABASE_URL` a mano. Los respaldos de la base pasan a ser tuyos (`./respaldar.sh`). |
| Un servidor chico con disco (Fly.io, Railway, un VPS) | ~USD 3–6/mes | El mismo `Dockerfile`. Con base en Supabase, o sin `DATABASE_URL` y con PGlite en el disco. |
| Tu Mac con `./feria.sh` | USD 0 | Sirve para probar con feriantes. No para un sábado de verdad: si se corta la luz o el internet de tu casa mientras estás en la feria, no hay feria. |

**Lo que no sirve** es un plan gratuito que duerme, por lo del punto 1.

Si usas Supabase: en *Connect* copia la cadena del **Session pooler**
(puerto 5432), no la directa — la directa es solo IPv6 y la mayoría
de los hostings salen por IPv4.

---

## Lo que ya está listo

- `Dockerfile` con chequeo de salud y cierre ordenado
- `render.yaml`: describe el servidor y la base; Render lo lee y
  arma las dos cosas con las variables conectadas
- Migraciones numeradas que corren solas al arrancar
- Un solo repositorio con todo adentro, sin secretos

## Lo que tienes que hacer tú

### 1. Subir el código a GitHub

Render despliega desde un repositorio. Crea uno en
[github.com/new](https://github.com/new) — **privado**, porque acá
hay precios de costo y teléfonos de gente real — y después:

    cd ~/feria
    git remote add origin https://github.com/TU-USUARIO/feria.git
    git push -u origin main

### 2. Crear el servicio en Render

1. Entra a [render.com](https://render.com) y conecta tu GitHub.
2. **New → Blueprint** → elige el repositorio `feria`.
3. Render lee `render.yaml` y te muestra lo que va a crear: el
   servidor y la base de datos. Acepta.
4. Te va a pedir los valores marcados como secretos:

   | Variable | Qué poner |
   |---|---|
   | `MP_ACCESS_TOKEN` | El Access Token **de producción** de Mercado Pago |
   | `OPERADOR_TELEFONO` | Tu teléfono, con el que entras como operador |
   | `TELEFONO_CONTACTO` | El número que ve el cliente para llamar |

   Twilio (SMS) es una de las formas de entrar; las otras están en
   «Cómo entra la gente», más abajo. Sin ninguna configurada, los
   compradores no pueden entrar.

### 2b. Cómo entra la gente

Hay cuatro formas de entrar y cada una se enciende por separado. El
servidor le dice a la app cuáles están andando y la app muestra solo
esas.

| Ingreso | Para quién | Qué hay que configurar | Costo |
|---|---|---|---|
| Código por SMS | Todos. Es el único que sirve para feriantes y repartidores | `TWILIO_*` (cuenta en twilio.com) | Cada mensaje se paga |
| Código al correo | Compradores | `RESEND_API_KEY` y `CORREO_REMITENTE` (cuenta en resend.com y un dominio verificado ahí) | Tiene plan gratuito |
| Google | Compradores | `GOOGLE_CLIENT_IDS` en el servidor y los mismos identificadores en la app | Gratis |
| Apple | Compradores, solo en iPhone | `APPLE_CLIENT_IDS=cl.feria.app` y la cuenta de Apple Developer | USD 99 al año |

A tu equipo le puedes seguir dictando el código desde el panel sin
gastar un SMS. Para abrirle a compradores alcanza con **uno** de los
cuatro: lo más barato es el código al correo.

**Google**, cuando lo quieras encender:

1. En [console.cloud.google.com](https://console.cloud.google.com)
   crea un proyecto y la pantalla de consentimiento de OAuth.
2. En *Credenciales* crea un «ID de cliente de OAuth» por cada
   plataforma: iOS (con el identificador `cl.feria.app`), Android
   (paquete `cl.feria.app` y la huella SHA-1 del build de EAS) y web.
3. Pon los tres, separados por coma, en `GOOGLE_CLIENT_IDS` del
   servidor.
4. En `app/eas.json`, en el `env` del perfil con el que compilas,
   agrega `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`,
   `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` y
   `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, y recompila.

**Apple**: con la cuenta de Apple Developer, activa «Sign in with
Apple» para el identificador `cl.feria.app`, pon
`APPLE_CLIENT_IDS=cl.feria.app` en el servidor y compila para iOS.
Apple exige ofrecer este ingreso si la app ofrece el de Google.

Estos dos están programados y la verificación del servidor está
probada, pero **nunca corrieron contra Google ni Apple de verdad**:
hacen falta las cuentas. Cuenta con una vuelta de ajuste la primera
vez que los enciendas.

### 3. Apuntar la app al servidor

Cuando termine, Render te da una dirección tipo
`https://feria-backend.onrender.com`. En la app, pantalla de
ingreso → tocar la dirección de abajo → pegarla.

Para que el APK la traiga de fábrica, cambia en `eas.json`:

    "env": { "EXPO_PUBLIC_FERIA_API": "https://feria-backend.onrender.com" }

y saca `android.usesCleartextTraffic` de `app.json` — estaba solo
para permitir el `http://` de la red local. Después:

    cd app && npx eas-cli build --platform android --profile apk

### 4. Avisarle a Mercado Pago

En el panel de Mercado Pago, **Webhooks**, registra:

    https://feria-backend.onrender.com/webhooks/mercadopago

No es obligatorio —el servidor le pregunta por los cobros abiertos
cada 8 segundos igual— pero con el webhook la confirmación es
inmediata en vez de tardar unos segundos.

---

## Cuánto cuesta

| | |
|---|---|
| Servidor (`starter`) | ~USD 7 al mes |
| Base de datos (`basic-256mb`) | ~USD 7 al mes |
| **Total** | **~USD 14 al mes** |

Con el margen de un día y medio de feria se paga el mes entero.

### Por qué no el plan gratuito

Render apaga los servicios gratuitos cuando nadie los usa y tarda
cerca de un minuto en despertarlos. Para un sitio común es un
detalle. Acá rompe el producto:

- **Las ofertas vencen a los 90 segundos**, y eso lo cuenta un reloj
  dentro del servidor. Dormido no corre: el pedido se queda
  esperando para siempre en el primer puesto y nunca pasa al
  siguiente.
- El WebSocket que mantiene las pantallas al día se corta.
- El primer cliente del día espera un minuto para ver el catálogo.

---

## Lo que hay que mirar el primer día

**El driver de Postgres ya corrió contra un Postgres de verdad**
(PostgreSQL 18, local): pasa la batería completa, incluidas las
pruebas de carreras que con PGlite no se pueden hacer —varios
feriantes aceptando a la vez, el pago confirmado por tres caminos—.
Para repetirlo contra cualquier base vacía:

    cd backend
    DATABASE_URL=postgresql://… npm run test:postgres

Ojo: esas pruebas **vacían la base** que les pases. Nunca la de
producción.

Lo que no se probó es la base administrada en sí (su SSL, sus
cortes de conexión). Después del primer despliegue, revisa que anden:

    curl https://TU-DIRECCION/salud        # motor: postgres
    curl https://TU-DIRECCION/feria/estado
    curl https://TU-DIRECCION/catalogo

Y haz un pedido completo de punta a punta antes de abrirle a nadie.

**El certificado de la base se acepta sin verificar**
(`rejectUnauthorized: false` en `db/index.ts`). Es lo que hace casi
todo el mundo con bases administradas, pero si Render publica su
certificado raíz conviene usarlo.

---

## Respaldos

El script está, pero nadie lo corre solo:

    ./respaldar.sh

Con Postgres administrado, Render ya hace respaldos diarios en los
planes pagos. Lo que **no** respalda son las fotos que suba el
operador: esas viven en el disco montado en `/datos`.

---

## Lo que sigue faltando

- **Boleta electrónica (SII)**: eres el vendedor único, la boleta de
  cada venta es tuya. Es el único bloqueante legal.
- **Correo de respaldo al cliente** por cada pedido.
- **Ícono de tienda**: el logo original es 266×302 y el ícono de
  1024 px es una ampliación de 2,4×. Para publicar hace falta el
  archivo en alta.
