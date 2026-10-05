import {
  ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila,
} from '../db/index.ts';
import { ErrorNegocio } from './estados.ts';
import { normalizarTelefono } from './auth.ts';

/**
 * Alta, cambio y baja de la gente de la feria.
 *
 * Hasta acá los únicos feriantes y repartidores eran los de ejemplo
 * de la semilla, y para cargar uno de verdad había que escribir SQL.
 * Sin esto no se puede abrir: una feria sin sus feriantes cargados
 * manda todos los pedidos a autogestión.
 */

const texto = (v: unknown, campo: string, max = 80): string => {
  const t = String(v ?? '').trim();
  if (!t) throw new ErrorNegocio(422, `Falta ${campo}.`);
  if (t.length > max) throw new ErrorNegocio(422, `${campo} es demasiado largo.`);
  return t;
};

/**
 * El teléfono es la identidad: con él se entra. Dos personas con el
 * mismo número serían la misma para el ingreso, sean del rol que sean.
 */
async function telefonoLibre(crudo: unknown, propio?: string): Promise<string> {
  const telefono = normalizarTelefono(String(crudo ?? ''));
  const duenos = await consultar<Fila>(
    `SELECT id, nombre FROM feriantes WHERE telefono = ?
     UNION ALL SELECT id, nombre FROM repartidores WHERE telefono = ?
     UNION ALL SELECT id, nombre FROM operadores WHERE telefono = ?`,
    telefono, telefono, telefono);
  const otro = duenos.find((d) => d.id !== propio);
  if (otro) throw new ErrorNegocio(409, `Ese teléfono ya es de ${otro.nombre}.`);
  return telefono;
}

async function rubrosValidos(valor: unknown): Promise<string[]> {
  const pedidos = Array.isArray(valor) ? [...new Set(valor.map(String))] : [];
  if (pedidos.length === 0) throw new ErrorNegocio(422, 'Elige al menos un rubro.');
  const existentes = new Set(
    (await consultar<Fila>('SELECT id FROM rubros')).map((r) => r.id));
  const malo = pedidos.find((r) => !existentes.has(r));
  if (malo) throw new ErrorNegocio(422, `No existe el rubro ${malo}.`);
  return pedidos;
}

/** Cierra las sesiones de alguien: lo saca de la app en el acto. */
const cerrarSesiones = (actorId: string) => ejecutar(
  'UPDATE sesiones SET revocada_at = ? WHERE actor_id = ? AND revocada_at IS NULL',
  ahora(), actorId);

/**
 * Cierra las sesiones de un número, sean del rol que sean. Quien
 * pasa de cliente a feriante tiene abierta una sesión de cliente.
 */
const cerrarSesionesDelTelefono = (telefono: string) => ejecutar(
  'UPDATE sesiones SET revocada_at = ? WHERE telefono = ? AND revocada_at IS NULL',
  ahora(), telefono);

// ============================================================
// Feriantes
// ============================================================

export type DatosFeriante = {
  nombre?: string; puesto?: string; telefono?: string; rubros?: string[]; activo?: boolean;
  /** `false` rechaza una solicitud: queda cargado, inactivo. */
  pendiente?: boolean;
};

/**
 * `solicitud`: lo pidió la propia persona desde la app. Queda
 * cargada pero inactiva hasta que el operador la apruebe.
 */
export async function crearFeriante(
  datos: DatosFeriante, feriaId: string, opciones: { solicitud?: boolean } = {},
) {
  return enTransaccion(async () => {
    const nombre = texto(datos.nombre, 'el nombre');
    const puesto = texto(datos.puesto, 'el puesto');
    const telefono = await telefonoLibre(datos.telefono);
    const rubros = await rubrosValidos(datos.rubros);

    const nuevo = 'f-' + id().slice(0, 8);
    // Entra en pausa: empieza a recibir pedidos cuando él mismo
    // enciende el interruptor en su teléfono.
    const solicitud = !!opciones.solicitud;
    await ejecutar(
      `INSERT INTO feriantes (id, nombre, puesto, feria_id, telefono, conectado, activo, pendiente)
       VALUES (?, ?, ?, ?, ?, false, ?, ?)`,
      nuevo, nombre, puesto, feriaId, telefono, !solicitud, solicitud);
    for (const r of rubros) {
      await ejecutar('INSERT INTO feriante_rubros (feriante_id, rubro_id) VALUES (?, ?)', nuevo, r);
    }
    await registrarEvento('feriante', nuevo, solicitud ? 'solicitud' : 'creado',
      { nombre, puesto, rubros });
    if (!solicitud) await cerrarSesionesDelTelefono(telefono);
    return { id: nuevo, nombre, puesto, telefono, rubros };
  });
}

