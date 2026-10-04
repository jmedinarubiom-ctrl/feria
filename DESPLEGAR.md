# Poner la feria en internet

Hoy el backend corre en tu computador. Para usarlo un sábado de
verdad tiene que vivir en un servidor: encendido siempre, con
dirección fija y HTTPS.

Todo lo que se puede dejar preparado está hecho. Lo que falta son
dos cuentas que solo puedes crear tú.

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

   Twilio queda vacío: sin él, los códigos de acceso los pasas desde
   el panel, que es lo que conviene para diez personas.

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

**El driver de Postgres nunca corrió contra un Postgres de verdad.**
Todo el desarrollo fue con PGlite, que es PostgreSQL 18 compilado a
WebAssembly: el dialecto SQL es el mismo, así que el riesgo es bajo,
pero no es cero. Lo que puede fallar está en el pool de conexiones y
en las transacciones, no en las consultas.

Después del primer despliegue, revisa que anden:

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
