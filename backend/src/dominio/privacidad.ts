import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../config.ts';
import {
  consultar, consultarUno, ejecutar, enTransaccion, registrarEvento, type Fila,
} from '../db/index.ts';
import { ErrorNegocio } from './estados.ts';

/**
 * Lo que la app le debe a la persona sobre sus propios datos:
 * decirle qué se guarda, pedirle que lo acepte, dejarla llevárselos
 * y dejarla irse.
 */

const aqui = dirname(fileURLToPath(import.meta.url));
const leer = (archivo: string) => readFileSync(join(aqui, '../legal', archivo), 'utf8');

/**
 * Los textos legales y su versión.
 *
 * Viven en `src/legal/`, en archivos de texto que el abogado puede
 * editar sin tocar código. Al cambiarlos hay que cambiar también
 * `LEGAL_VERSION`: es lo que hace que la app los vuelva a mostrar.
 */
export function textosLegales() {
  const p = CONFIG.legal.proveedor;
  const datos: Record<string, string | undefined> = {
    VERSION: CONFIG.legal.version,
    RAZON_SOCIAL: p.razonSocial,
    RUT: p.rut,
    REPRESENTANTE: p.representante,
    DOMICILIO: p.domicilio,
    CORREO: p.correo,
    TELEFONO: CONFIG.telefonoContacto,
  };
  const NOMBRES: Record<string, string> = {
    RAZON_SOCIAL: 'razón social', RUT: 'RUT', REPRESENTANTE: 'representante legal',
    DOMICILIO: 'domicilio', CORREO: 'correo de contacto',
  };
  const faltan = new Set<string>();
  const completar = (texto: string) => texto.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
    if (datos[k]) return datos[k]!;
    faltan.add(NOMBRES[k] ?? k);
    return `[por completar: ${NOMBRES[k] ?? k}]`;
  });
  const terminos = completar(leer('terminos.md'));
  const privacidad = completar(leer('privacidad.md'));
  return {
    version: CONFIG.legal.version,
    terminos,
    privacidad,
    /**
     * Faltan datos del proveedor (variables `LEGAL_*`): los textos
     * no se pueden publicar así. El nombre viene de cuando eran un
     * borrador técnico.
     */
    borrador: faltan.size > 0,
    faltan: [...faltan],
  };
}

export async function terminosPendientes(actorId: string): Promise<boolean> {
  const fila = await consultarUno<Fila>(
    'SELECT 1 AS ok FROM aceptaciones WHERE actor_id = ? AND version = ?',
    actorId, CONFIG.legal.version);
  return !fila;
}

export async function aceptarTerminos(actorId: string, rol: string, version: unknown) {
  // Se acepta la versión que se LEYÓ. Si cambió mientras tanto, la
  // app tiene que mostrar la nueva.
  if (version !== CONFIG.legal.version) {
    throw new ErrorNegocio(409, 'Los términos cambiaron. Vuelve a abrirlos.');
  }
  await ejecutar(
    `INSERT INTO aceptaciones (actor_id, rol, version) VALUES (?, ?, ?)
     ON CONFLICT (actor_id, version) DO NOTHING`,
    actorId, rol, CONFIG.legal.version);
  return { aceptado: true, version: CONFIG.legal.version };
}

// ============================================================
// Mis datos
// ============================================================

