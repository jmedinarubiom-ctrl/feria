import { consultar, ejecutar } from '../src/db/index.ts';
import { sembrar } from '../src/db/semilla.ts';
import { crearPedido, confirmarPago, type PedidoEntrante } from '../src/dominio/despacho.ts';
import { fijarHorario } from '../src/dominio/horario.ts';
import type {
  DatosCobro, DatosReembolso, EstadoCobro, Pasarela,
} from '../src/pagos/pasarela.ts';

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


/**
 * Una pasarela de mentira.
 *
 * Los tests del cobro, la cancelación y el reembolso prueban lo que
 * hace el dominio con CUALQUIER pasarela, no los detalles de una.
 * Guarda lo que se le pidió y contesta lo que el test le diga. Los
 * detalles de Mercado Pago tienen su propio archivo.
 */
export function pasarelaDeMentira() {
  const p = {
    nombre: 'mentira',
    creados: [] as DatosCobro[],
    reembolsos: [] as DatosReembolso[],
    /** Lo que va a contestar `consultar`. */
    estado: null as Partial<EstadoCobro> | null,
    /** Con esto, pedir un reembolso falla como si no respondiera. */
    caida: false,

    async crear(datos: DatosCobro) {
      p.creados.push(datos);
      const referencia = `tok-${datos.ordenComercio}`;
      return { url: `https://pasarela.test/pagar?token=${referencia}`, referencia };
    },
    async consultar(referencia: string): Promise<EstadoCobro> {
      if (!p.estado) throw new Error('la pasarela no conoce ese cobro');
      return {
        pagado: false, cerrado: false, medio: null, ordenComercio: '',
        monto: 0, referencia, crudo: {}, ...p.estado,
      };
    },
    async reembolsar(datos: DatosReembolso) {
      if (p.caida) throw new Error('la pasarela no responde');
      p.reembolsos.push(datos);
      return { referencia: 'rf-1', aceptado: true };
    },
  } satisfies Pasarela & Record<string, unknown>;
  return p;
}

/**
 * Completa una parada como lo haría el repartidor con el cliente al
 * frente: en la entrega dicta el código del pedido. Los tests del
 * despacho no tratan del código, así que lo buscan solos.
 */
export async function completarParada(paradaId: string, repartidorId: string): Promise<void> {
  const { consultarUno } = await import('../src/db/index.ts');
  const { completarParada: deVerdad } = await import('../src/dominio/reparto.ts');
  const p = await consultarUno<any>(
    `SELECT pe.codigo_entrega FROM paradas pa JOIN viajes v ON v.id = pa.viaje_id
       JOIN pedidos pe ON pe.id = v.pedido_id WHERE pa.id = ?`, paradaId);
  return deVerdad(paradaId, repartidorId, { codigo: p?.codigo_entrega });
}
