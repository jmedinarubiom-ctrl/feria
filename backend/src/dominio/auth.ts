import {
  createHmac, randomBytes, randomInt, timingSafeEqual, createHash, scryptSync,
} from 'node:crypto';
import { ahora, consultar, consultarUno, ejecutar, enTransaccion, id, registrarEvento, type Fila } from '../db/index.ts';
import { enviarSms, proveedorSms } from '../sms.ts';
import { enviarCorreo, proveedorCorreo, plantillaCorreo } from '../correo.ts';
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

  await frenarAdivinanzas(telefono);

  const quien = await quienEs(telefono);
  const esDelEquipo = !!quien && quien.rol !== 'cliente';

  // Al equipo el operador le puede dictar el código desde el panel;
  // a un cliente no. Sin proveedor de SMS en producción, pedirle el
  // código sería dejarlo esperando un mensaje que no va a llegar.
  // Lo mismo con el servidor de prueba abierto a internet: ahí el
  // código no sale en pantalla.
  if (!esDelEquipo && proveedorSms() === 'consola'
      && (process.env.NODE_ENV === 'production' || opciones.ocultarCodigo)) {
    throw new ErrorAuth(503,
      'El ingreso por mensaje todavía no está disponible. Entra con tu correo o con Google.');
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
  // Un código que el operador le dictó a alguien de su equipo pasa
  // aunque el tope del día esté cumplido: es justamente la salida.
  if (!fila.del_operador) await frenarAdivinanzas(destino);

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
    await ejecutar('UPDATE codigos_acceso SET fallos = fallos + 1 WHERE id = ?', fila.id);
    throw generico;
  }
  return fila;
}

/**
 * Tope de intentos fallidos por día para un mismo teléfono o correo.
 *
 * Cada código muere a los cinco intentos, pero se puede pedir otro:
 * tres códigos cada quince minutos son 1.440 intentos al día contra
 * la cuenta de una persona, y con seis dígitos eso es 1 posibilidad
 * en 700 de acertar cada día. Para la cuenta del operador es
 * demasiado. Con el tope, quien adivina tiene 20 intentos al día:
 * 1 en 50.000.
 *
 * El costo: alguien puede dejar a otro sin poder ENTRAR por un día
 * fallando a propósito. No le cierra las sesiones que ya tiene, y
 * a su equipo el operador le dicta un código desde el panel.
 */
async function frenarAdivinanzas(destino: string): Promise<void> {
  const r = await consultarUno<Fila>(
    `SELECT COALESCE(SUM(fallos), 0)::int AS n FROM codigos_acceso
      WHERE telefono = ? AND creado_at > now() - make_interval(hours => 24)`,
    destino);
  if ((r?.n ?? 0) >= CONFIG.auth.maxFallosPorDia) {
    throw new ErrorAuth(429,
      'Demasiados intentos fallidos. Por seguridad, este ingreso queda detenido hasta mañana.');
  }
}

/**
 * Comprueba y consume un código fuera de un inicio de sesión: para
 * confirmar que un número es de quien dice, sin abrir otra sesión.
 */
export async function confirmarCodigo(destino: string, codigo: string): Promise<void> {
  const fila = await comprobarCodigo(destino, codigo);
  const r = await ejecutar(
    'UPDATE codigos_acceso SET usado_at = ? WHERE id = ? AND usado_at IS NULL', ahora(), fila.id);
  if (r.afectadas !== 1) throw new ErrorAuth(401, 'Código incorrecto o vencido.');
}

// ============================================================
// La clave del operador: su segundo factor
// ============================================================

const hashClave = (clave: string, sal = randomBytes(16).toString('hex')): string =>
  `scrypt$${sal}$${scryptSync(clave, sal, 32).toString('hex')}`;

function claveCoincide(clave: string, guardada: string): boolean {
  const [, sal, esperado] = guardada.split('$');
  if (!sal || !esperado) return false;
  return igualSeguro(scryptSync(clave, sal, 32).toString('hex'), esperado);
}

/**
 * Pone o cambia la clave del operador.
 *
 * Se guarda con scrypt y sal propia: quien lea la base no la
 * obtiene. Para cambiarla hay que saber la anterior; tener el
 * teléfono desbloqueado en la mano no alcanza.
 */