/** Todo lo que se guarda de un cliente, para que se lo lleve. */
export async function datosDelCliente(clienteId: string) {
  const cliente = await consultarUno<Fila>(
    `SELECT telefono, telefono_contacto, nombre, email, direccion, correo_ingreso, creado_at,
            google_sub IS NOT NULL AS con_google, apple_sub IS NOT NULL AS con_apple
       FROM clientes WHERE id = ?`, clienteId);
  if (!cliente) throw new ErrorNegocio(404, 'Cuenta no encontrada.');

  const pedidos = await consultar<Fila>(
    `SELECT id, numero, estado, cliente_nombre, cliente_telefono, cliente_email, direccion,
            notas, total_productos, costo_despacho, total_venta, creado_at, entregado_at
       FROM pedidos WHERE cliente_id = ? ORDER BY creado_at`, clienteId);
  for (const p of pedidos) {
    p.productos = await consultar(
      `SELECT i.nombre, i.formato, i.cantidad, i.precio_venta
         FROM items i JOIN sub_pedidos s ON s.id = i.sub_pedido_id
        WHERE s.pedido_id = ?`, p.id);
    delete p.id;
  }

  return {
    generado: new Date().toISOString(),
    cuenta: cliente,
    pedidos,
    sesiones: await consultar(
      `SELECT dispositivo, creada_at, ultima_at FROM sesiones
        WHERE actor_id = ? AND revocada_at IS NULL AND expira_at > now()`, clienteId),
    aceptaciones: await consultar(
      'SELECT version, at FROM aceptaciones WHERE actor_id = ?', clienteId),
  };
}

// ============================================================
// Eliminar la cuenta
// ============================================================

const TERMINADOS = ['ENTREGADO', 'CANCELADO', 'EXPIRADO'];

/**
 * Borra la cuenta de un cliente y sus datos personales.
 *
 * Los pedidos pagados no se pueden borrar: son ventas, y la ley
 * tributaria obliga a conservarlas. Lo que se hace es quitarles
 * todo lo que dice de quién eran —nombre, teléfono, dirección,
 * notas, el punto en el mapa— y dejar los montos.
 *
 * Con un pedido en curso no se puede: el repartidor necesita esos
 * datos para entregarlo. Tampoco con una devolución pendiente,
 * porque para devolver hay que saber a quién.
 */
export async function eliminarCuentaCliente(clienteId: string): Promise<{ eliminada: true }> {
  return enTransaccion(async () => {
    const cliente = await consultarUno<Fila>(
      'SELECT * FROM clientes WHERE id = ? FOR UPDATE', clienteId);
    if (!cliente) throw new ErrorNegocio(404, 'Cuenta no encontrada.');

    const enCurso = await consultarUno<Fila>(
      `SELECT numero FROM pedidos
        WHERE cliente_id = ? AND estado NOT IN (?, ?, ?) LIMIT 1`,
      clienteId, ...TERMINADOS);
    if (enCurso) {
      throw new ErrorNegocio(409,
        `Tienes el pedido #${enCurso.numero} en curso. Cuando termine vas a poder eliminar la cuenta.`);
    }
    const porDevolver = await consultarUno<Fila>(
      `SELECT p.numero FROM pagos g JOIN pedidos p ON p.id = g.pedido_id
        WHERE p.cliente_id = ? AND p.estado = 'CANCELADO'
          AND g.estado = 'PAGADO' AND g.monto_reembolsado = 0 LIMIT 1`, clienteId);
    if (porDevolver) {
      throw new ErrorNegocio(409,
        `Hay una devolución pendiente del pedido #${porDevolver.numero}. `
        + 'Cuando la recibas vas a poder eliminar la cuenta.');
    }

    // Los que nunca se pagaron no son ventas: se van enteros.
    await ejecutar(
      `DELETE FROM pedidos p WHERE p.cliente_id = ? AND p.estado = 'EXPIRADO'
          AND NOT EXISTS (SELECT 1 FROM pagos g WHERE g.pedido_id = p.id AND g.estado = 'PAGADO')`,
      clienteId);

    // La parada de entrega lleva el nombre y la dirección en el texto.
    await ejecutar(
      `UPDATE paradas SET etiqueta = 'Entrega', lat = NULL, lng = NULL
        WHERE tipo = 'ENTREGA' AND viaje_id IN (
          SELECT v.id FROM viajes v JOIN pedidos p ON p.id = v.pedido_id WHERE p.cliente_id = ?)`,
      clienteId);
    const anonimizados = await ejecutar(
      `UPDATE pedidos SET cliente_id = NULL, cliente_nombre = '(cuenta eliminada)',
              cliente_telefono = '', cliente_email = NULL, direccion = '(eliminada)',
              notas = NULL, lat = ?, lng = ?, geo_precision = NULL
        WHERE cliente_id = ?`,
      CONFIG.puntoFeria.lat, CONFIG.puntoFeria.lng, clienteId);

    // Una solicitud para vender o repartir que nunca se aprobó.
    if (cliente.telefono) {
      await ejecutar(
        `DELETE FROM feriantes f WHERE f.telefono = ? AND f.pendiente
            AND NOT EXISTS (SELECT 1 FROM ofertas o WHERE o.feriante_id = f.id)`,
        cliente.telefono);
      await ejecutar(
        `DELETE FROM repartidores r WHERE r.telefono = ? AND r.pendiente
            AND NOT EXISTS (SELECT 1 FROM viajes v WHERE v.repartidor_id = r.id)`,
        cliente.telefono);
    }

    const llaves = [clienteId, cliente.telefono, cliente.correo_ingreso].filter(Boolean);
    for (const llave of llaves) {
      await ejecutar('DELETE FROM codigos_acceso WHERE telefono = ?', llave);
      await ejecutar(
        `DELETE FROM eventos WHERE entidad IN ('auth', 'cliente') AND entidad_id = ?`, llave);
    }
    await ejecutar('DELETE FROM sesiones WHERE actor_id = ?', clienteId);
    await ejecutar('DELETE FROM aceptaciones WHERE actor_id = ?', clienteId);
    await ejecutar('DELETE FROM clientes WHERE id = ?', clienteId);

    // Queda que ALGUIEN se fue y cuándo, sin decir quién: sirve para
    // demostrar que la solicitud se cumplió.
    await registrarEvento('privacidad', 'cuenta', 'cuenta de cliente eliminada',
      { pedidosAnonimizados: anonimizados.afectadas });
    return { eliminada: true };
  });
}

