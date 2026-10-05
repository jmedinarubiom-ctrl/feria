/**
 * Lo único que el dominio necesita de una pasarela de pago.
 *
 * Hoy la única es Mercado Pago. La interfaz se mantiene para que la
 * lógica de negocio no sepa cómo numera los estados un proveedor,
 * y para que los tests puedan cobrar con una pasarela de mentira.
 *
 * Tres operaciones: crear el cobro, preguntar cómo terminó, y
 * devolver la plata. Todo lo demás es asunto de cada cliente.
 */

export type DatosCobro = {
  /** Nuestro identificador, único para siempre. Evita el doble cobro. */
  ordenComercio: string;
  monto: number;
  concepto: string;
  email: string;
};

export type CobroCreado = {
  /** Adónde mandar al cliente a pagar. */
  url: string;
  /** Cómo llama la pasarela a este cobro. Se guarda para consultarlo después. */
  referencia: string;
};

export type EstadoCobro = {
  pagado: boolean;
  /** El cliente no pagó y no va a pagar: tarjeta rechazada, anulado. */
  cerrado: boolean;
  /** 'tarjeta', 'transferencia', 'khipu'… tal como lo llama la pasarela. */
  medio: string | null;
  /** Nuestro identificador, para encontrar el pago en la base. */
  ordenComercio: string;
  monto: number;
  /**
   * El identificador definitivo del pago.
   *
   * No siempre es el mismo con el que se creó: Mercado Pago crea una
   * «preferencia» y después genera un «payment» con otro id, y el
   * reembolso va contra ese segundo. Se guarda al confirmar.
   */
  referencia: string;
  /** Lo que dijo la pasarela, para la bitácora. */
  crudo: unknown;
};

export type DatosReembolso = {
  ordenReembolso: string;
  /** El identificador del pago en la pasarela. */
  referenciaPago: string;
  ordenComercioOriginal: string;
  emailCliente: string;
  monto: number;
};

export type ReembolsoCreado = {
  referencia: string;
  /** La pasarela lo aceptó. La plata puede tardar días en llegar. */
  aceptado: boolean;
};

export interface Pasarela {
  /** Va en la columna `proveedor` de la tabla `pagos`. */
  readonly nombre: string;
  crear(datos: DatosCobro): Promise<CobroCreado>;
  /**
   * Pregunta cómo terminó el cobro.
   *
   * `referencia` es lo que avisó el webhook. Se consulta SIEMPRE,
   * incluso cuando el aviso dice que salió bien: el aviso llega por
   * HTTP desde fuera y cualquiera puede inventarlo. Lo único que
   * vale es la respuesta de la pasarela a una petición nuestra.
   */
  consultar(referencia: string): Promise<EstadoCobro>;
  reembolsar(datos: DatosReembolso): Promise<ReembolsoCreado>;
}
