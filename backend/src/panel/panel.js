/**
 * Panel de administración de la feria.
 *
 * Sin framework ni build: el proyecto entero corre TypeScript nativo
 * sin compilar y esto sigue la misma idea. Son tres archivos que el
 * backend sirve en /admin, y la fuente que se lee en el navegador es
 * exactamente la que está en el repositorio.
 *
 * La autoridad vive en el servidor. Acá no hay ninguna decisión de
 * negocio: el panel pregunta y muestra. Si algo no se puede hacer,
 * lo dice el backend, no un `if` de esta página.
 */

const BASE = location.origin;
const CLAVE = 'feria.panel.token';

let token = localStorage.getItem(CLAVE);
let yo = null;
let seccion = 'hoy';
let datos = {};
let detalle = null;
let cargando = false;

// ============================================================
// API
// ============================================================

/**
 * `sinSesion` es para las dos llamadas del ingreso.
 *
 * Sin eso, un código mal escrito devuelve 401, el panel lo lee como
 * «la sesión venció» y te manda de vuelta al principio tragándose
 * el mensaje del servidor, que decía exactamente qué pasó.
 */
async function api(metodo, camino, cuerpo, { sinSesion = false } = {}) {
  const r = await fetch(BASE + camino, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token && !sinSesion ? { authorization: `Bearer ${token}` } : {}),
    },
    body: metodo === 'POST' ? JSON.stringify(cuerpo ?? {}) : undefined,
  });
  const cuerpoR = await r.json().catch(() => ({}));
  if (r.status === 401 && !sinSesion) { salir(); throw new Error('La sesión venció.'); }
  if (!r.ok) throw new Error(cuerpoR.error ?? `Error ${r.status}`);
  return cuerpoR;
}

function salir() {
  token = null; yo = null;
  localStorage.removeItem(CLAVE);
  pintar();
}

// ============================================================
// Formato
// ============================================================

const clp = (n) => {
  if (n == null) return '—';
  const e = Math.round(n) || 0;
  return (e < 0 ? '-' : '') + '$' + Math.abs(e).toLocaleString('es-CL');
};
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

const hora = (iso) => new Date(iso).toLocaleTimeString('es-CL',
  { hour: '2-digit', minute: '2-digit' });