export async function fijarClaveOperador(
  operadorId: string, nueva: unknown, actual?: unknown, sesionActual?: string,
): Promise<{ conClave: true }> {
  const op = await consultarUno<Fila>('SELECT * FROM operadores WHERE id = ?', operadorId);
  if (!op) throw new ErrorAuth(404, 'Operador no encontrado.');
  if (op.clave_hash && !(typeof actual === 'string' && claveCoincide(actual, op.clave_hash))) {
    throw new ErrorAuth(403, 'La clave actual no coincide.');
  }
  if (typeof nueva !== 'string' || nueva.length < 10 || nueva.length > 200) {
    throw new ErrorAuth(422, 'La clave tiene que tener al menos 10 caracteres.');
  }
  await ejecutar('UPDATE operadores SET clave_hash = ? WHERE id = ?', hashClave(nueva), operadorId);
  // Con clave nueva, las demás sesiones abiertas se cierran: si se
  // cambió porque alguien más estaba adentro, que no siga adentro.
  await ejecutar(
    `UPDATE sesiones SET revocada_at = ?
      WHERE actor_id = ? AND revocada_at IS NULL AND id <> ?`,
    ahora(), operadorId, sesionActual ?? '');
  await registrarEvento('auth', operadorId, op.clave_hash ? 'clave cambiada' : 'clave creada');
  return { conClave: true };
}