// ============================================================
// Lo que no hay que guardar para siempre
// ============================================================

/**
 * Borra lo que ya cumplió su función.
 *
 * Guardar un dato «por si acaso» es guardar algo que se puede
 * filtrar. La ubicación de un repartidor sirve mientras lleva el
 * pedido y un tiempo después por si hay un reclamo; un código de
 * ingreso, cinco minutos. Corre al arrancar y cada seis horas.
 */
export async function limpiarDatosViejos(): Promise<Record<string, number>> {
  const r = CONFIG.retencion;
  const hechos: Record<string, number> = {};

  // Registros técnicos: un mes alcanza para investigar cualquier cosa.
  hechos.errores = (await ejecutar(`DELETE FROM errores WHERE cuando < now() - interval '30 days'`)).afectadas;
  hechos.alertas = (await ejecutar(`DELETE FROM alertas WHERE enviada_at < now() - interval '30 days'`)).afectadas;

  hechos.ubicaciones = (await ejecutar(
    'DELETE FROM ubicaciones WHERE at < now() - make_interval(days => ?)', r.ubicacionesDias,
  )).afectadas;
  // El último punto conocido de quien terminó su turno.
  hechos.ultimasPosiciones = (await ejecutar(
    `UPDATE repartidores SET lat = NULL, lng = NULL, ubicacion_at = NULL
      WHERE ubicacion_at < now() - make_interval(days => 1)`)).afectadas;
  hechos.codigos = (await ejecutar(
    'DELETE FROM codigos_acceso WHERE creado_at < now() - make_interval(days => ?)', r.codigosDias,
  )).afectadas;
  hechos.sesiones = (await ejecutar(
    `DELETE FROM sesiones
      WHERE COALESCE(revocada_at, expira_at) < now() - make_interval(days => ?)`,
    r.sesionesCerradasDias)).afectadas;
  // Carros que alguien abrió, no pagó nunca y traen su nombre y dirección.
  hechos.pedidosSinPagar = (await ejecutar(
    `DELETE FROM pedidos p
      WHERE p.estado = 'EXPIRADO' AND p.creado_at < now() - make_interval(days => ?)
        AND NOT EXISTS (SELECT 1 FROM pagos g WHERE g.pedido_id = p.id AND g.estado = 'PAGADO')`,
    r.pedidosSinPagarDias)).afectadas;

  // Cuentas de cliente que nadie usa: se vacían igual que si la
  // persona la hubiera eliminado. Quien entre después con ese
  // número —que puede ser otra persona— parte de cero.
  const abandonadas = await consultar<Fila>(
    `SELECT id FROM clientes
      WHERE ultima_actividad_at < now() - make_interval(days => ?) LIMIT 200`,
    r.cuentasInactivasDias);
  hechos.cuentasSinUso = 0;
  for (const c of abandonadas) {
    try {
      await eliminarCuentaCliente(c.id);
      hechos.cuentasSinUso++;
    } catch (e) {
      // Con un pedido en curso o una devolución pendiente no se
      // toca; se intenta de nuevo en la próxima pasada.
      if (!(e instanceof ErrorNegocio)) throw e;
    }
  }

  return hechos;
}