const fechaHora = (iso) => new Date(iso).toLocaleString('es-CL',
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Los mismos tonos que los chips de la app. */
const tono = (estado) => ({
  ENTREGADO: 'exito', RETIRADO: 'exito', PAGADO: 'exito', ACEPTADO: 'exito',
  EN_RUTA: 'info', LISTO_PARA_RETIRO: 'info', EN_PREPARACION: 'info',
  DESPACHANDO: 'aviso', PENDIENTE: 'aviso', PENDIENTE_PAGO: 'aviso', OFERTADO: 'aviso',
  AUTOGESTION: 'marca',
  CANCELADO: 'alerta', EXPIRADO: 'alerta',
}[estado] ?? '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const chip = (estado) =>
  `<span class="chip ${tono(estado)}">${esc(String(estado).replace(/_/g, ' '))}</span>`;

const hoyISO = () => {
  // El día de la feria, en Valparaíso, no el del navegador de quien mira.
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return p;
};

// ============================================================
// Avisos
// ============================================================

function avisar(texto, tipo = 'alerta') {
  const caja = document.createElement('div');
  caja.className = `aviso ${tipo}`;
  caja.textContent = texto;
  Object.assign(caja.style, {
    position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
    zIndex: 50, boxShadow: '0 6px 24px rgba(22,33,29,.18)', maxWidth: '90vw',
  });
  document.body.append(caja);
  setTimeout(() => caja.remove(), 4000);
}

/** Corre una acción, muestra el error si lo hay y recarga la sección. */
async function accion(fn, exito) {
  try {
    await fn();
    if (exito) avisar(exito, 'exito');
    await cargar();
  } catch (e) {
    avisar(e.message);
  }
}

// ============================================================
// Ingreso
// ============================================================

let ingreso = { paso: 'telefono', telefono: '', pista: null, ocupado: false };

function vistaIngreso() {
  const p = ingreso;
  return `
    <div class="ingreso"><div class="caja">
      <img src="/admin/marca.png" alt="" onerror="this.style.display='none'">
      <h1>Administración</h1>
      <p class="suave">Feria Av. Argentina · Valparaíso</p>
      ${p.paso === 'telefono' ? `
        <input id="tel" class="ancho" placeholder="+56 9 1234 5678" value="${esc(p.telefono)}"
               autocomplete="tel" inputmode="tel">
        <button class="accion" id="pedir" ${p.ocupado ? 'disabled' : ''}>
          ${p.ocupado ? 'ENVIANDO…' : 'ENVIAR CÓDIGO'}
        </button>
        <p class="suave">Te mandamos un código por mensaje. Es el mismo ingreso que la app.</p>
      ` : `
        <input id="cod" class="ancho" placeholder="000000" inputmode="numeric" maxlength="6"
               autocomplete="one-time-code" value="${esc(p.codigo ?? '')}">
        <p class="suave">Enviado a ${esc(p.telefono)}. Vence en 5 minutos.</p>
        ${p.pista ? `<div class="aviso">Código de prueba: ${esc(p.pista)}</div>` : ''}
        <button class="accion" id="entrar" ${p.ocupado ? 'disabled' : ''}>
          ${p.ocupado ? 'ENTRANDO…' : 'ENTRAR'}
        </button>
        <button class="accion secundario" id="otro">Usar otro número</button>
      `}
    </div></div>`;
}

function conectarIngreso() {
  const $ = (id) => document.getElementById(id);
  $('pedir')?.addEventListener('click', async () => {
    ingreso.telefono = $('tel').value.trim();
    ingreso.ocupado = true; pintar();
    try {
      const r = await api('POST', '/auth/codigo',
        { telefono: ingreso.telefono }, { sinSesion: true });
      ingreso = { ...ingreso, paso: 'codigo', pista: r.codigoDev ?? null, ocupado: false };
    } catch (e) {
      ingreso.ocupado = false;
      avisar(e.message);
    }
    pintar();
    $('cod')?.focus();
  });
  $('entrar')?.addEventListener('click', async () => {
    // El código se lee ANTES de repintar. `pintar()` reemplaza el
    // formulario entero, así que leerlo después devuelve el campo
    // nuevo, vacío, y el servidor contesta «código incorrecto»
    // sobre algo que nunca se le mandó.
    const codigo = $('cod').value.trim();
    ingreso.codigo = codigo;
    ingreso.ocupado = true; pintar();
    try {
      const r = await api('POST', '/auth/sesion', {
        telefono: ingreso.telefono,
        codigo,
        dispositivo: 'Panel web',
      }, { sinSesion: true });
      if (r.rol !== 'operador') throw new Error('Este panel es solo para la operación.');
      token = r.token;
      localStorage.setItem(CLAVE, token);
      ingreso = { paso: 'telefono', telefono: '', codigo: '', pista: null, ocupado: false };
      await arrancar();
    } catch (e) {
      ingreso.ocupado = false;
      avisar(e.message);
      pintar();
      $('cod')?.focus();
    }
  });
  $('otro')?.addEventListener('click', () => {
    ingreso = { paso: 'telefono', telefono: '', pista: null, ocupado: false };
    pintar();
  });
  $('tel')?.addEventListener('keydown', (e) => e.key === 'Enter' && $('pedir').click());
  $('cod')?.addEventListener('keydown', (e) => e.key === 'Enter' && $('entrar').click());
}

// ============================================================
// Secciones
// ============================================================

const SECCIONES = [
  ['hoy', 'Hoy'],
  ['pedidos', 'Pedidos'],
  ['catalogo', 'Catálogo'],
  ['liquidaciones', 'A pagar'],
  ['reembolsos', 'Reembolsos'],
  ['gente', 'Gente'],
];

async function cargar() {
  cargando = true; pintar();
  try {
    if (seccion === 'hoy' || seccion === 'liquidaciones') {
      datos.tablero = await api('GET', `/operador/tablero?dia=${datos.dia ?? hoyISO()}`);
    }
    if (seccion === 'pedidos') {
      datos.pedidos = (await api('GET',
        `/operador/pedidos?limite=100${datos.filtro ? `&estado=${datos.filtro}` : ''}`)).pedidos;
    }
    if (seccion === 'catalogo') datos.catalogo = await api('GET', '/operador/catalogo');
    if (seccion === 'reembolsos') {
      datos.reembolsos = (await api('GET', '/operador/reembolsos-pendientes')).pendientes;
    }
    if (seccion === 'gente') datos.gente = await api('GET', '/operador/gente');
  } catch (e) {
    avisar(e.message);
  }
  cargando = false; pintar();
}

// ---------- Hoy ----------

function vistaHoy() {
  const t = datos.tablero;
  if (!t) return '';
  const m = t.metricas;
  const p = m.plata ?? {};
  const esHoy = (datos.dia ?? hoyISO()) === hoyISO();

  return `
    <div class="fila" style="justify-content:space-between;margin-bottom:18px">
      <h1>${esHoy ? 'Hoy' : fechaLarga(t.dia)}</h1>
      <div class="fila">
        <label class="suave">Día
          <input type="date" id="dia" value="${t.dia}" max="${hoyISO()}">
        </label>
      </div>
    </div>

    <div class="grilla" style="margin-bottom:18px">
      ${dato('Pedidos', m.pedidos.total, `${m.pedidos.entregados} entregados`)}
      ${dato('Venta', clp(m.pedidos.venta), `${clp(m.pedidos.despachoCobrado)} de despacho`)}
      ${dato('Aceptación', pct(m.ofertas.tasaAceptacion), `${m.ofertas.enviadas} ofertas`)}
      ${dato('Lo hiciste tú', pct(m.subPedidos.tasaAutogestion),
             `${m.subPedidos.autogestion} de ${m.subPedidos.total}`,
             m.subPedidos.tasaAutogestion > 0.3 ? 'var(--rojo)' : null)}
    </div>

    <div class="tarjeta" style="margin-bottom:18px">
      <h2>La plata</h2>
      <table>
        <tbody>
          ${linea('Ingresos', clp(p.ingresos))}
          ${linea('Mercadería a feriantes', clp(-(p.mercaderia ?? 0)))}
          ${linea('Repartidores', clp(-(p.reparto ?? 0)))}
          ${linea('Comisiones de la pasarela', clp(-(p.comisiones ?? 0)))}
          ${p.cancelaciones
            ? `<tr><td>Mercadería de pedidos cancelados
                   <div class="suave">La pagaste y no se vendió</div></td>
                 <td class="num" style="color:var(--rojo)">${clp(-p.cancelaciones)}</td></tr>`
            : ''}
          <tr><td><strong>Te queda</strong></td>
              <td class="num"><strong style="color:${(p.margen ?? 0) >= 0 ? 'var(--verde-oscuro)' : 'var(--rojo)'}">
                ${clp(p.margen)}</strong></td></tr>
        </tbody>
      </table>
    </div>

    ${t.autogestion.length ? `
      <div class="tarjeta">
        <h2>Tienes que ir a comprar (${t.autogestion.length})</h2>
        <table><tbody>
          ${t.autogestion.map((s) => `
            <tr>
              <td><strong>#${s.numero}</strong> · ${esc(s.rubro)}<br>
                  <span class="suave">${s.items.map((i) =>
                    `${i.cantidad}× ${esc(i.nombre)}`).join(' · ')}</span></td>
              <td class="num">${clp(s.monto_feriante)}</td>
              <td class="num">
                <button class="accion" data-listo="${esc(s.id)}">YA LO COMPRÉ</button>
              </td>
            </tr>`).join('')}
        </tbody></table>
      </div>` : `<div class="tarjeta vacio">Nada pendiente de comprar. 🎉</div>`}`;
}

const dato = (rotulo, valor, pie, color) => `
  <div class="tarjeta">
    <div class="rotulo">${rotulo}</div>
    <div class="cifra" ${color ? `style="color:${color}"` : ''}>${valor}</div>
    <div class="suave">${pie}</div>
  </div>`;

const linea = (a, b) => `<tr><td>${a}</td><td class="num">${b}</td></tr>`;

const fechaLarga = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('es-CL',
  { weekday: 'long', day: 'numeric', month: 'long' });

// ---------- Pedidos ----------

const ESTADOS = ['PENDIENTE_PAGO', 'DESPACHANDO', 'EN_PREPARACION', 'LISTO_PARA_RETIRO',
                 'EN_RUTA', 'ENTREGADO', 'CANCELADO', 'EXPIRADO'];

function vistaPedidos() {
  const lista = datos.pedidos ?? [];
  return `
    <div class="fila" style="justify-content:space-between;margin-bottom:18px">
      <h1>Pedidos</h1>
      <select id="filtro">
        <option value="">Todos los estados</option>
        ${ESTADOS.map((e) => `<option value="${e}" ${datos.filtro === e ? 'selected' : ''}>
          ${e.replace(/_/g, ' ')}</option>`).join('')}
      </select>
    </div>
    <div class="tarjeta" style="padding:0;overflow:hidden">
      ${lista.length === 0 ? '<div class="vacio">Ningún pedido con ese filtro.</div>' : `
      <div class="tabla"><table>
        <thead><tr>
          <th>#</th><th>Estado</th><th>Cliente</th><th>Dirección</th>
          <th class="num">Puestos</th><th class="num">Total</th><th class="num">Hora</th>
        </tr></thead>
        <tbody>
          ${lista.map((p) => `
            <tr class="clicable" data-pedido="${esc(p.id)}">
              <td><strong>${p.numero}</strong></td>
              <td>${chip(p.estado)}${p.autogestionados > 0
                ? ' <span class="chip marca">autogestión</span>' : ''}</td>
              <td>${esc(p.cliente_nombre)}<br><span class="suave">${esc(p.cliente_telefono)}</span></td>
              <td class="suave">${esc(p.direccion)}</td>
              <td class="num">${p.puestos}</td>
              <td class="num">${clp(p.total_venta)}</td>
              <td class="num suave">${fechaHora(p.creado_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>`;
}

// ---------- Detalle de un pedido ----------

async function abrirPedido(id) {
  try {
    const [pedido, eventos] = await Promise.all([
      api('GET', `/pedidos/${id}`),
      api('GET', `/operador/eventos/${id}`),
    ]);
    detalle = { pedido, eventos };
    pintar();
  } catch (e) { avisar(e.message); }
}

function vistaDetalle() {
  if (!detalle) return '';
  const { pedido: p, eventos } = detalle;
  const terminado = ['ENTREGADO', 'CANCELADO', 'EXPIRADO'].includes(p.estado);

  return `
    <div class="telon" id="telon"><div class="panel-lateral" id="lateral">
      <button class="cerrar" id="cerrar" aria-label="Cerrar">×</button>

      <div>
        <div class="fila"><h1>Pedido #${p.numero}</h1>${chip(p.estado)}</div>
        <p class="suave">${esc(p.cliente_nombre)} · ${esc(p.cliente_telefono)}<br>
           ${esc(p.direccion)}</p>
      </div>

      <div class="tarjeta">
        <h3>Qué pidió</h3>
        <table><tbody>
          ${p.subPedidos.map((s) => `
            <tr><td>
              <div class="fila" style="gap:8px">
                <strong>${esc(s.rubro)}</strong>${chip(s.estado)}
                ${s.autogestionado ? '<span class="chip marca">autogestión</span>' : ''}
              </div>
              <div class="suave">${s.items.map((i) =>
                `${i.cantidad}× ${esc(i.nombre)}`).join(' · ')}</div>
              ${s.feriante_nombre
                ? `<div class="suave">${esc(s.feriante_nombre)} · ${esc(s.puesto ?? '')}</div>` : ''}
            </td><td class="num">${clp(s.monto_feriante)}</td></tr>`).join('')}
        </tbody></table>
        <table style="margin-top:10px"><tbody>
          ${linea('Productos', clp(p.total_productos))}
          ${linea('Despacho', p.costo_despacho === 0 ? 'Gratis' : clp(p.costo_despacho))}
          <tr><td><strong>Total</strong></td>
              <td class="num"><strong>${clp(p.total_venta)}</strong></td></tr>
        </tbody></table>
      </div>

      ${p.viaje?.repartidor_nombre ? `
        <div class="tarjeta">
          <h3>Reparto</h3>
          <p>${esc(p.viaje.repartidor_nombre)} · ${esc(p.viaje.vehiculo)}
             <span class="suave">· ${clp(p.viaje.tarifa)}</span></p>
        </div>` : ''}

      <div class="tarjeta">
        <h3 style="margin-bottom:12px">Bitácora</h3>
        ${eventos.length === 0 ? '<p class="suave">Sin eventos.</p>' : `
        <div class="bitacora">
          ${eventos.map((e) => `
            <div class="hito">
              <div class="punto"></div>
              <div>
                <strong>${esc(e.tipo)}</strong>
                <span class="suave"> · ${fechaHora(e.at)}</span>
                ${e.detalle && Object.keys(e.detalle).length
                  ? `<div class="suave"><code>${esc(JSON.stringify(e.detalle))}</code></div>` : ''}
              </div>
            </div>`).join('')}
        </div>`}
      </div>

      ${!terminado ? `
        <button class="accion peligro" data-cancelar="${esc(p.id)}">
          Cancelar este pedido
        </button>` : ''}
    </div></div>`;
}

// ---------- Catálogo ----------

function vistaCatalogo() {
  const c = datos.catalogo;
  if (!c) return '';
  return `
    <div class="fila" style="justify-content:space-between;margin-bottom:18px">
      <h1>Catálogo</h1>
      <button class="accion" id="nuevo">+ Agregar producto</button>
    </div>
    ${datos.nuevo ? formularioNuevo(c.todosLosRubros) : ''}
    <div class="pila">
      ${c.rubros.map((r) => `
        <div class="tarjeta" style="padding:0;overflow:hidden">
          <div class="fila" style="justify-content:space-between;padding:14px 18px">
            <h2 style="margin:0">${esc(r.nombre)}</h2>
            <span class="suave">${r.activos} activos · margen ${pct(r.tasaMargen)}</span>
          </div>
          <div class="tabla"><table>
            <thead><tr>
              <th></th><th>Producto</th>
              <th class="num">Le cobras</th><th class="num">Le pagas</th>
              <th class="num">Margen</th><th>Activo</th><th></th>
            </tr></thead>
            <tbody>
              ${r.productos.map((p) => filaProducto(p)).join('')}
            </tbody>
          </table></div>
        </div>`).join('')}
    </div>`;
}

function filaProducto(p) {
  const b = (datos.borradores ?? {})[p.id];
  const venta = Number(b?.venta ?? p.precio_venta) || 0;
  const costo = Number(b?.costo ?? p.precio_costo) || 0;
  const imagen = b?.imagen ?? (p.imagen_url ?? '');
  const margen = venta - costo;
  const tasa = venta > 0 ? margen / venta : 0;
  const sucio = !!b && (venta !== p.precio_venta || costo !== p.precio_costo
                        || imagen !== (p.imagen_url ?? ''));
  const color = margen <= 0 ? 'var(--rojo)' : tasa < 0.2 ? 'var(--naranja)' : 'var(--verde-oscuro)';

  return `
    <tr style="${p.activo ? '' : 'opacity:.5'}">
      <td>
        <label title="Subir una foto propia · la de referencia viene con el sistema"
               style="cursor:pointer">
          <img class="miniatura" alt=""
               src="${esc(imagen || `/referencia/${encodeURIComponent(p.id)}`)}"
               onerror="this.replaceWith(Object.assign(document.createElement('span'),
                        {className:'miniatura',textContent:'🧺'}))">
          <input type="file" accept="image/*" hidden data-foto="${esc(p.id)}">
        </label>
      </td>
      <td><strong>${esc(p.nombre)}</strong><br><span class="suave">${esc(p.formato)}</span></td>
      <td class="num"><input class="num" value="${venta}" data-campo="venta" data-id="${esc(p.id)}"></td>
      <td class="num"><input class="num" value="${costo}" data-campo="costo" data-id="${esc(p.id)}"></td>
      <td class="num" style="color:${color}">${clp(margen)}<br>
          <span class="suave">${pct(tasa)}</span></td>
      <td><input type="checkbox" ${p.activo ? 'checked' : ''} data-activo="${esc(p.id)}"></td>
      <td class="num">
        ${sucio
          ? `<button class="accion" data-guardar="${esc(p.id)}">Guardar</button>`
          : `<button class="accion secundario" data-historial="${esc(p.id)}">Historial</button>`}
      </td>
    </tr>`;
}

function formularioNuevo(rubros) {
  return `
    <div class="tarjeta" style="margin-bottom:18px">
      <h2>Producto nuevo</h2>
      <div class="fila" style="align-items:flex-end">
        <label>Rubro<select id="n-rubro">
          ${rubros.map((r) => `<option value="${esc(r.id)}">${esc(r.nombre)}</option>`).join('')}
        </select></label>
        <label style="flex:1">Nombre<input id="n-nombre" placeholder="Choclo"></label>
        <label style="flex:1">Formato<input id="n-formato" placeholder="Docena"></label>
        <label>Le cobras<input id="n-venta" class="num" inputmode="numeric"></label>
        <label>Le pagas<input id="n-costo" class="num" inputmode="numeric"></label>
        <button class="accion" id="n-guardar">Agregar</button>
        <button class="accion secundario" id="n-cancelar">Cancelar</button>
      </div>
    </div>`;
}

async function verHistorial(id) {
  try {
    const r = await api('GET', `/operador/productos/${id}/historial`);
    detalle = { historial: r.historial, productoId: id };
    pintar();
  } catch (e) { avisar(e.message); }
}

function vistaHistorial() {
  const h = detalle.historial;
  return `
    <div class="telon" id="telon"><div class="panel-lateral" id="lateral">
      <button class="cerrar" id="cerrar" aria-label="Cerrar">×</button>
      <h1>Historial de precios</h1>
      <p class="suave"><code>${esc(detalle.productoId)}</code></p>
      <div class="tarjeta">
        ${h.length === 0 ? '<p class="suave">Todavía no cambió de precio.</p>' : `
        <div class="bitacora">
          ${h.map((e) => `
            <div class="hito">
              <div class="punto"></div>
              <div>
                <strong>${esc(e.tipo)}</strong>
                <span class="suave"> · ${fechaHora(e.at)}</span>
                ${e.detalle?.venta ? `<div class="suave">
                  venta ${clp(e.detalle.venta.antes)} → ${clp(e.detalle.venta.ahora)} ·
                  costo ${clp(e.detalle.costo.antes)} → ${clp(e.detalle.costo.ahora)}
                </div>` : ''}
              </div>
            </div>`).join('')}
        </div>`}
      </div>
    </div></div>`;
}

// ---------- Liquidaciones ----------

function vistaLiquidaciones() {
  const l = datos.tablero?.liquidaciones;
  if (!l) return '';
  return `
    <div class="fila" style="justify-content:space-between;margin-bottom:18px">
      <h1>A pagar esta tarde</h1>
      <div class="fila">
        <span class="cifra">${clp(l.totalAPagar)}</span>
        <label class="suave">Día <input type="date" id="dia" value="${l.fecha}" max="${hoyISO()}"></label>
      </div>
    </div>
    <div class="tarjeta" style="padding:0;overflow:hidden">
      ${l.feriantes.length === 0 ? '<div class="vacio">Nadie retiró mercadería ese día.</div>' : `
      <div class="tabla"><table>
        <thead><tr>
          <th>Feriante</th><th class="num">Pedidos</th><th class="num">Total</th>
          <th class="num">Pagado</th><th class="num">Pendiente</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody>
          ${l.feriantes.map((f) => `
            <tr>
              <td><strong>${esc(f.nombre)}</strong><br>
                  <span class="suave">${esc(f.puesto)} · ${esc(f.telefono)}</span></td>
              <td class="num">${f.cantidad}${f.compensados
                ? `<br><span class="suave">${f.compensados} compensados</span>` : ''}</td>
              <td class="num">${clp(f.total)}</td>
              <td class="num">${clp(f.pagado)}</td>
              <td class="num"><strong>${clp(f.pendiente)}</strong></td>
              <td>${f.confirmado_at ? '<span class="chip exito">confirmó</span>'
                   : f.pagado_at ? '<span class="chip aviso">esperando que confirme</span>'
                   : '<span class="chip">sin pagar</span>'}</td>
              <td class="num">${f.pendiente > 0
                ? `<button class="accion" data-pagar="${esc(f.id)}"
                     data-nombre="${esc(f.nombre)}" data-monto="${f.pendiente}">
                     Pagué ${clp(f.pendiente)}</button>`
                : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>`;
}

// ---------- Reembolsos ----------

function vistaReembolsos() {
  const lista = datos.reembolsos ?? [];
  return `
    <h1 style="margin-bottom:18px">Reembolsos pendientes</h1>
    <p class="suave" style="margin-top:-10px;margin-bottom:18px">
      Pedidos cancelados que se pagaron y todavía no se devolvieron.
      La devolución se hace en la pasarela; esta lista es para no olvidarse de ninguno.
    </p>
    <div class="tarjeta" style="padding:0;overflow:hidden">
      ${lista.length === 0 ? '<div class="vacio">No hay nada por devolver. 🎉</div>' : `
      <table>
        <thead><tr><th>#</th><th>Cliente</th><th>Orden en la pasarela</th>
                   <th class="num">Monto</th></tr></thead>
        <tbody>
          ${lista.map((x) => `
            <tr>
              <td><strong>${x.numero}</strong></td>
              <td>${esc(x.cliente_nombre)}<br>
                  <span class="suave">${esc(x.cliente_telefono)}</span></td>
              <td><code>${esc(x.orden_comercio)}</code></td>
              <td class="num"><strong>${clp(x.monto)}</strong></td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;
}

// ---------- Gente ----------

function vistaGente() {
  const g = datos.gente;
  if (!g) return '';
  const conectados = g.feriantes.filter((f) => f.conectado).length;
  return `
    <h1 style="margin-bottom:18px">Gente</h1>
    <p class="suave" style="margin-top:-10px;margin-bottom:18px">
      «Código» genera uno de ingreso para esa persona. Se lo dices en la feria
      o se lo mandas por WhatsApp — no hace falta pagar un SMS por cada ingreso.
    </p>
    <div class="pila">
      <div class="tarjeta" style="padding:0;overflow:hidden">
        <div class="fila" style="justify-content:space-between;padding:14px 18px">
          <h2 style="margin:0">Feriantes</h2>
          <span class="suave">${conectados} de ${g.feriantes.length} recibiendo pedidos</span>
        </div>
        ${conectados === 0 ? `<div class="aviso alerta" style="margin:0 18px 14px">
          No hay ni un puesto conectado: todo lo que entre te va a tocar a tú.
        </div>` : ''}
        <table>
          <thead><tr><th>Nombre</th><th>Puesto</th><th>Rubros</th>
                     <th class="num">En curso</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            ${g.feriantes.map((f) => `
              <tr>
                <td><strong>${esc(f.nombre)}</strong><br>
                    <span class="suave">${esc(f.telefono)}</span></td>
                <td class="suave">${esc(f.puesto)}</td>
                <td class="suave">${esc(f.rubros)}</td>
                <td class="num">${f.en_curso}</td>
                <td>${f.conectado ? '<span class="chip exito">recibiendo</span>'
                     : '<span class="chip">en pausa</span>'}</td>
                <td class="num">
                  <button class="accion secundario" data-codigo="${esc(f.id)}"
                          data-nombre="${esc(f.nombre)}">Código</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="tarjeta" style="padding:0;overflow:hidden">
        <h2 style="padding:14px 18px;margin:0">Repartidores</h2>
        <table>
          <thead><tr><th>Nombre</th><th>Vehículo</th>
                     <th class="num">En ruta</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            ${g.repartidores.map((r) => `
              <tr>
                <td><strong>${esc(r.nombre)}</strong><br>
                    <span class="suave">${esc(r.telefono)}</span></td>
                <td class="suave">${esc(r.vehiculo)}</td>
                <td class="num">${r.en_curso}</td>
                <td>${r.conectado ? '<span class="chip exito">conectado</span>'
                     : '<span class="chip">desconectado</span>'}</td>
                <td class="num">
                  <button class="accion secundario" data-codigo="${esc(r.id)}"
                          data-nombre="${esc(r.nombre)}">Código</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/**
 * El código, grande, para dictarlo en voz alta.
 *
 * Se agrupa de tres en tres porque así se lee por teléfono sin
 * equivocarse, y se muestra el nombre para no dictárselo al
 * feriante equivocado.
 */
function vistaCodigo() {
  const c = detalle.codigo;
  const partes = `${c.codigo.slice(0, 3)} ${c.codigo.slice(3)}`;
  return `
    <div class="telon" id="telon"><div class="panel-lateral" id="lateral">
      <button class="cerrar" id="cerrar" aria-label="Cerrar">×</button>
      <div class="tarjeta" style="text-align:center">
        <div class="rotulo">Código para</div>
        <h1 style="margin:4px 0">${esc(c.nombre)}</h1>
        <p class="suave">${esc(c.telefono)}</p>
        <div style="font-family:Fredoka,sans-serif;font-size:56px;letter-spacing:6px;
                    color:var(--verde-oscuro);margin:18px 0;font-variant-numeric:tabular-nums">
          ${partes}
        </div>
        <p class="suave">Vence en ${Math.round(c.expiraEn / 60)} minutos.</p>
        <div class="aviso" style="margin-top:14px;text-align:left">
          Díselo en la feria o mándaselo por WhatsApp. Si hay SMS configurado,
          además le llega solo.
        </div>
      </div>
    </div></div>`;
}

// ============================================================
// Pintado y eventos
// ============================================================

function pintar() {
  const raiz = document.getElementById('raiz');

  if (!token) {
    raiz.innerHTML = vistaIngreso();
    conectarIngreso();
    return;
  }

  const cuerpo =
    cargando && !datos.tablero && !datos.catalogo && !datos.pedidos && !datos.gente
      ? '<div class="vacio">Cargando…</div>'
      : seccion === 'hoy' ? vistaHoy()
      : seccion === 'pedidos' ? vistaPedidos()
      : seccion === 'catalogo' ? vistaCatalogo()
      : seccion === 'liquidaciones' ? vistaLiquidaciones()
      : seccion === 'reembolsos' ? vistaReembolsos()
      : vistaGente();

  raiz.innerHTML = `
    <header class="barra">
      <span class="marca"><img src="/admin/marca.png" alt="" onerror="this.remove()">Feria</span>
      <span class="crece"></span>
      <span class="quien">${esc(yo?.nombre ?? '')}<br>
        <span class="suave">Operación</span></span>
      <button class="accion secundario" id="salir">Salir</button>
      <button class="accion secundario" id="salir-todos"
              title="Cierra la sesión en todos los teléfonos y navegadores">Salir de todos</button>
    </header>
    <nav>
      ${SECCIONES.map(([id, texto]) => `
        <button data-seccion="${id}" ${seccion === id ? 'aria-current="page"' : ''}>
          ${texto}
        </button>`).join('')}
    </nav>
    <main>${cuerpo}</main>
    ${detalle?.pedido ? vistaDetalle()
      : detalle?.historial ? vistaHistorial()
      : detalle?.codigo ? vistaCodigo()
      : ''}`;

  conectar();
}

function conectar() {
  const en = (sel, evento, fn) =>
    document.querySelectorAll(sel).forEach((el) => el.addEventListener(evento, fn));

  document.getElementById('salir')?.addEventListener('click', salir);
  document.getElementById('salir-todos')?.addEventListener('click', async () => {
    if (!confirm('Esto cierra la sesión en todos los teléfonos y navegadores. ¿Seguro?')) return;
    try { await api('POST', '/auth/salir-de-todos'); } catch (e) { avisar(e.message); }
    salir();
  });

  en('[data-seccion]', 'click', (e) => {
    seccion = e.currentTarget.dataset.seccion;
    detalle = null;
    void cargar();
  });

  // ---- Telón ----
  document.getElementById('cerrar')?.addEventListener('click', () => { detalle = null; pintar(); });
  document.getElementById('telon')?.addEventListener('click', (e) => {
    if (e.target.id === 'telon') { detalle = null; pintar(); }
  });

  // ---- Hoy ----
  en('[data-listo]', 'click', (e) => accion(
    () => api('POST', `/operador/autogestion/${e.currentTarget.dataset.listo}/listo`),
    'Marcado como comprado.'));
  document.getElementById('dia')?.addEventListener('change', (e) => {
    datos.dia = e.target.value;
    void cargar();
  });

  // ---- Pedidos ----
  en('[data-pedido]', 'click', (e) => void abrirPedido(e.currentTarget.dataset.pedido));
  document.getElementById('filtro')?.addEventListener('change', (e) => {
    datos.filtro = e.target.value;
    void cargar();
  });
  en('[data-cancelar]', 'click', async (e) => {
    const motivo = prompt('¿Por qué se cancela? El cliente va a ver este motivo.');
    if (!motivo) return;
    const id = e.currentTarget.dataset.cancelar;
    detalle = null;
    await accion(() => api('POST', `/operador/pedidos/${id}/cancelar`, { motivo }),
                 'Pedido cancelado.');
  });

  // ---- Catálogo ----
  en('[data-campo]', 'input', (e) => {
    const { id, campo } = e.target.dataset;
    tocar(id, campo, e.target.value.replace(/\D/g, '').slice(0, 7));
  });
  en('[data-activo]', 'change', (e) => accion(
    () => api('POST', `/operador/productos/${e.target.dataset.activo}`,
              { activo: e.target.checked })));
  en('[data-guardar]', 'click', (e) => {
    const id = e.currentTarget.dataset.guardar;
    const b = datos.borradores[id];
    return accion(async () => {
      await api('POST', `/operador/productos/${id}`, {
        precioVenta: Number(b.venta), precioCosto: Number(b.costo), imagenUrl: b.imagen,
      });
      delete datos.borradores[id];
    }, 'Guardado.');
  });
  en('[data-historial]', 'click', (e) =>
    void verHistorial(e.currentTarget.dataset.historial));
  en('[data-foto]', 'change', (e) => void subirFoto(e.target.dataset.foto, e.target.files[0]));

  document.getElementById('nuevo')?.addEventListener('click', () => {
    datos.nuevo = true; pintar();
  });
  document.getElementById('n-cancelar')?.addEventListener('click', () => {
    datos.nuevo = false; pintar();
  });
  document.getElementById('n-guardar')?.addEventListener('click', () => {
    const v = (id) => document.getElementById(id).value.trim();
    return accion(async () => {
      await api('POST', '/operador/productos', {
        rubroId: v('n-rubro'), nombre: v('n-nombre'), formato: v('n-formato'),
        precioVenta: Number(v('n-venta')), precioCosto: Number(v('n-costo')),
      });
      datos.nuevo = false;
    }, 'Producto agregado.');
  });

  // ---- Código de ingreso ----
  en('[data-codigo]', 'click', async (e) => {
    const { codigo: actorId, nombre } = e.currentTarget.dataset;
    try {
      const r = await api('POST', `/operador/codigo-para/${actorId}`);
      detalle = { codigo: r };
      pintar();
    } catch (err) { avisar(err.message); }
  });

  // ---- Liquidaciones ----
  en('[data-pagar]', 'click', (e) => {
    const { pagar, nombre, monto } = e.currentTarget.dataset;
    if (!confirm(`¿Le pagaste ${clp(Number(monto))} en efectivo a ${nombre}?`)) return;
    return accion(() => api('POST', `/operador/liquidaciones/${pagar}/pagar`),
                  'Anotado. Falta que lo confirme desde su teléfono.');
  });
}

/** Guarda el cambio en curso sin volver a pintar: el foco se perdería. */
function tocar(id, campo, valor) {
  datos.borradores ??= {};
  const p = (datos.catalogo?.rubros ?? [])
    .flatMap((r) => r.productos).find((x) => x.id === id);
  datos.borradores[id] = {
    venta: String(p.precio_venta), costo: String(p.precio_costo),
    imagen: p.imagen_url ?? '',
    ...datos.borradores[id],
    [campo]: valor,
  };
  pintarMargen(id);
}

/** Recalcula solo la celda del margen, para no pisar el campo que se escribe. */
function pintarMargen(id) {
  const b = datos.borradores[id];
  const fila = document.querySelector(`[data-campo="venta"][data-id="${CSS.escape(id)}"]`)
    ?.closest('tr');
  if (!fila) return;
  const venta = Number(b.venta) || 0;
  const costo = Number(b.costo) || 0;
  const margen = venta - costo;
  const tasa = venta > 0 ? margen / venta : 0;
  const celda = fila.children[4];
  celda.style.color = margen <= 0 ? 'var(--rojo)'
    : tasa < 0.2 ? 'var(--naranja)' : 'var(--verde-oscuro)';
  celda.innerHTML = `${clp(margen)}<br><span class="suave">${pct(tasa)}</span>`;
  const acciones = fila.children[6];
  acciones.innerHTML = `<button class="accion" data-guardar="${esc(id)}">Guardar</button>`;
  acciones.querySelector('button').addEventListener('click', () => {
    return accion(async () => {
      await api('POST', `/operador/productos/${id}`, {
        precioVenta: Number(b.venta), precioCosto: Number(b.costo), imagenUrl: b.imagen,
      });
      delete datos.borradores[id];
    }, 'Guardado.');
  });
}

/**
 * Sube la foto y la deja en el producto de una vez.
 *
 * Son dos llamadas —guardar el archivo y después apuntar el
 * producto a él— porque el archivo es independiente: si la segunda
 * falla, la foto quedó subida y se puede reintentar sin volver a
 * mandar los megabytes.
 */
async function subirFoto(productoId, archivo) {
  if (!archivo) return;
  if (archivo.size > 4 * 1024 * 1024) {
    return avisar(`Esa foto pesa ${(archivo.size / 1024 / 1024).toFixed(1)} MB y el máximo son 4.`);
  }
  avisar('Subiendo la foto…', 'exito');
  try {
    const base64 = await new Promise((listo, falla) => {
      const lector = new FileReader();
      lector.onload = () => listo(String(lector.result));
      lector.onerror = () => falla(new Error('No se pudo leer el archivo.'));
      lector.readAsDataURL(archivo);
    });
    const { camino } = await api('POST', '/operador/fotos', { datos: base64 });
    // El camino va sin dominio: la base no tiene por qué saber por
    // dónde entró quien subió la foto.
    await api('POST', `/operador/productos/${productoId}`, { imagenUrl: camino });
    avisar('Foto cargada.', 'exito');
    await cargar();
  } catch (e) {
    avisar(e.message);
  }
}

// ============================================================
// Arranque
// ============================================================

async function arrancar() {
  if (!token) return pintar();
  try {
    yo = await api('GET', '/auth/yo');
    if (yo.rol !== 'operador') {
      avisar('Este panel es solo para la operación.');
      return salir();
    }
    await cargar();
  } catch {
    salir();
  }
}

void arrancar();
