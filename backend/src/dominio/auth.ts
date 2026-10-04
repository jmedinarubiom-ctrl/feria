import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila } from '../db/index.ts';
import { enviarSms, proveedorSms } from '../sms.ts';
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
    throw new Error('Falta FERIA_SECRETO. Generalo con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
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

/** Busca a quién pertenece un teléfono. El operador tiene prioridad. */
async function quienEs(telefono: string): Promise<{ rol: string; id: string; nombre: string } | null> {
  const op = await consultarUno<Fila>('SELECT * FROM operadores WHERE telefono = ?', telefono);
  if (op) return { rol: 'operador', id: op.id, nombre: op.nombre };

  const f = await consultarUno<Fila>('SELECT * FROM feriantes WHERE telefono = ?', telefono);
  if (f) return { rol: 'feriante', id: f.id, nombre: f.nombre };

  const r = await consultarUno<Fila>('SELECT * FROM repartidores WHERE telefono = ?', telefono);
  if (r) return { rol: 'repartidor', id: r.id, nombre: r.nombre };

  return null;
}

// ============================================================
// Pedir código
// ============================================================

/**
 * Manda un código de 6 dígitos por SMS.
 *
 * Devuelve lo mismo esté el número registrado o no: si contestara
 * distinto, cualquiera podría averiguar qué números pertenecen a
 * feriantes de la plataforma probando de a uno.
 */
export async function pedirCodigo(telefonoCrudo: string): Promise<{ enviado: true; expiraEn: number; codigoDev?: string }> {
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
  if (!quien) {
    // Se simula el trabajo del caso real para no delatar por tiempo
    // de respuesta que el número no existe.
    await new Promise((r) => setTimeout(r, 120));
    return { enviado: true, expiraEn: CONFIG.auth.vidaCodigoSegundos };
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

  await enviarSms(telefono,
    `Feria: tu código es ${codigo}. Vence en ${Math.round(CONFIG.auth.vidaCodigoSegundos / 60)} minutos.`);
  await registrarEvento('auth', quien.id, 'código enviado', { rol: quien.rol, via: proveedorSms() });

  return {
    enviado: true,
    expiraEn: CONFIG.auth.vidaCodigoSegundos,
    // Sin proveedor de SMS no hay forma de recibir el código, así
    // que en desarrollo se devuelve. En producción nunca sale.
    ...(process.env.NODE_ENV !== 'production' && proveedorSms() === 'consola'
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

export async function crearSesion(
  telefonoCrudo: string, codigo: string, dispositivo?: string,
): Promise<Sesion> {
  const telefono = normalizarTelefono(telefonoCrudo);
  const generico = new ErrorAuth(401, 'Código incorrecto o vencido.');

  const fila = await consultarUno<Fila>(
    `SELECT * FROM codigos_acceso
      WHERE telefono = ? AND usado_at IS NULL
      ORDER BY creado_at DESC LIMIT 1`,
    telefono);
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

  if (!igualSeguro(fila.codigo_hash, hmac(telefono + ':' + String(codigo ?? '').trim()))) {
    throw generico;
  }

  const quien = await quienEs(telefono);
  if (!quien) throw generico;

  return enTransaccion(async () => {
    // Marcar usado de forma condicional cierra la carrera de dos
    // peticiones con el mismo código correcto a la vez: la segunda
    // no afecta ninguna fila y no llega a crear sesión.
    const consumido = await ejecutar(
      'UPDATE codigos_acceso SET usado_at = ? WHERE id = ? AND usado_at IS NULL',
      ahora(), fila.id);
    if (consumido.afectadas !== 1) throw generico;

    const token = randomBytes(32).toString('base64url');
    const expiraAt = new Date(Date.now() + CONFIG.auth.vidaSesionDias * 86_400_000);
    await ejecutar(
      `INSERT INTO sesiones (id, token_hash, rol, actor_id, telefono, dispositivo, expira_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id(), hashToken(token), quien.rol, quien.id, telefono,
      dispositivo?.slice(0, 120) ?? null, expiraAt);

    await registrarEvento('auth', quien.id, 'sesión iniciada', { rol: quien.rol, dispositivo });
    return { token, rol: quien.rol, actorId: quien.id, nombre: quien.nombre, expiraAt };
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
  if (!s) throw new ErrorAuth(401, 'Sesión inválida o vencida. Volvé a entrar.');

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
