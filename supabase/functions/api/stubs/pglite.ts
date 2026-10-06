// La función siempre habla con Postgres: PGlite no viaja en el paquete.
export class PGlite {
  constructor() { throw new Error('Falta DATABASE_URL: la función no trae base local.'); }
}
