import { consultar, consultarUno, ejecutar, type Fila } from '../db/index.ts';
import { enviarCorreo, plantillaCorreo } from '../correo.ts';

/**
 * Avisos al operador cuando algo necesita que mire.
 *
 * Sin esto, un pedido atascado se descubre cuando el cliente llama.
 * Se revisa una vez por minuto, colgado del latido del motor, y cada
 * problema se avisa una sola vez (tabla `alertas`).
 */
const destino = (): string | undefined =>
  process.env.ALERTAS_CORREO || process.env.CORREO_SMTP_USUARIO || undefined;

/** Cuánto puede estar un viaje sin repartidor antes de avisar. */
const MINUTOS_SIN_REPARTIDOR = Number(process.env.ALERTA_VIAJE_MINUTOS ?? 5);
/** Con cuánto silencio del motor se considera que estuvo detenido. */
const SEGUNDOS_MOTOR_DETENIDO = 150;

type Problema = { clave: string; texto: string };

/** Guarda un error interno. Nunca lanza: registrar no puede romper nada. */
export async function registrarError(camino: string, e: any): Promise<void> {
  try {
    await ejecutar(
      'INSERT INTO errores (camino, mensaje, pila) VALUES (?, ?, ?)',
      camino.slice(0, 200), String(e?.message ?? e).slice(0, 500),
      e?.stack ? String(e.stack).slice(0, 2000) : null);
  } catch (otro) {
    console.error('[errores] no se pudo registrar', otro);
  }
}

export const erroresRecientes = () => consultar<Fila>(
  'SELECT id, cuando, camino, mensaje FROM errores ORDER BY id DESC LIMIT 100');

/** Lee el último latido. Se llama ANTES de volver a latir. */
export async function silencioDelMotor(): Promise<number | null> {
  const m = await consultarUno<{ s: number }>(
    'SELECT extract(epoch FROM now() - visto)::int AS s FROM motor WHERE id = 1').catch(() => undefined);
  return m ? Number(m.s) : null;
}

async function buscarProblemas(silencio: number | null): Promise<Problema[]> {
  const p: Problema[] = [];

  if (silencio !== null && silencio > SEGUNDOS_MOTOR_DETENIDO) {
    const hora = new Date().toISOString().slice(0, 13);
    p.push({
      clave: `motor:${hora}`,
      texto: `El motor del despacho estuvo detenido ${Math.round(silencio / 60)} minutos. Ya volvió a andar; revisa si quedó algún pedido esperando.`,
    });
  }

  const auto = await consultar<Fila>(
    `SELECT s.id, s.rubro_id, p.numero FROM sub_pedidos s JOIN pedidos p ON p.id = s.pedido_id
      WHERE s.estado = 'AUTOGESTION' AND p.creado_at > now() - interval '2 days'`);
  for (const a of auto) {
    p.push({
      clave: `autogestion:${a.id}`,
      texto: `Pedido #${a.numero}: nadie aceptó la parte de ${a.rubro_id}. Quedó para que la compres tú.`,
    });
  }

  const viajes = await consultar<Fila>(
    `SELECT v.id, p.numero FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
      WHERE v.estado = 'BUSCANDO' AND v.repartidor_id IS NULL
        AND v.creado_at < now() - make_interval(mins => ?)
        AND v.creado_at > now() - interval '2 days'`, MINUTOS_SIN_REPARTIDOR);
  for (const v of viajes) {
    p.push({
      clave: `viaje:${v.id}`,
      texto: `Pedido #${v.numero}: lleva más de ${MINUTOS_SIN_REPARTIDOR} minutos sin que un repartidor tome el viaje.`,
    });
  }

  const sinCodigo = await consultar<Fila>(
    `SELECT id, numero, entrega_sin_codigo FROM pedidos
      WHERE entrega_sin_codigo IS NOT NULL AND entregado_at > now() - interval '2 days'`);
  for (const s of sinCodigo) {
    p.push({
      clave: `sin-codigo:${s.id}`,
      texto: `Pedido #${s.numero}: se entregó sin el código del cliente. El repartidor anotó: «${s.entrega_sin_codigo}».`,
    });
  }

  const malas = await consultar<Fila>(
    `SELECT c.pedido_id, c.estrellas, c.comentario, pe.numero FROM calificaciones c
       JOIN pedidos pe ON pe.id = c.pedido_id
      WHERE c.estrellas <= 2 AND c.creado_at > now() - interval '2 days'`);
  for (const m of malas) {
    p.push({
      clave: `nota:${m.pedido_id}`,
      texto: `Pedido #${m.numero}: el cliente puso ${m.estrellas} ${m.estrellas === 1 ? 'estrella' : 'estrellas'}`
        + (m.comentario ? `: «${m.comentario}».` : '.'),
    });
  }

  const fallas = await consultar<Fila>(
    `SELECT camino, count(*)::int AS n, max(mensaje) AS mensaje FROM errores
      WHERE cuando > now() - interval '1 hour' GROUP BY camino`);
  const hora = new Date().toISOString().slice(0, 13);
  for (const f of fallas) {
    // Sin los ids del camino: un error por pedido no es un aviso por pedido.
    const ruta = String(f.camino).split('/').slice(0, 2).join('/') || '/';
    p.push({
      clave: `error:${ruta}:${hora}`,
      texto: `Error interno en ${ruta} (${f.n} en la última hora): ${f.mensaje}`,
    });
  }
  return p;
}

/**
 * Busca problemas y manda UN correo con los que no se habían avisado.
 * Devuelve cuántos avisó.
 */
export async function revisarYAvisar(silencio: number | null = null): Promise<number> {
  const nuevos: Problema[] = [];
  for (const x of await buscarProblemas(silencio)) {
    const r = await ejecutar(
      'INSERT INTO alertas (clave, texto) VALUES (?, ?) ON CONFLICT (clave) DO NOTHING', x.clave, x.texto);
    if (r.afectadas === 1) nuevos.push(x);
  }
  if (!nuevos.length) return 0;

  const a = destino();
  const texto = nuevos.map((x) => `• ${x.texto}`).join('\n')
    + '\n\nÁbrelo en el panel de la feria para resolverlo.';
  if (!a) {
    console.warn('[alertas] sin correo donde avisar (ALERTAS_CORREO):\n' + texto);
    return nuevos.length;
  }
  const asunto = nuevos.length === 1
    ? 'Feria App: algo necesita que lo mires'
    : `Feria App: ${nuevos.length} cosas necesitan que las mires`;
  const html = plantillaCorreo(
    `    <p style="font-size:16px;font-weight:bold;margin:0 0 12px">Algo necesita que lo mires</p>
    <ul style="margin:0;padding-left:20px;font-size:15px;line-height:1.6">
${nuevos.map((x) => `<li style="margin-bottom:8px">${x.texto.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</li>`).join('\n')}
    </ul>`, 'Aviso automático para el operador de la feria.');
  const r = await enviarCorreo(a, asunto, texto, html);
  if (!r.enviado) {
    // No salió: se olvidan para que el próximo minuto lo reintente.
    for (const x of nuevos) await ejecutar('DELETE FROM alertas WHERE clave = ?', x.clave);
    console.error('[alertas] no se pudo avisar:', r.detalle ?? '');
    return 0;
  }
  return nuevos.length;
}
