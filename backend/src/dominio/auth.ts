import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila } from '../db/index.ts';
import { enviarSms, proveedorSms } from '../sms.ts';
import { enviarCorreo, proveedorCorreo } from '../correo.ts';
import { CONFIG } from '../config.ts';

export class ErrorAuth extends Error {
  codigo: number;
  constructor(codigo: number, msg: string) {
    super(msg);
    this.codigo = codigo;
    this.name = 'ErrorAuth';
  }
}

/**
 * Secreto con el que se firman códigos y tokens.
 *
 * Si cambia, todas las sesiones abiertas dejan de valer. Por eso en
 * producción es obligatorio configurarlo: un valor generado al
 * arrancar echaría a todos los feriantes en cada despliegue.
 */
function secreto(): string {
  const s = process.env.FERIA_SECRETO;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Falta FERIA_SECRETO. Genéralo con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return 'secreto-de-desarrollo-no-usar-en-produccion';
}

const hmac = (valor: string): string =>
  createHmac('sha256', secreto()).update(valor).digest('hex');

const hashToken = (token: string): string =>
  createHash('sha256').update(token + secreto()).digest('hex');

/** Comparación en tiempo constante, para no filtrar el código por lo que tarda. */
function igualSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Normaliza un número chileno a formato E.164.
 *
 * La gente lo escribe de todas las formas: «9 8765 4321»,
 * «+56 9 8765 4321», «56987654321». Todas tienen que llegar a la
 * misma fila, o el feriante no puede entrar con su propio número.
 */
export function normalizarTelefono(entrada: string): string {
  const limpio = String(entrada ?? '').replace(/[^\d+]/g, '');
  const digitos = limpio.replace(/\D/g, '');
  const malo = new ErrorAuth(400, 'Número de teléfono inválido. Usa el formato +56 9 1234 5678.');

  // Si escribió un prefijo internacional explícito y no es Chile,
  // se rechaza. Antes un "+1 555 0100" terminaba convertido en un
  // número chileno inventado.
  if (limpio.startsWith('+') && !limpio.startsWith('+56')) throw malo;

  if (digitos.length === 11 && digitos.startsWith('569')) return '+' + digitos;
  if (digitos.length === 9 && digitos.startsWith('9')) return '+56' + digitos;

  // Ocho dígitos sueltos serían ambiguos: no se adivina.
  throw malo;
}

/**
 * Busca a quién pertenece un teléfono.
 *
 * Primero la gente de la feria —operador, feriante, repartidor,
 * solo los activos— y después los clientes. Un feriante dado de
 * baja, o uno que pidió entrar y todavía no fue aprobado, entra
 * como cliente: puede comprar, no puede vender.
 */
async function quienEs(telefono: string): Promise<{ rol: string; id: string; nombre: string } | null> {
  const op = await consultarUno<Fila>('SELECT * FROM operadores WHERE telefono = ?', telefono);
  if (op) return { rol: 'operador', id: op.id, nombre: op.nombre };

  const f = await consultarUno<Fila>('SELECT * FROM feriantes WHERE telefono = ? AND activo', telefono);
  if (f) return { rol: 'feriante', id: f.id, nombre: f.nombre };

  const r = await consultarUno<Fila>('SELECT * FROM repartidores WHERE telefono = ? AND activo', telefono);
  if (r) return { rol: 'repartidor', id: r.id, nombre: r.nombre };

  const c = await consultarUno<Fila>('SELECT * FROM clientes WHERE telefono = ?', telefono);
  if (c) return { rol: 'cliente', id: c.id, nombre: c.nombre };

  return null;
}

// ============================================================
// Pedir código
// ============================================================

/**
 * Manda un código de 6 dígitos por SMS.
 *
 * A cualquier celular chileno: un número que no se conoce es un
 * cliente nuevo, y con el código queda registrado. La respuesta es
 * la misma para todos, así que no dice qué números son de feriantes.
 */
