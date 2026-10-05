/**
 * Máquinas de estado del sistema.
 *
 * Regla de oro: ningún estado cambia sin pasar por `transicionar()`,
 * que valida la transición y registra el evento. Un despacho que
 * falla a las 9 AM de un sábado se depura leyendo la tabla `eventos`.
 */

export const EstadoPedido = {
  /**
   * Creado, esperando que el cliente pague.
   *
   * NADA se despacha en este estado. Sin él, ocho feriantes podían
   * ponerse a preparar mercadería de un pedido que nadie pagó.
   */
  PENDIENTE_PAGO: 'PENDIENTE_PAGO',
  /** La pasarela confirmó el pago. Todavía no se ofreció a nadie. */
  PAGADO: 'PAGADO',
  /** Hay sub-pedidos en ronda de ofertas. */
  DESPACHANDO: 'DESPACHANDO',
  /** Todos los sub-pedidos tienen dueño (feriante o el operador). */
  EN_PREPARACION: 'EN_PREPARACION',
  /** Todo listo en los puestos, esperando/con repartidor. */
  LISTO_PARA_RETIRO: 'LISTO_PARA_RETIRO',
  /** El repartidor retiró todo y va camino al cliente. */
  EN_RUTA: 'EN_RUTA',
  ENTREGADO: 'ENTREGADO',
  /** El cliente abandonó el checkout y se venció la reserva. */
  EXPIRADO: 'EXPIRADO',
  CANCELADO: 'CANCELADO',
} as const;
export type EstadoPedido = (typeof EstadoPedido)[keyof typeof EstadoPedido];

export const EstadoSubPedido = {
  PENDIENTE: 'PENDIENTE',
  /** Broadcast activo, esperando que algún feriante lo tome. */
  OFERTANDO: 'OFERTANDO',
  ACEPTADO: 'ACEPTADO',
  /**
   * Nadie aceptó tras agotar las rondas. Cae al operador, que lo
   * compra personalmente. Esto NO es un error: es el fallback que
   * garantiza que ningún cliente se quede sin pedido.
   */
  AUTOGESTION: 'AUTOGESTION',
  /** Preparado en el puesto (o comprado por el operador). */
  LISTO: 'LISTO',
  RETIRADO: 'RETIRADO',
  CANCELADO: 'CANCELADO',
} as const;
export type EstadoSubPedido = (typeof EstadoSubPedido)[keyof typeof EstadoSubPedido];

export const EstadoViaje = {
  /** Creado, buscando repartidor. */
  BUSCANDO: 'BUSCANDO',
  ASIGNADO: 'ASIGNADO',
  /** El repartidor está recorriendo los puestos. */
  RETIRANDO: 'RETIRANDO',
  /** Retiró todo, va al domicilio. */
  EN_RUTA: 'EN_RUTA',
  ENTREGADO: 'ENTREGADO',
  CANCELADO: 'CANCELADO',
} as const;
export type EstadoViaje = (typeof EstadoViaje)[keyof typeof EstadoViaje];

type Transiciones<T extends string> = Record<T, readonly T[]>;

export const TRANSICIONES_PEDIDO: Transiciones<EstadoPedido> = {
  PENDIENTE_PAGO: ['PAGADO', 'EXPIRADO', 'CANCELADO'],
  PAGADO: ['DESPACHANDO', 'CANCELADO'],
  DESPACHANDO: ['EN_PREPARACION', 'CANCELADO'],
  EN_PREPARACION: ['LISTO_PARA_RETIRO', 'CANCELADO'],
  LISTO_PARA_RETIRO: ['EN_RUTA', 'CANCELADO'],
  EN_RUTA: ['ENTREGADO', 'CANCELADO'],
  ENTREGADO: [],
  // Un cobro que estaba abierto y se pagó tarde revive el pedido.
  EXPIRADO: ['PAGADO'],
  CANCELADO: [],
};

export const TRANSICIONES_SUB_PEDIDO: Transiciones<EstadoSubPedido> = {
  PENDIENTE: ['OFERTANDO', 'AUTOGESTION', 'CANCELADO'],
  // Vuelve a OFERTANDO en cada ronda nueva de la cascada.
  OFERTANDO: ['OFERTANDO', 'ACEPTADO', 'AUTOGESTION', 'CANCELADO'],
  // Un feriante puede arrepentirse ("acepté pero no tengo"): el
  // sub-pedido vuelve a ofertarse y se le cuenta un incumplimiento.
  ACEPTADO: ['LISTO', 'OFERTANDO', 'AUTOGESTION', 'CANCELADO'],
  AUTOGESTION: ['LISTO', 'CANCELADO'],
  LISTO: ['RETIRADO', 'CANCELADO'],
  RETIRADO: [],
  CANCELADO: [],
};

export const TRANSICIONES_VIAJE: Transiciones<EstadoViaje> = {
  BUSCANDO: ['ASIGNADO', 'CANCELADO'],
  ASIGNADO: ['RETIRANDO', 'BUSCANDO', 'CANCELADO'],
  RETIRANDO: ['EN_RUTA', 'CANCELADO'],
  EN_RUTA: ['ENTREGADO', 'CANCELADO'],
  ENTREGADO: [],
  CANCELADO: [],
};

/**
 * Un error que es culpa de lo que se pidió, no del servidor.
 *
 * Lleva su código HTTP. Antes estas situaciones —un producto que no
 * existe, una parada inventada— lanzaban un `Error` pelado y salían
 * como 500: el registro se llenaba de «errores internos» que eran
 * solo peticiones mal hechas, y los de verdad se perdían entre ellos.
 */
export class ErrorNegocio extends Error {
  codigo: number;
  constructor(codigo: number, msg: string) {
    super(msg);
    this.codigo = codigo;
    this.name = 'ErrorNegocio';
  }
}

export class TransicionInvalida extends Error {
  constructor(entidad: string, desde: string, hacia: string) {
    super(`Transición inválida en ${entidad}: ${desde} → ${hacia}`);
    this.name = 'TransicionInvalida';
  }
}

export function validarTransicion<T extends string>(
  entidad: string,
  tabla: Transiciones<T>,
  desde: T,
  hacia: T,
): void {
  const permitidas = tabla[desde];
  if (!permitidas || !permitidas.includes(hacia)) {
    throw new TransicionInvalida(entidad, desde, hacia);
  }
}