export async function actualizarFeriante(ferianteId: string, datos: DatosFeriante) {
  return enTransaccion(async () => {
    const actual = await consultarUno<Fila>('SELECT * FROM feriantes WHERE id = ?', ferianteId);
    if (!actual) throw new ErrorNegocio(404, 'Feriante no encontrado.');

    const nombre = datos.nombre !== undefined ? texto(datos.nombre, 'el nombre') : actual.nombre;
    const puesto = datos.puesto !== undefined ? texto(datos.puesto, 'el puesto') : actual.puesto;
    const telefono = datos.telefono !== undefined
      ? await telefonoLibre(datos.telefono, ferianteId) : actual.telefono;
    const activo = datos.activo ?? actual.activo;
    // Aprobar o rechazar una solicitud la saca de pendientes.
    const pendiente = activo ? false : (datos.pendiente ?? actual.pendiente);

    await ejecutar(
      `UPDATE feriantes SET nombre = ?, puesto = ?, telefono = ?, activo = ?, pendiente = ?,
              conectado = conectado AND ? WHERE id = ?`,
      nombre, puesto, telefono, activo, pendiente, activo, ferianteId);

    if (datos.rubros !== undefined) {
      const rubros = await rubrosValidos(datos.rubros);
      await ejecutar('DELETE FROM feriante_rubros WHERE feriante_id = ?', ferianteId);
      for (const r of rubros) {
        await ejecutar(
          'INSERT INTO feriante_rubros (feriante_id, rubro_id) VALUES (?, ?)', ferianteId, r);
      }
    }

    // Con otro teléfono o dado de baja, las sesiones abiertas ya no
    // son de quien corresponde.
    if (telefono !== actual.telefono || (!activo && actual.activo)) {
      await cerrarSesiones(ferianteId);
    }
    // Recién aprobado: su sesión de cliente se cierra para que al
    // entrar de nuevo la app lo reciba como feriante.
    if (activo && !actual.activo) await cerrarSesionesDelTelefono(telefono);
    if (activo !== actual.activo) {
      await registrarEvento('feriante', ferianteId,
        activo ? (actual.pendiente ? 'solicitud aprobada' : 'reactivado') : 'dado de baja');
    } else if (actual.pendiente && !pendiente) {
      await registrarEvento('feriante', ferianteId, 'solicitud rechazada');
    }
    return { id: ferianteId, nombre, puesto, telefono, activo, pendiente };
  });
}

// ============================================================
// Repartidores
// ============================================================

export type DatosRepartidor = {
  nombre?: string; vehiculo?: string; telefono?: string; activo?: boolean; pendiente?: boolean;
};

export async function crearRepartidor(
  datos: DatosRepartidor, opciones: { solicitud?: boolean } = {},
) {
  return enTransaccion(async () => {
    const nombre = texto(datos.nombre, 'el nombre');
    const vehiculo = texto(datos.vehiculo, 'el vehículo', 30);
    const telefono = await telefonoLibre(datos.telefono);

    const nuevo = 'r-' + id().slice(0, 8);
    const solicitud = !!opciones.solicitud;
    await ejecutar(
      `INSERT INTO repartidores (id, nombre, vehiculo, telefono, conectado, activo, pendiente)
       VALUES (?, ?, ?, ?, false, ?, ?)`,
      nuevo, nombre, vehiculo, telefono, !solicitud, solicitud);
    await registrarEvento('repartidor', nuevo, solicitud ? 'solicitud' : 'creado',
      { nombre, vehiculo });
    if (!solicitud) await cerrarSesionesDelTelefono(telefono);
    return { id: nuevo, nombre, vehiculo, telefono };
  });
}