export async function pedirCodigo(
  telefonoCrudo: string,
  opciones: { ocultarCodigo?: boolean } = {},
): Promise<{ enviado: true; expiraEn: number; codigoDev?: string }> {
  const telefono = normalizarTelefono(telefonoCrudo);

  // Freno de abuso: cada SMS cuesta plata y molesta al dueño del
  // número. Se cuenta por teléfono, que es lo que se está atacando.
  const recientes = await consultarUno<Fila>(
    `SELECT COUNT(*)::int AS n FROM codigos_acceso
      WHERE telefono = ? AND creado_at > now() - make_interval(secs => ?)`,
    telefono, CONFIG.auth.ventanaEnvioSegundos);
  if ((recientes?.n ?? 0) >= CONFIG.auth.maxEnviosPorVentana) {
    throw new ErrorAuth(429, 'Pediste demasiados códigos. Espera unos minutos.');
  }

  const quien = await quienEs(telefono);
  const esDelEquipo = !!quien && quien.rol !== 'cliente';

  // Al equipo el operador le puede dictar el código desde el panel;
  // a un cliente no. Sin proveedor de SMS en producción, pedirle el
  // código sería dejarlo esperando un mensaje que no va a llegar.
  if (!esDelEquipo && process.env.NODE_ENV === 'production' && proveedorSms() === 'consola') {
    throw new ErrorAuth(503, 'El ingreso por mensaje todavía no está disponible.');
  }

  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expira = new Date(Date.now() + CONFIG.auth.vidaCodigoSegundos * 1000);

  await enTransaccion(async () => {
    // Un código nuevo invalida los anteriores: si no, quedan varios
    // válidos a la vez y se multiplican los intentos disponibles.
    await ejecutar(
      'UPDATE codigos_acceso SET usado_at = ? WHERE telefono = ? AND usado_at IS NULL',
      ahora(), telefono);
    await ejecutar(
      `INSERT INTO codigos_acceso (id, telefono, codigo_hash, expira_at)
       VALUES (?, ?, ?, ?)`,
      id(), telefono, hmac(telefono + ':' + codigo), expira);
  });

  const envio = await enviarSms(telefono,
    `Feria: tu código es ${codigo}. Vence en ${Math.round(CONFIG.auth.vidaCodigoSegundos / 60)} minutos.`);
  // Al cliente no hay otra forma de hacerle llegar el código: si el
  // mensaje no salió, tiene que saberlo en vez de quedarse esperando.
  if (!envio.enviado && !esDelEquipo) {
    throw new ErrorAuth(502, 'No pudimos mandarte el mensaje. Intenta de nuevo en un rato.');
  }
  await registrarEvento('auth', quien?.id ?? telefono, 'código enviado',
    { rol: quien?.rol ?? 'cliente nuevo', via: proveedorSms() });

  return {
    enviado: true,
    expiraEn: CONFIG.auth.vidaCodigoSegundos,
    // Sin proveedor de SMS no hay forma de recibir el código, así
    // que en desarrollo se devuelve. En producción nunca sale.
    ...(process.env.NODE_ENV !== 'production' && proveedorSms() === 'consola'
        && !opciones.ocultarCodigo
      ? { codigoDev: codigo }
      : {}),
  };
}

// ============================================================
// Canjear código por sesión
// ============================================================

export type Sesion = {
  token: string;
  rol: string;
  actorId: string;
  nombre: string;
  expiraAt: Date;
};

/**
 * Comprueba un código contra su destino (un teléfono o un correo).
 *
 * No lo consume: eso lo hace `abrirSesion`, dentro de la misma
 * transacción que crea la sesión.
 */
async function comprobarCodigo(destino: string, codigo: string): Promise<Fila> {
  const generico = new ErrorAuth(401, 'Código incorrecto o vencido.');

  const fila = await consultarUno<Fila>(
    `SELECT * FROM codigos_acceso
      WHERE telefono = ? AND usado_at IS NULL
      ORDER BY creado_at DESC LIMIT 1`,
    destino);
  if (!fila) throw generico;
  if (fila.expira_at.getTime() < Date.now()) throw generico;

  // Sin tope de intentos, seis dígitos se prueban enteros en
  // minutos. Pasado el tope el código muere, no se bloquea el
  // número: si no, cualquiera deja a un feriante afuera.
  if (fila.intentos >= CONFIG.auth.maxIntentos) {
    await ejecutar('UPDATE codigos_acceso SET usado_at = ? WHERE id = ?', ahora(), fila.id);
    throw new ErrorAuth(429, 'Demasiados intentos. Pide un código nuevo.');
  }

  // El contador se escribe FUERA de cualquier transacción, y antes
  // de comparar. Si el incremento viviera dentro de la transacción
  // que después lanza el error, el ROLLBACK lo borraría junto con
  // el error y el código se podría probar infinitas veces.
  await ejecutar('UPDATE codigos_acceso SET intentos = intentos + 1 WHERE id = ?', fila.id);

  if (!igualSeguro(fila.codigo_hash, hmac(destino + ':' + String(codigo ?? '').trim()))) {
    throw generico;
  }
  return fila;
}

type Quien = { rol: string; id: string; nombre: string };

