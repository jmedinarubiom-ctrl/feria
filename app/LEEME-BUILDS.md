# Builds

`apk` es para probar en un teléfono de verdad: se instala directo,
sin pasar por Play, y a diferencia de Expo Go **sí recibe push**.

`EXPO_PUBLIC_FERIA_API` apunta al backend. Hace falta porque una app
standalone no tiene cómo descubrirlo sola: en Expo Go esa dirección
sale de Metro, y acá no hay Metro. Hoy apunta a la IP del computador
en la red local, así que el teléfono tiene que estar en la misma wifi.

Cuando el servidor esté desplegado:

1. Cambiar esa IP por el dominio con `https://`.
2. Sacar `android.usesCleartextTraffic` de `app.json` — está solo
   para que Android 9+ no bloquee el `http://` de la red local.

    npx eas-cli build --platform android --profile apk
