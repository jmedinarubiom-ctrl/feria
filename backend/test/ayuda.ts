import { consultar, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import { crearPedido, confirmarPago, type PedidoEntrante } from '../src/dominio/despacho.ts';
import { fijarHorario } from '../src/dominio/horario.ts';

// La feria de prueba abre todos los días de corrido. Así la
// verificación de horario sigue ejecutándose en cada test —no se
// apaga— pero no hace fallar todo según la hora en que se corran.
fijarHorario({ dias: [0, 1, 2, 3, 4, 5, 6], abre: '00:00', ultimoPedido: '23:59', cierra: '23:59' });

/**
 * Deja la base como recién sembrada.
 *
 * La lista de tablas se lee del catálogo de Postgres en vez de
 * escribirse a mano: una tabla nueva que no estuviera en la lista
 * sobreviviría entre tests y los haría fallar por contaminación,
 * que es un rato perdido buscando el error donde no está.
 */
export async function limpiarYSembrar(): Promise<void> {
  const tablas = await consultar<{ nombre: string }>(
    `SELECT tablename AS nombre FROM pg_tables WHERE schemaname = 'public'`);
  if (tablas.length > 0) {
    await ejecutar(
      `TRUNCATE ${tablas.map((t) => `"${t.nombre}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
  await sembrar();
}


/**
 * Crea un pedido y lo da por pagado.
 *
 * Casi todos los tests parten de un pedido que ya se cobró: lo que
 * les interesa es el despacho, no el checkout. Los tests del cobro
 * en sí llaman a `crearPedido` directamente.
 */
export async function pedidoPagado(entrada: PedidoEntrante) {
  const r = await crearPedido(entrada);
  await confirmarPago(r.pedidoId);
  return r;
}