export async function actualizarRepartidor(repartidorId: string, datos: DatosRepartidor) {
  return enTransaccion(async () => {
    const actual = await consultarUno<Fila>(
      'SELECT * FROM repartidores WHERE id = ?', repartidorId);
    if (!actual) throw new ErrorNegocio(404, 'Repartidor no encontrado.');

    const nombre = datos.nombre !== undefined ? texto(datos.nombre, 'el nombre') : actual.nombre;
    const vehiculo = datos.vehiculo !== undefined
      ? texto(datos.vehiculo, 'el vehículo', 30) : actual.vehiculo;
    const telefono = datos.telefono !== undefined
      ? await telefonoLibre(datos.telefono, repartidorId) : actual.telefono;
    const activo = datos.activo ?? actual.activo;

    if (!activo && actual.activo) {
      const enRuta = await consultarUno<Fila>(
        `SELECT id FROM viajes WHERE repartidor_id = ?
          AND estado IN ('ASIGNADO', 'RETIRANDO', 'EN_RUTA')`, repartidorId);
      if (enRuta) throw new ErrorNegocio(409, 'Tiene un viaje en curso. Espera a que lo termine.');
    }

    const pendiente = activo ? false : (datos.pendiente ?? actual.pendiente);
    await ejecutar(
      `UPDATE repartidores SET nombre = ?, vehiculo = ?, telefono = ?, activo = ?, pendiente = ?,
              conectado = conectado AND ? WHERE id = ?`,
      nombre, vehiculo, telefono, activo, pendiente, activo, repartidorId);

    if (telefono !== actual.telefono || (!activo && actual.activo)) {
      await cerrarSesiones(repartidorId);
    }
    if (activo && !actual.activo) await cerrarSesionesDelTelefono(telefono);
    if (activo !== actual.activo) {
      await registrarEvento('repartidor', repartidorId,
        activo ? (actual.pendiente ? 'solicitud aprobada' : 'reactivado') : 'dado de baja');
    } else if (actual.pendiente && !pendiente) {
      await registrarEvento('repartidor', repartidorId, 'solicitud rechazada');
    }
    return { id: repartidorId, nombre, vehiculo, telefono, activo, pendiente };
  });
}

// ============================================================
// Solicitudes: la persona pide entrar desde la app
// ============================================================

/** Lo que este número tiene pedido o tuvo en la feria, si algo. */
export async function solicitudDe(telefono: string) {
  const fila = await consultarUno<Fila>(
    `SELECT 'feriante' AS tipo, activo, pendiente FROM feriantes WHERE telefono = ?
     UNION ALL
     SELECT 'repartidor', activo, pendiente FROM repartidores WHERE telefono = ?`,
    telefono, telefono);
  if (!fila) return null;
  return {
    tipo: fila.tipo as 'feriante' | 'repartidor',
    estado: fila.activo ? 'aprobada' : fila.pendiente ? 'pendiente' : 'cerrada',
  };
}

/**
 * Un cliente pide ser feriante o repartidor.
 *
 * El teléfono es el de su sesión —ya lo confirmó por SMS—, no uno
 * que escriba: así nadie postula con el número de otro. No recibe
 * nada hasta que el operador lo aprueba; que cualquiera pudiera
 * anotarse y empezar a recibir pedidos de clientes reales sería
 * regalarle la feria al primero que instale la app.
 */
export async function postular(
  telefono: string,
  datos: { tipo?: string; nombre?: string; puesto?: string; rubros?: string[]; vehiculo?: string },
  feriaId: string,
) {
  const previa = await solicitudDe(telefono);
  if (previa) {
    throw new ErrorNegocio(409,
      previa.estado === 'pendiente' ? 'Ya tienes una solicitud en revisión.'
        : previa.estado === 'aprobada' ? 'Ya estás aprobado. Sal y vuelve a entrar.'
          : 'Tu registro anterior está cerrado. Habla con la operación.');
  }
  if (datos.tipo === 'feriante') {
    await crearFeriante({ ...datos, telefono }, feriaId, { solicitud: true });
  } else if (datos.tipo === 'repartidor') {
    await crearRepartidor({ ...datos, telefono }, { solicitud: true });
  } else {
    throw new ErrorNegocio(422, 'Elige si quieres vender o repartir.');
  }
  return (await solicitudDe(telefono))!;
}

// ============================================================
// Clientes
// ============================================================

/** Guarda los datos de entrega para la próxima compra. */
export async function guardarPerfilCliente(
  clienteId: string, datos: { nombre?: unknown; email?: unknown; direccion?: unknown },
) {
  const corto = (v: unknown, max: number) =>
    (typeof v === 'string' ? v.trim().slice(0, max) : '');
  await ejecutar(
    'UPDATE clientes SET nombre = ?, email = ?, direccion = ? WHERE id = ?',
    corto(datos.nombre, 80), corto(datos.email, 120) || null,
    corto(datos.direccion, 200) || null, clienteId);
  return consultarUno<Fila>('SELECT * FROM clientes WHERE id = ?', clienteId);
}