/** Error de «falta la clave», para que la app muestre el campo. */
export class FaltaClave extends ErrorAuth {
  pideClave = true;
  constructor(msg = 'Escribe tu clave de operador.') {
    super(401, msg);
    this.name = 'FaltaClave';
  }
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
    if (quien.rol === 'cliente') {
      await ejecutar('UPDATE clientes SET ultima_actividad_at = ? WHERE id = ?', ahora(), quien.id);
    }
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

/** «ca•••@gmail.com»: lo justo para reconocer el propio correo. */
const taparCorreo = (correo: string): string => {
  const [usuario, dominio] = correo.split('@');
  return `${usuario.slice(0, 2)}•••@${dominio}`;
};

/**
 * Falta la segunda prueba: el código que se mandó al correo.
 *
 * La app muestra un campo más y reenvía todo junto. `correo` va
 * tapado: quien no es el dueño no tiene por qué enterarse de cuál es.
 */
export class FaltaCorreo extends ErrorAuth {
  pideCorreo = true;
  correo: string;
  codigoDev?: string;
  constructor(correo: string, msg: string, codigoDev?: string) {
    super(401, msg);
    this.name = 'FaltaCorreo';
    this.correo = taparCorreo(correo);
    this.codigoDev = codigoDev;
  }
}

/**
 * La segunda prueba para una cuenta que lleva meses sin usarse.
 *
 * Un número que nadie usa la compañía se lo entrega a otra persona,
 * y esa persona recibe el SMS. Si la cuenta tiene un correo
 * confirmado, el SMS solo no alcanza para volver después de mucho
 * tiempo: hay que recibir también un código en ese correo, que el
 * dueño nuevo del número no tiene.
 *
 * Solo aplica si se puede mandar el correo: sin proveedor en
 * producción no se exige, porque dejaría afuera al dueño de verdad.
 */
async function pedirSegundaPrueba(telefono: string, codigoCorreo: unknown): Promise<void> {
  const c = await consultarUno<Fila>(
    `SELECT id, correo_ingreso FROM clientes
      WHERE telefono = ? AND correo_ingreso IS NOT NULL
        AND ultima_actividad_at < now() - make_interval(days => ?)`,
    telefono, CONFIG.auth.diasParaSegundaPrueba);
  if (!c) return;
  if (process.env.NODE_ENV === 'production' && proveedorCorreo() === 'consola') return;

  const correo: string = c.correo_ingreso;
  if (typeof codigoCorreo === 'string' && codigoCorreo.trim()) {
    try {
      await confirmarCodigo(correo, codigoCorreo);
      await registrarEvento('auth', c.id, 'segunda prueba por correo superada');
      return;
    } catch (e) {
      if (e instanceof ErrorAuth && e.codigo === 429) throw e;
      throw new FaltaCorreo(correo, 'El código del correo no es correcto o ya venció.');
    }
  }

  // Se manda uno solo: si ya hay un código vivo para ese correo no
  // se manda otro por cada vez que la app pregunta.
  const vivo = await consultarUno<Fila>(
    `SELECT id FROM codigos_acceso
      WHERE telefono = ? AND usado_at IS NULL AND expira_at > now()`, correo);
  let codigoDev: string | undefined;
  if (!vivo) {
    const nuevo = await emitirCodigo(correo);
    const minutos = Math.round(CONFIG.auth.vidaCodigoSegundos / 60);
    await enviarCorreo(correo, 'Confirma que eres tú',
      `Hola:\n\nAlguien está entrando a tu cuenta de la Feria con tu teléfono después de mucho `
      + `tiempo sin usarla. Si eres tú, escribe este código en la app: ${nuevo}\n\n`
      + `Vence en ${minutos} minutos. Si no eres tú, no hagas nada: sin este código no pueden entrar.`);
    if (process.env.NODE_ENV !== 'production' && proveedorCorreo() === 'consola') codigoDev = nuevo;
    await registrarEvento('auth', c.id, 'segunda prueba por correo pedida');
  }
  throw new FaltaCorreo(correo,
    'Hace tiempo que no entras. Te mandamos otro código a tu correo para confirmar que eres tú.',
    codigoDev);
}

export async function crearSesion(
  telefonoCrudo: string, codigo: string, dispositivo?: string, clave?: unknown,
  codigoCorreo?: unknown,
): Promise<Sesion> {
  const telefono = normalizarTelefono(telefonoCrudo);
  const fila = await comprobarCodigo(telefono, codigo);

  // El código del SMS está bien. Si la cuenta lleva meses sin uso y
  // tiene correo, falta la segunda prueba. El código del SMS no se
  // consume todavía.
  await pedirSegundaPrueba(telefono, codigoCorreo);

  // El código está bien. Si es el operador y tiene clave, falta la
  // otra mitad. El código NO se consume todavía: la app muestra el
  // campo de la clave y manda las dos cosas juntas.
  const op = await consultarUno<Fila>(
    'SELECT id, clave_hash FROM operadores WHERE telefono = ?', telefono);
  if (op?.clave_hash) {
    if (typeof clave !== 'string' || !clave) throw new FaltaClave();
    if (!claveCoincide(clave, op.clave_hash)) {
      // Cuenta contra el tope del día, igual que un código malo.
      await ejecutar('UPDATE codigos_acceso SET fallos = fallos + 1 WHERE id = ?', fila.id);
      await registrarEvento('auth', op.id, 'clave incorrecta', { dispositivo });
      throw new FaltaClave('Clave incorrecta.');
    }
  }

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
  // El asunto no parte con el número: un asunto que es casi puro
  // código es una de las cosas que mandan un correo a spam.
  const envio = await enviarCorreo(correo, 'Tu código para entrar a la Feria',
    `Hola:\n\nTu código para entrar a Feria App es ${codigo}.\n\n`
    + `Escríbelo en la app. Vence en ${minutos} minutos.\n\n`
    + 'Si no lo pediste tú, no hagas nada: sin el código nadie puede entrar a tu cuenta.\n\n'
    + 'Feria App · tu feria libre, a domicilio',
    correoDeCodigo(codigo, minutos));
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

/** La versión con formato del correo del código. */
function correoDeCodigo(codigo: string, minutos: number): string {
  return plantillaCorreo(`    <p style="font-size:15px;line-height:1.5;margin:0 0 16px">Hola, este es tu código para entrar a la app:</p>
    <p style="font-size:34px;font-weight:bold;letter-spacing:6px;margin:0 0 16px;padding:16px;
              background:#F4F6F4;border-radius:12px;text-align:center;color:#16211D">${codigo}</p>
    <p style="font-size:15px;line-height:1.5;margin:0 0 16px">Escríbelo en la app. Vence en ${minutos} minutos.</p>
    <p style="font-size:13px;line-height:1.5;color:#6B7670;margin:0">Si no lo pediste tú, no hagas nada:
       sin el código nadie puede entrar a tu cuenta.</p>`);
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

  // Una sesión que nadie usa hace semanas es la de un teléfono
  // perdido, vendido o regalado. Se cierra sola.
  const ultima = (s.ultima_at ?? s.creada_at).getTime();
  if (Date.now() - ultima > CONFIG.auth.diasSinUso * 86_400_000) {
    await ejecutar('UPDATE sesiones SET revocada_at = ? WHERE id = ?', ahora(), s.id);
    throw new ErrorAuth(401, 'La sesión se cerró por no usarse. Vuelve a entrar.');
  }

  // Marca de uso, para poder cerrar sesiones abandonadas. Se
  // actualiza como mucho una vez por hora: escribir en cada
  // petición sería una escritura por cada refresco de pantalla.
  if (!s.ultima_at || Date.now() - s.ultima_at.getTime() > 3_600_000) {
    await ejecutar('UPDATE sesiones SET ultima_at = ? WHERE id = ?', ahora(), s.id);
    if (s.rol === 'cliente') {
      await ejecutar('UPDATE clientes SET ultima_actividad_at = ? WHERE id = ?', ahora(), s.actor_id);
    }
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
      `INSERT INTO codigos_acceso (id, telefono, codigo_hash, expira_at, del_operador)
       VALUES (?, ?, ?, ?, true)`,
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
