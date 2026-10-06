import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));

export type Fila = Record<string, any>;
export type Resultado = { filas: Fila[]; afectadas: number };

/** Lo mínimo que el dominio necesita de un motor de base de datos. */
interface Cliente {
  consulta(sql: string, params: any[]): Promise<Resultado>;
  /**
   * Ejecuta varias sentencias de una. El protocolo extendido de
   * Postgres —el que se usa con parámetros— acepta una sola
   * sentencia por llamada, así que el esquema necesita este camino.
   */
  script(sql: string): Promise<void>;
  liberar(): void;
}

interface Motor {
  tomar(): Promise<Cliente>;
  cerrar(): Promise<void>;
  nombre: string;
}

let motor: Motor;

type Transaccion = {
  cliente: Cliente;
  /** Efectos que solo deben ocurrir si la transacción confirma. */
  pendientes: Array<() => void>;
};

/**
 * La transacción en curso, si la hay.
 *
 * Se propaga por AsyncLocalStorage en vez de pasarla por parámetro:
 * el dominio ya está escrito en funciones que se llaman entre sí
 * varios niveles de profundidad, y hacer viajar un `client` por
 * todas ellas ensuciaría cada firma sin agregar nada.
 */
const enCurso = new AsyncLocalStorage<Transaccion>();

export const hayTransaccion = (): boolean => enCurso.getStore() !== undefined;

/**
 * Aplaza un efecto hasta que la transacción confirme.
 *
 * Los avisos a las apps tienen que salir DESPUÉS del COMMIT. Si
 * salieran antes, el teléfono del feriante recibiría el aviso y
 * pediría los datos por otra conexión, que todavía no ve la fila
 * sin confirmar — y si la transacción termina fallando, el aviso
 * ya se mandó y no hay forma de volverlo atrás.
 */
export function alConfirmar(efecto: () => void): void {
  const tx = enCurso.getStore();
  if (tx) tx.pendientes.push(efecto);
  else efecto();
}

// ============================================================
// Motores
// ============================================================

/**
 * Postgres real, para producción. Un pool: cada transacción toma
 * su conexión y la devuelve.
 */
async function motorPostgres(url: string): Promise<Motor> {
  const { default: pg } = await import('pg');

  // Los enteros de 64 bits (los id de eventos) llegan como string
  // por defecto para no perder precisión. Acá ninguno se acerca al
  // límite de un número de JavaScript y se usan como número.
  pg.types.setTypeParser(20, (v: string) => Number(v));

  const pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('sslmode=disable')
      ? undefined
      // Con el certificado de la autoridad del proveedor (`PG_CA`,
      // el contenido del .pem) se verifica contra quién se habla.
      // Sin él se cifra igual, pero se acepta cualquier servidor.
      : process.env.PG_CA
        ? { ca: process.env.PG_CA, rejectUnauthorized: true }
        : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.PG_POOL_REPOSO_MS ?? 30_000),
    // Sin esto, con la base caída cada petición espera para siempre
    // una conexión que no llega y el servidor parece colgado.
    connectionTimeoutMillis: 10_000,
    // Las bases administradas cortan las conexiones quietas desde su
    // lado; el keepalive evita enterarse recién al usarlas.
    keepAlive: true,
  });

  // Una conexión en reposo que la base corta emite 'error' en el
  // pool. Sin nadie escuchando, Node lo trata como excepción sin
  // atrapar y termina el proceso: la feria entera se caía porque la
  // base reinició una conexión que nadie estaba usando. El pool la
  // descarta solo; acá alcanza con anotarlo.
  pool.on('error', (e) => console.error('[postgres] conexión en reposo perdida:', e.message));

  return {
    nombre: 'postgres',
    async tomar() {
      const c = await pool.connect();
      // Lo mismo para una conexión tomada: si se corta entre dos
      // consultas de una transacción, el error llega por evento.
      let rota: Error | undefined;
      const alRomperse = (e: Error) => { rota = e; };
      c.on('error', alRomperse);
      return {
        async consulta(sql, params) {
          const r = await c.query(sql, params);
          return { filas: r.rows, afectadas: r.rowCount ?? 0 };
        },
        async script(sql) {
          await c.query(sql);
        },
        liberar: () => {
          c.removeListener('error', alRomperse);
          // Con el error, el pool la destruye en vez de reusarla.
          c.release(rota);
        },
      };
    },
    cerrar: () => pool.end(),
  };
}