// ============================================================
// Irse, para quien vende o reparte
// ============================================================

/**
 * Elimina la cuenta de un feriante o de un repartidor.
 *
 * Las tiendas de apps exigen que quien creó una cuenta pueda
 * eliminarla desde la misma app. Lo que hizo —pedidos preparados,
 * viajes, pagos— es contabilidad de la feria y se queda, pero sin
 * su nombre ni su teléfono. Con trabajo a medias no se puede: hay un
 * cliente esperando.
 */
export async function eliminarCuentaEquipo(
  rol: 'feriante' | 'repartidor', actorId: string,
): Promise<{ eliminada: true }> {
  return enTransaccion(async () => {
    const tabla = rol === 'feriante' ? 'feriantes' : 'repartidores';
    const yo = await consultarUno<Fila>(`SELECT * FROM ${tabla} WHERE id = ? FOR UPDATE`, actorId);
    if (!yo) throw new ErrorNegocio(404, 'Cuenta no encontrada.');

    if (rol === 'feriante') {
      const pendiente = await consultarUno<Fila>(
        `SELECT p.numero FROM sub_pedidos s JOIN pedidos p ON p.id = s.pedido_id
          WHERE s.feriante_id = ? AND s.estado = 'ACEPTADO' LIMIT 1`, actorId);
      if (pendiente) {
        throw new ErrorNegocio(409,
          `Tienes el pedido #${pendiente.numero} aceptado. Márcalo listo o libéralo antes de eliminar la cuenta.`);
      }
      await ejecutar('DELETE FROM feriante_rubros WHERE feriante_id = ?', actorId);
      await ejecutar(
        `UPDATE feriantes SET nombre = '(cuenta eliminada)', telefono = ?, puesto = '—',
                activo = false, conectado = false, push_token = NULL WHERE id = ?`,
        `eliminado:${actorId}`, actorId);
    } else {
      const viaje = await consultarUno<Fila>(
        `SELECT p.numero FROM viajes v JOIN pedidos p ON p.id = v.pedido_id
          WHERE v.repartidor_id = ? AND v.estado IN ('ASIGNADO', 'RETIRANDO', 'EN_RUTA') LIMIT 1`, actorId);
      if (viaje) {
        throw new ErrorNegocio(409,
          `Estás llevando el pedido #${viaje.numero}. Termínalo antes de eliminar la cuenta.`);
      }
      await ejecutar('DELETE FROM ubicaciones WHERE repartidor_id = ?', actorId);
      await ejecutar(
        `UPDATE repartidores SET nombre = '(cuenta eliminada)', telefono = ?,
                activo = false, conectado = false, push_token = NULL WHERE id = ?`,
        `eliminado:${actorId}`, actorId);
    }

    for (const llave of [actorId, yo.telefono].filter(Boolean)) {
      await ejecutar('DELETE FROM codigos_acceso WHERE telefono = ?', llave);
      await ejecutar(`DELETE FROM eventos WHERE entidad = 'auth' AND entidad_id = ?`, llave);
    }
    await ejecutar('DELETE FROM sesiones WHERE actor_id = ?', actorId);
    await ejecutar('DELETE FROM aceptaciones WHERE actor_id = ?', actorId);
    await registrarEvento(rol, actorId, 'cuenta eliminada', {});
    return { eliminada: true as const };
  });
}