/**
 * Crea la sesión. Con `codigoId`, antes consume ese código.
 *
 * `quien` se resuelve adentro de la transacción: es donde se
 * registra al cliente nuevo, y no puede quedar registrado alguien
 * cuya sesión después no se creó.
 */
async function abrirSesion(datos: {
  codigoId?: string;
  quien: () => Promise<Quien>;
  telefono: string | null;
  dispositivo?: string;
}): Promise<Sesion> {
  return enTransaccion(async () => {
    if (datos.codigoId) {
      // Marcar usado de forma condicional cierra la carrera de dos
      // peticiones con el mismo código correcto a la vez: la segunda
      // no afecta ninguna fila y no llega a crear sesión.
      const consumido = await ejecutar(
        'UPDATE codigos_acceso SET usado_at = ? WHERE id = ? AND usado_at IS NULL',
        ahora(), datos.codigoId);
      if (consumido.afectadas !== 1) throw new ErrorAuth(401, 'Código incorrecto o vencido.');
    }

    const quien = await datos.quien();
    const token = randomBytes(32).toString('base64url');
    const expiraAt = new Date(Date.now() + CONFIG.auth.vidaSesionDias * 86_400_000);
    await ejecutar(
      `INSERT INTO sesiones (id, token_hash, rol, actor_id, telefono, dispositivo, expira_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id(), hashToken(token), quien.rol, quien.id, datos.telefono,
      datos.dispositivo?.slice(0, 120) ?? null, expiraAt);

    await registrarEvento('auth', quien.id, 'sesión iniciada',
      { rol: quien.rol, dispositivo: datos.dispositivo });
    return { token, rol: quien.rol, actorId: quien.id, nombre: quien.nombre, expiraAt };
  });
}

/** Registra un cliente nuevo con lo que se sepa de él. */
async function nuevoCliente(campos: Record<string, string | null>): Promise<Quien> {
  const nuevo = 'c-' + id().slice(0, 12);
  const columnas = Object.keys(campos);
  await ejecutar(
    `INSERT INTO clientes (id, ${columnas.join(', ')})
     VALUES (?, ${columnas.map(() => '?').join(', ')})`,
    nuevo, ...Object.values(campos));
  await registrarEvento('cliente', nuevo, 'registrado', { con: columnas });
  return { rol: 'cliente', id: nuevo, nombre: campos.nombre ?? '' };
}

export async function crearSesion(
  telefonoCrudo: string, codigo: string, dispositivo?: string,
): Promise<Sesion> {
  const telefono = normalizarTelefono(telefonoCrudo);
  const fila = await comprobarCodigo(telefono, codigo);

  return abrirSesion({
    codigoId: fila.id,
    telefono,
    dispositivo,
    // Un número que no es de nadie y que demostró ser de quien lo
    // escribió: es un cliente nuevo. Se registra acá, no al pedir el
    // código, para no llenar la tabla de números que alguien tipeó.
    quien: async () => (await quienEs(telefono)) ?? nuevoCliente({ telefono }),
  });
}

// ============================================================
// Ingreso del comprador sin teléfono: código al correo
// ============================================================

/**
 * Deja el correo en una sola forma, o lo rechaza.
 *
 * No se intenta validar de verdad —la única validación que vale es
 * que el código llegue—, solo descartar lo que claramente no es.
 */
export function normalizarCorreo(entrada: unknown): string {
  const correo = String(entrada ?? '').trim().toLowerCase();
  if (correo.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
    throw new ErrorAuth(400, 'Ese correo no parece válido.');
  }
  return correo;
}

/** Genera y guarda un código para un destino, con su freno de abuso. */
async function emitirCodigo(destino: string): Promise<string> {
  const recientes = await consultarUno<Fila>(
    `SELECT COUNT(*)::int AS n FROM codigos_acceso
      WHERE telefono = ? AND creado_at > now() - make_interval(secs => ?)`,
    destino, CONFIG.auth.ventanaEnvioSegundos);
  if ((recientes?.n ?? 0) >= CONFIG.auth.maxEnviosPorVentana) {
    throw new ErrorAuth(429, 'Pediste demasiados códigos. Espera unos minutos.');
  }

  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expira = new Date(Date.now() + CONFIG.auth.vidaCodigoSegundos * 1000);
  await enTransaccion(async () => {
    await ejecutar(
      'UPDATE codigos_acceso SET usado_at = ? WHERE telefono = ? AND usado_at IS NULL',
      ahora(), destino);
    await ejecutar(
      `INSERT INTO codigos_acceso (id, telefono, codigo_hash, expira_at)
       VALUES (?, ?, ?, ?)`,
      id(), destino, hmac(destino + ':' + codigo), expira);
  });
  return codigo;
}

/**
 * Manda el código al correo. Es el ingreso del comprador que no
 * quiere —o no puede— recibir un SMS, y no cuesta un mensaje.
 *
 * Con correo solo se entra como cliente. Feriantes, repartidores y
 * el operador entran con su teléfono, que es el número al que se
 * los llama y con el que el operador los aprobó.
 */
export async function pedirCodigoPorCorreo(
  correoCrudo: unknown, opciones: { ocultarCodigo?: boolean } = {},
): Promise<{ enviado: true; expiraEn: number; codigoDev?: string }> {
  const correo = normalizarCorreo(correoCrudo);

  if (process.env.NODE_ENV === 'production' && proveedorCorreo() === 'consola') {
    throw new ErrorAuth(503, 'El ingreso por correo todavía no está disponible.');
  }

  const codigo = await emitirCodigo(correo);
  const minutos = Math.round(CONFIG.auth.vidaCodigoSegundos / 60);
  const envio = await enviarCorreo(correo, `${codigo} es tu código de la Feria`,
    `Tu código para entrar a la Feria es ${codigo}.\n\nVence en ${minutos} minutos. `
    + 'Si no lo pediste tú, no hagas nada: sin el código nadie puede entrar.');
  if (!envio.enviado) {
    throw new ErrorAuth(502, 'No pudimos mandarte el correo. Intenta de nuevo en un rato.');
  }
  await registrarEvento('auth', correo, 'código enviado', { via: `correo:${proveedorCorreo()}` });

  return {
    enviado: true,
    expiraEn: CONFIG.auth.vidaCodigoSegundos,
    ...(process.env.NODE_ENV !== 'production' && proveedorCorreo() === 'consola'
        && !opciones.ocultarCodigo
      ? { codigoDev: codigo } : {}),
  };
}

export async function crearSesionPorCorreo(
  correoCrudo: unknown, codigo: string, dispositivo?: string,
): Promise<Sesion> {
  const correo = normalizarCorreo(correoCrudo);
  const fila = await comprobarCodigo(correo, codigo);

  return abrirSesion({
    codigoId: fila.id,
    telefono: null,
    dispositivo,
    quien: async () => {
      const c = await consultarUno<Fila>(
        'SELECT * FROM clientes WHERE correo_ingreso = ?', correo);
      return c
        ? { rol: 'cliente', id: c.id, nombre: c.nombre }
        : nuevoCliente({ correo_ingreso: correo, email: correo });
    },
  });
}

// ============================================================
// Ingreso del comprador con Google o con Apple
// ============================================================

export type IdentidadExterna = {
  proveedor: 'google' | 'apple';
  /** El identificador de la persona en ese proveedor. No cambia. */
  sub: string;
  /** Solo si el proveedor asegura que es de ella. */
  correo: string | null;
  nombre: string | null;
};

/**
 * Abre la sesión de alguien que Google o Apple ya identificaron.
 *
 * Llega acá recién después de verificar la firma del token (ver
 * `externo.ts`). Si esa persona ya había entrado con el mismo
 * correo por código, es la misma cuenta: no se le crea otra.
 */
export async function crearSesionExterna(
  persona: IdentidadExterna, dispositivo?: string,
): Promise<Sesion> {
  const columna = persona.proveedor === 'google' ? 'google_sub' : 'apple_sub';

  return abrirSesion({
    telefono: null,
    dispositivo,
    quien: async () => {
      const conocido = await consultarUno<Fila>(
        `SELECT * FROM clientes WHERE ${columna} = ?`, persona.sub);
      if (conocido) return { rol: 'cliente', id: conocido.id, nombre: conocido.nombre };

      const mismoCorreo = persona.correo
        ? await consultarUno<Fila>(
            'SELECT * FROM clientes WHERE correo_ingreso = ?', persona.correo)
        : undefined;
      if (mismoCorreo) {
        await ejecutar(`UPDATE clientes SET ${columna} = ? WHERE id = ?`,
          persona.sub, mismoCorreo.id);
        return { rol: 'cliente', id: mismoCorreo.id, nombre: mismoCorreo.nombre };
      }

      return nuevoCliente({
        [columna]: persona.sub,
        correo_ingreso: persona.correo,
        email: persona.correo,
        nombre: (persona.nombre ?? '').slice(0, 80),
      });
    },
  });
}

// ============================================================
// Verificar en cada petición
// ============================================================

export type Identidad = { rol: string; actorId: string; sesionId: string };

export async function verificarToken(token: string | undefined): Promise<Identidad> {
  if (!token) throw new ErrorAuth(401, 'Falta el token de sesión.');

  const s = await consultarUno<Fila>(
    `SELECT * FROM sesiones
      WHERE token_hash = ? AND revocada_at IS NULL AND expira_at > now()`,
    hashToken(token));
  if (!s) throw new ErrorAuth(401, 'Sesión inválida o vencida. Vuelve a entrar.');

  // Marca de uso, para poder cerrar sesiones abandonadas. Se
  // actualiza como mucho una vez por hora: escribir en cada
  // petición sería una escritura por cada refresco de pantalla.
  if (!s.ultima_at || Date.now() - s.ultima_at.getTime() > 3_600_000) {
    await ejecutar('UPDATE sesiones SET ultima_at = ? WHERE id = ?', ahora(), s.id);
  }

  return { rol: s.rol, actorId: s.actor_id, sesionId: s.id };
}

export async function cerrarSesion(sesionId: string): Promise<void> {
  await ejecutar('UPDATE sesiones SET revocada_at = ? WHERE id = ?', ahora(), sesionId);
}

/** Cierra todas las sesiones de una persona: sirve si pierde el teléfono. */
export async function cerrarTodas(actorId: string): Promise<number> {
  const r = await ejecutar(
    'UPDATE sesiones SET revocada_at = ? WHERE actor_id = ? AND revocada_at IS NULL',
    ahora(), actorId);
  await registrarEvento('auth', actorId, 'sesiones cerradas', { cantidad: r.afectadas });
  return r.afectadas;
}

export async function sesionesDe(actorId: string): Promise<Fila[]> {
  return consultar(
    `SELECT id, dispositivo, creada_at, ultima_at, expira_at
       FROM sesiones WHERE actor_id = ? AND revocada_at IS NULL AND expira_at > now()
      ORDER BY creada_at DESC`,
    actorId);
}

/**
 * El operador genera un código y se lo pasa a la persona.
 *
 * En una feria de diez personas que se ven todos los sábados,
 * pagarle a Twilio por cada ingreso es gastar en resolver un
 * problema que no existe: el operador conoce a cada feriante de
 * nombre y lo tiene enfrente. Con esto le dicta el código en la
 * cara, o se lo manda por WhatsApp desde su propio teléfono.
 *
 * El código sale igual por SMS si hay proveedor configurado — este
 * camino es el respaldo para cuando no hay, no un reemplazo.
 *
 * Queda registrado quién lo generó y para quién. Es un poder real:
 * con este código, el operador puede entrar como cualquiera. En una
 * operación donde él ya maneja toda la plata eso es aceptable, pero
 * tiene que dejar rastro.
 */
export async function codigoParaAlguien(
  actorId: string, operadorId: string,
): Promise<{ nombre: string; telefono: string; codigo: string; expiraEn: number }> {
  const persona = await consultarUno<Fila>(
    `SELECT id, nombre, telefono, 'feriante' AS rol FROM feriantes WHERE id = ?
     UNION ALL
     SELECT id, nombre, telefono, 'repartidor' FROM repartidores WHERE id = ?
     UNION ALL
     SELECT id, nombre, telefono, 'operador' FROM operadores WHERE id = ?`,
    actorId, actorId, actorId);
  if (!persona) throw new ErrorAuth(404, 'No hay nadie con ese id.');

  const telefono = normalizarTelefono(persona.telefono);
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expira = new Date(Date.now() + CONFIG.auth.vidaCodigoSegundos * 1000);

  await enTransaccion(async () => {
    await ejecutar(
      'UPDATE codigos_acceso SET usado_at = ? WHERE telefono = ? AND usado_at IS NULL',
      ahora(), telefono);
    await ejecutar(
      `INSERT INTO codigos_acceso (id, telefono, codigo_hash, expira_at)
       VALUES (?, ?, ?, ?)`,
      id(), telefono, hmac(telefono + ':' + codigo), expira);
  });

  // Si hay proveedor, igual se manda: mejor que le llegue solo.
  await enviarSms(telefono,
    `Feria: tu código es ${codigo}. Vence en ${Math.round(CONFIG.auth.vidaCodigoSegundos / 60)} minutos.`);

  await registrarEvento('auth', persona.id, 'código generado por el operador',
    { rol: persona.rol, operadorId });

  return {
    nombre: persona.nombre,
    telefono,
    codigo,
    expiraEn: CONFIG.auth.vidaCodigoSegundos,
  };
}
