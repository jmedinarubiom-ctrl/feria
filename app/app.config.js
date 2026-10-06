/**
 * Configuración de la app que depende de para qué se compila.
 *
 * Todo lo fijo sigue en `app.json`; acá solo va lo que cambia según
 * el perfil de EAS.
 */
const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Permite `http://` en Android.
 *
 * Hace falta para probar contra el computador en la red local, que
 * no tiene HTTPS. Android lo bloquea por defecto en una app
 * compilada («CLEARTEXT communication not permitted»).
 *
 * `app.json` tenía `android.usesCleartextTraffic`, pero esa clave
 * no existe en la configuración de Expo y nunca llegó al manifiesto:
 * por eso la APK no podía hablarle al Mac por wifi. Acá se escribe
 * directo en el AndroidManifest.
 */
const conHttp = (config) => withAndroidManifest(config, (c) => {
  c.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
  return c;
});

module.exports = ({ config }) => {
  const { usesCleartextTraffic: _noExiste, ...android } = config.android ?? {};
  const base = { ...config, android };
  // En el build que va a la tienda queda prohibido: todo lo que la
  // app mande —el teléfono, la dirección, el token de sesión— tiene
  // que ir por HTTPS.
  return process.env.EAS_BUILD_PROFILE === 'produccion' ? base : conHttp(base);
};
