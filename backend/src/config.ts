import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parámetros del motor de despacho.
 *
 * Estos números son el producto. Cambiarlos cambia la experiencia
 * más que cualquier pantalla: una ventana corta frustra al feriante,
 * una larga deja al cliente esperando. Ajústalos con datos reales
 * de la tabla `ofertas`, no por intuición.
 */
function normalizarUrl(valor: string | undefined): string | undefined {
  const v = valor?.trim().replace(/\/+$/, '');
  if (!v) return undefined;
  return /^https?:\/\//.test(v) ? v : `https://${v}`;
}

export const CONFIG = {
  /**
   * Cascada de rondas. Si nadie acepta en una ronda, se pasa a la
   * siguiente, ampliando el público. Agotadas todas → AUTOGESTION.
   */
  rondas: [
    {
      numero: 1,
      /** Solo feriantes del rubro, conectados, mejor reputación. */
      alcance: 'RUBRO_TOP' as const,
      limite: 5,
      ventanaSegundos: 90,
    },
    {
      numero: 2,
      /** Todos los feriantes del rubro que estén conectados. */
      alcance: 'RUBRO_TODOS' as const,
      limite: 50,
      ventanaSegundos: 60,
    },
    {
      numero: 3,
      /** Toda la feria: alguien puede conseguirlo en otro puesto. */
      alcance: 'FERIA_COMPLETA' as const,
      limite: 200,
      ventanaSegundos: 60,
    },
  ],

  /** Tarifa base del repartidor, CLP. Es lo que TE CUESTA el reparto. */
  tarifaReparto: 2500,
  /** Extra por cada puesto adicional de retiro. */
  tarifaPorParadaExtra: 500,

  /**
   * Lo que le cobras al cliente por el despacho.
   *
   * Es plata aparte de la tarifa del repartidor: una es ingreso y la
   * otra es costo, y no tienen por qué coincidir. Un pedido de tres
   * rubros te cuesta $3.500 de reparto, así que con despacho plano
   * los pedidos de un solo puesto subsidian a los de varios.
   */
  despacho: {
    costo: 2500,
    /**
     * Sobre este monto el despacho va gratis. Es la palanca más
     * directa para subir el ticket promedio: al cliente le conviene
     * agregar $4.000 de verdura antes que pagar $2.500 de envío.
     */
    gratisDesde: 25_000,
    /**
     * Debajo de esto no se acepta el pedido. Un carro de $3.000 no
     * paga el viaje del repartidor ni con despacho cobrado.
     */
    pedidoMinimo: 8_000,
  },

  /** Cada cuánto el motor revisa ofertas vencidas, en ms. */
  intervaloTickMs: 1000,

  /**
   * Zona de la feria. Define qué cuenta como "hoy" para las
   * liquidaciones: un retiro a las 21:00 en Valparaíso ya es el día
   * siguiente en UTC.
   */
  zonaHoraria: process.env.TZ_FERIA ?? 'America/Santiago',

  /**
   * Lo que se llevan las comisiones de cada venta.
   *
   * El valor por defecto es Mercado Pago Checkout Pro con el dinero
   * al instante: 3,19% + IVA. A 10 días baja a 3,44%.
   *
   * No es un detalle contable: de acá sale el «te queda» del panel,
   * y con un margen de $2.500 por pedido cada punto se nota. Ponlo
   * con lo que de verdad estés pagando.
   */
  comisiones: Number(process.env.TASA_COMISIONES ?? 0.038),

  /**
   * Días y horas de la feria.
   *
   * `ultimoPedido` es antes del cierre a propósito: entre que se
   * oferta, un feriante prepara, el repartidor recorre los puestos y
   * llega al domicilio pasa más de una hora. Un pedido aceptado a
   * las 14:55 no alcanza a salir.
   */
  horario: {
    /** 0 = domingo. La Av. Argentina es miércoles y sábado. */
    dias: [3, 6],
    abre: '07:00',
    ultimoPedido: '13:30',
    cierra: '15:00',
  },

  /**
   * Cuántos minutos se le guarda el pedido a alguien que abrió el
   * checkout y no volvió. Pasado eso, expira.
   */
  minutosParaPagar: 20,

  /** Parámetros de la autenticación por SMS. */
  auth: {
    vidaCodigoSegundos: 300,
    /** Intentos por código antes de que muera. Seis dígitos se
     *  agotan rápido si no hay tope. */
    maxIntentos: 5,
    /** Freno de abuso por teléfono: cada SMS cuesta y molesta. */
    maxEnviosPorVentana: 3,
    ventanaEnvioSegundos: 900,
    /** Sesión larga: al feriante no se le puede pedir que entre
     *  de nuevo cada semana. */
    vidaSesionDias: 90,
  },

  /** A dónde llama el cliente que necesita cambiar o cancelar un pedido. */
  telefonoContacto: process.env.TELEFONO_CONTACTO ?? '+56 9 0000 0009',

  /**
   * La dirección pública del servidor, siempre con esquema.
   *
   * Render entrega el host pelado («feria.onrender.com») y Mercado
   * Pago necesita la URL completa. Sin normalizar esto, el webhook
   * queda apuntando a una dirección inválida y los pagos no se
   * confirman solos — un error que solo aparece en producción.
   */
  urlPublica: normalizarUrl(process.env.URL_PUBLICA),

  /** Dónde buscar las direcciones que escribe el cliente. */
  ciudad: process.env.CIUDAD ?? 'Valparaíso, Chile',
  pais: process.env.PAIS_ISO ?? 'cl',
  /** Punto de la feria: a donde cae un pedido que no se pudo ubicar. */
  puntoFeria: {
    lat: Number(process.env.FERIA_LAT ?? -33.0472),
    lng: Number(process.env.FERIA_LNG ?? -71.6127),
  },

  puerto: Number(process.env.PORT ?? 4000),

  /**
   * Dónde viven la base y las fotos de producto.
   *
   * Las dos cosas en la misma carpeta a propósito: un respaldo que
   * se lleve la base pero no las fotos deja un catálogo con huecos,
   * y es el error que se descubre el día que hace falta restaurar.
   */
  carpetaDatos: process.env.FERIA_DATOS
    ?? join(dirname(fileURLToPath(import.meta.url)), '../datos'),
} as const;

export type Alcance = (typeof CONFIG.rondas)[number]['alcance'];
