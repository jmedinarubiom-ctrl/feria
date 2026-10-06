/**
 * Manda un correo de prueba con la configuración de `.env`.
 *
 *   npm run probar-correo -- tu@correo.cl
 *
 * Sirve para saber si el envío está bien configurado sin tener que
 * pasar por la app: dice si salió y, si no, qué revisar.
 */
import { enviarCorreo, proveedorCorreo } from './correo.ts';

const destino = process.argv[2];
if (!destino || !destino.includes('@')) {
  console.error('Falta el correo de destino:  npm run probar-correo -- tu@correo.cl');
  process.exit(1);
}

const proveedor = proveedorCorreo();
if (proveedor === 'consola') {
  console.error(
    'No hay envío de correo configurado. En backend/.env completa\n'
    + 'CORREO_SMTP_USUARIO y CORREO_SMTP_CLAVE (ver .env.example).');
  process.exit(1);
}

console.log(`Enviando a ${destino} por ${proveedor}…`);
const r = await enviarCorreo(destino, 'Prueba de la Feria',
  'Si estás leyendo esto, el envío de correos de la Feria funciona.');
if (r.enviado) {
  console.log('✓ Enviado. Revisa la bandeja de entrada (y la de spam).');
} else {
  console.error(`✗ No se pudo enviar. ${r.detalle ?? ''}`);
  process.exit(1);
}