/**
 * PGlite: PostgreSQL compilado a WebAssembly, en proceso.
 *
 * Es Postgres de verdad — mismo dialecto, mismas transacciones —
 * pero se instala con npm y no necesita servidor. Sirve para correr
 * los tests y para desarrollar sin montar nada.
 */
async function motorPGlite(ruta?: string): Promise<Motor> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(ruta);
  await db.waitReady;

  // Una sola conexión: el acceso se serializa con una cola para que
  // dos transacciones no se entrelacen sobre la misma conexión.
  let cola: Promise<unknown> = Promise.resolve();

  return {
    nombre: ruta ? `pglite(${ruta})` : 'pglite(memoria)',
    async tomar() {
      let liberar!: () => void;
      const miTurno = new Promise<void>((r) => { liberar = r; });
      const anterior = cola;
      cola = cola.then(() => miTurno);
      await anterior;

      return {
        async consulta(sql, params) {
          const r = await db.query(sql, params);
          return { filas: (r.rows ?? []) as Fila[], afectadas: r.affectedRows ?? 0 };
        },
        script: (sql) => db.exec(sql).then(() => undefined),
        liberar,
      };
    },
    cerrar: () => db.close(),
  };
}

// ============================================================
// Apertura
// ============================================================

/**
 * Elige el motor. Con `DATABASE_URL` usa Postgres real; si no,
 * levanta PGlite — así `npm start` funciona recién clonado el
 * repositorio y `npm test` no necesita nada instalado.
 */
export async function abrirDB(
  opciones: { url?: string; memoria?: boolean; sinMigrar?: boolean } = {},
): Promise<void> {
  const url = opciones.url ?? process.env.DATABASE_URL;
  motor = url
    ? await motorPostgres(url)
    : await motorPGlite(opciones.memoria ? undefined : (process.env.FERIA_DB ?? join(aqui, '../../datos')));

  if (!opciones.sinMigrar) await migrar();
}

/**
 * Aplica el esquema y las migraciones pendientes.
 *
 * `esquema.sql` describe la base como tiene que quedar y es
 * idempotente, así que crea lo que falte en una base nueva. Pero
 * `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya existe: una
 * base que ya está andando nunca se entera de una columna nueva.
 *
 * Para eso están las migraciones numeradas de `migraciones/`. Cada
 * una corre una sola vez, en orden, y queda anotada. El día que una
 * falle, el arranque se detiene: una base a medio migrar sirviendo
 * pedidos es peor que un servidor que no levanta.
 */
export async function migrar(): Promise<void> {
  const c = await motor.tomar();
  try {
    await c.script(readFileSync(join(aqui, 'esquema.sql'), 'utf8'));
    await c.script(`CREATE TABLE IF NOT EXISTS migraciones (
      nombre     text PRIMARY KEY,
      aplicada_at timestamptz NOT NULL DEFAULT now()
    )`);

    const carpeta = join(aqui, 'migraciones');
    const archivos = existsSync(carpeta)
      ? readdirSync(carpeta).filter((f) => f.endsWith('.sql')).sort()
      : [];

    const hechas = new Set(
      (await c.consulta('SELECT nombre FROM migraciones', [])).filas.map((f: any) => f.nombre));

    for (const archivo of archivos) {
      if (hechas.has(archivo)) continue;
      await c.script(readFileSync(join(carpeta, archivo), 'utf8'));
      await c.consulta('INSERT INTO migraciones (nombre) VALUES ($1)', [archivo]);
      console.log(`[migración] ${archivo}`);
    }
    if (motor.nombre === 'postgres') await cerrarAccesoDirecto(c);
  } finally {
    c.liberar();
  }
}

