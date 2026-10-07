// Arma el sitio público que piden las tiendas de apps: política de
// privacidad, términos, soporte y cómo eliminar la cuenta.
//
//   node --env-file=.env herramientas/sitio.mjs      (deja ../sitio/)
//
// Son páginas sueltas, sin servidor: se suben a cualquier hosting de
// archivos. La función de Supabase no sirve para esto porque entrega
// el HTML como texto plano.
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { textosLegales } from '../src/dominio/privacidad.ts';
import { CONFIG } from '../src/config.ts';

const aqui = dirname(fileURLToPath(import.meta.url));
const destino = join(aqui, '../../sitio');
mkdirSync(destino, { recursive: true });

const seguro = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cuerpoLegal = (texto) => texto.trim().split(/\n\s*\n/).map((crudo, i) => {
  const bloque = crudo.trim();
  if (/^- /.test(bloque)) return '<ul>' + bloque.split(/\n(?=- )/).map((l) => `<li>${seguro(l.replace(/^- /, ''))}</li>`).join('') + '</ul>';
  const b = bloque.replace(/\s*\n\s*/g, ' ');
  if (i === 0) return `<h1>${seguro(b)}</h1>`;
  if (/^[IVX]+\.\s/.test(b) && b.length < 70) return `<h2>${seguro(b)}</h2>`;
  const punto = /^(\d+)\.\s+([^.]{2,60}\.)\s*(.*)$/.exec(b);
  if (punto) return `<p><strong>${punto[1]}. ${seguro(punto[2])}</strong> ${seguro(punto[3])}</p>`;
  return `<p>${seguro(b)}</p>`;
}).join('\n');

const pagina = (titulo, cuerpo) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} — Feria App</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #F4F6F4; color: #16211D; line-height: 1.65; }
  header { background: #8B2838; }
  header div, main, footer { max-width: 720px; margin: 0 auto; padding: 0 20px; }
  header div { display: flex; align-items: center; gap: 12px; padding: 14px 20px; }
  header img { width: 36px; height: 41px; }
  header a { color: #fff; font-weight: 700; font-size: 20px; text-decoration: none; }
  nav { margin-left: auto; display: flex; gap: 16px; flex-wrap: wrap; }
  nav a { font-size: 14px; font-weight: 500; opacity: .9; }
  main { padding: 28px 20px 40px; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 16px; color: #8B2838; }
  h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #0C5C44; margin: 32px 0 8px; }
  p, li { font-size: 16px; } li { margin-bottom: 6px; }
  .tarjeta { background: #fff; border: 1px solid #E4E7E4; border-radius: 16px; padding: 20px; margin: 16px 0; }
  footer { padding: 0 20px 32px; font-size: 13px; color: #6B7670; }
  a { color: #146C54; }
</style></head>
<body>
<header><div><img src="marca.png" alt=""><a href="index.html">Feria App</a>
<nav><a href="privacidad.html">Privacidad</a><a href="terminos.html">Términos</a><a href="eliminar-cuenta.html">Eliminar cuenta</a></nav></div></header>
<main>${cuerpo}</main>
<footer>Feria App · tu feria libre, a domicilio · Región de Valparaíso, Chile</footer>
</body></html>`;

const t = textosLegales();
const correo = CONFIG.legal.proveedor.correo ?? '[por completar: correo de contacto]';
const telefono = CONFIG.telefonoContacto;

writeFileSync(join(destino, 'privacidad.html'), pagina('Política de privacidad', cuerpoLegal(t.privacidad)));
writeFileSync(join(destino, 'terminos.html'), pagina('Términos y condiciones', cuerpoLegal(t.terminos)));
writeFileSync(join(destino, 'index.html'), pagina('Soporte', `
<h1>Feria App</h1>
<p>Compra en la feria libre y recibe en tu casa el mismo día: frutas, verduras, pescados, quesos y abarrotes de las ferias de la Región de Valparaíso.</p>
<div class="tarjeta">
  <h2 style="margin-top:0">Soporte</h2>
  <p>¿Un problema con tu pedido, tu cuenta o un pago? Escríbenos o llámanos:</p>
  <p><strong>Correo:</strong> ${seguro(correo)}<br><strong>Teléfono:</strong> ${seguro(telefono)}</p>
  <p>Respondemos los días de feria, en horario de atención.</p>
</div>
<div class="tarjeta">
  <h2 style="margin-top:0">Preguntas frecuentes</h2>
  <p><strong>¿Cómo entro?</strong> Con tu correo, tu teléfono o tu cuenta de Google o de Apple. No hay contraseñas: te mandamos un código.</p>
  <p><strong>¿Cómo pago?</strong> Con Mercado Pago, dentro de la app. No guardamos los datos de tu tarjeta.</p>
  <p><strong>¿Puedo cancelar?</strong> Un pedido pagado se cambia o cancela llamando a la feria; si se cancela, te devolvemos lo pagado.</p>
  <p><strong>¿Y si algo llega mal?</strong> Avísanos dentro de las 24 horas, idealmente con una foto: lo reponemos o te devolvemos el dinero.</p>
</div>
<p><a href="privacidad.html">Política de privacidad</a> · <a href="terminos.html">Términos y condiciones</a> · <a href="eliminar-cuenta.html">Cómo eliminar tu cuenta</a></p>`));
writeFileSync(join(destino, 'eliminar-cuenta.html'), pagina('Eliminar tu cuenta', `
<h1>Cómo eliminar tu cuenta de Feria App</h1>
<p>Puedes eliminar tu cuenta y tus datos en cualquier momento, desde la misma app y sin pedirle permiso a nadie.</p>
<div class="tarjeta">
  <h2 style="margin-top:0">Si compras</h2>
  <ol><li>Abre la app y entra a <strong>Perfil</strong>.</li><li>Baja hasta <strong>Tus datos</strong>.</li><li>Toca <strong>Eliminar mi cuenta</strong> y confirma.</li></ol>
</div>
<div class="tarjeta">
  <h2 style="margin-top:0">Si vendes o repartes</h2>
  <ol><li>Toca <strong>Salir</strong>, arriba a la derecha.</li><li>Elige <strong>Más opciones</strong>.</li><li>Toca <strong>Eliminar mi cuenta</strong> y confirma.</li></ol>
</div>
<h2>Qué se elimina</h2>
<p>Tu nombre, teléfono, correo, direcciones y sesiones se borran de inmediato.</p>
<h2>Qué se conserva</h2>
<p>Los pedidos ya pagados se conservan por el plazo que exige la ley tributaria (seis años), sin datos que te identifiquen: quedan el monto y los productos, no tu nombre, teléfono ni dirección.</p>
<h2>Si no puedes entrar a la app</h2>
<p>Escríbenos a ${seguro(correo)} o llama al ${seguro(telefono)} desde el teléfono o correo de tu cuenta y la eliminamos por ti.</p>`));
copyFileSync(join(aqui, '../src/panel/marca.png'), join(destino, 'marca.png'));
console.log(`sitio en ${destino}: index, privacidad, terminos, eliminar-cuenta` + (t.borrador ? `\n⚠ faltan datos del proveedor: ${t.faltan.join(', ')}` : ''));