/**
 * Deja las tablas accesibles solo para el backend.
 *
 * Las bases administradas tipo Supabase publican cada tabla del
 * esquema `public` en una API propia, a la que se entra con una
 * llave que ellos mismos consideran pública. Sin esto, quien tenga
 * la dirección del proyecto y esa llave podría leer clientes,
 * pedidos y sesiones sin pasar por el backend.
 *
 * Con la seguridad por fila activada y ninguna política definida,
 * esos accesos externos no ven ni una fila. El backend no se
 * entera: entra como dueño de las tablas, y al dueño no le aplica.
 * Se repite en cada arranque para cubrir las tablas que agregue
 * una migración nueva.
 */
async function cerrarAccesoDirecto(c: Cliente): Promise<void> {
  await c.script(`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
      END LOOP;
    END $$;`);
}

export const nombreMotor = (): string => motor?.nombre ?? '(sin abrir)';
export const cerrarDB = (): Promise<void> => motor.cerrar();

// ============================================================
// Consultas
// ============================================================

/**
 * Traduce los `?` posicionales a `$1, $2…` de Postgres.
 *
 * Ignora los signos de pregunta que estén dentro de un literal de
 * texto, que si no romperían cualquier consulta con un `'¿?'`.
 */
export function aPostgres(sql: string): string {
  let salida = '';
  let n = 0;
  let enTexto = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      enTexto = !enTexto;
      salida += ch;
    } else if (ch === '?' && !enTexto) {
      salida += '$' + ++n;
    } else {
      salida += ch;
    }
  }
  return salida;
}

async function correr(sql: string, params: any[]): Promise<Resultado> {
  const abierta = enCurso.getStore();
  if (abierta) return abierta.cliente.consulta(aPostgres(sql), params);

  const c = await motor.tomar();
  try {
    return await c.consulta(aPostgres(sql), params);
  } finally {
    c.liberar();
  }
}

export async function consultar<T = Fila>(sql: string, ...params: any[]): Promise<T[]> {
  return (await correr(sql, params)).filas as T[];
}

export async function consultarUno<T = Fila>(sql: string, ...params: any[]): Promise<T | undefined> {
  return (await correr(sql, params)).filas[0] as T | undefined;
}

export async function ejecutar(sql: string, ...params: any[]): Promise<{ afectadas: number }> {
  const r = await correr(sql, params);
  return { afectadas: r.afectadas };
}

/**
 * Transacción.
 *
 * Si ya hay una abierta, la función se ejecuta dentro de ella en
 * vez de abrir otra: varias operaciones del dominio se llaman entre
 * sí y todas quieren ser atómicas, pero el punto de confirmación
 * tiene que ser uno solo, el de más afuera.
 */
export async function enTransaccion<T>(fn: () => Promise<T>): Promise<T> {
  const abierta = enCurso.getStore();
  if (abierta) return fn();

  const c = await motor.tomar();
  const tx: Transaccion = { cliente: c, pendientes: [] };
  try {
    await c.consulta('BEGIN', []);
    const r = await enCurso.run(tx, fn);
    await c.consulta('COMMIT', []);

    // Recién acá los datos son visibles para las demás conexiones.
    for (const efecto of tx.pendientes) {
      try {
        efecto();
      } catch (e) {
        console.error('[alConfirmar]', e);
      }
    }
    return r;
  } catch (e) {
    try {
      await c.consulta('ROLLBACK', []);
    } catch {
      // Si el ROLLBACK falla la conexión ya está perdida; importa
      // el error original, no este.
    }
    // Los pendientes se descartan: la transacción no ocurrió.
    throw e;
  } finally {
    c.liberar();
  }
}

export const id = (): string => randomUUID();
export const ahora = (): Date => new Date();

export async function registrarEvento(
  entidad: string,
  entidadId: string,
  tipo: string,
  detalle?: unknown,
): Promise<void> {
  await ejecutar(
    'INSERT INTO eventos (entidad, entidad_id, tipo, detalle) VALUES (?, ?, ?, ?)',
    entidad,
    entidadId,
    tipo,
    detalle === undefined ? null : JSON.stringify(detalle),
  );
}
