import { FILAS_POR_PAGINA, leerPaginado } from './leer-paginado';

/** Simula una tabla que, como Supabase, nunca devuelve más de FILAS_POR_PAGINA filas por consulta. */
function tablaFalsa(total: number, fallarEnPagina?: number) {
  const filas = Array.from({ length: total }, (_, i) => ({ id: i }));
  const pedidos: Array<[number, number]> = [];
  const crearConsulta = () => ({
    range: (desde: number, hasta: number) => {
      pedidos.push([desde, hasta]);
      if (fallarEnPagina !== undefined && pedidos.length === fallarEnPagina) {
        return Promise.resolve({ data: null, error: { message: 'caído' } });
      }
      const hastaReal = Math.min(hasta, desde + FILAS_POR_PAGINA - 1);
      return Promise.resolve({ data: filas.slice(desde, hastaReal + 1), error: null });
    },
  });
  return { crearConsulta, pedidos };
}

describe('leerPaginado', () => {
  it('lee más de 1000 filas pidiendo varias páginas', async () => {
    const { crearConsulta, pedidos } = tablaFalsa(2350);
    const { data, error } = await leerPaginado(crearConsulta);
    expect(error).toBeNull();
    expect(data).toHaveLength(2350);
    expect(data[2349]).toEqual({ id: 2349 });
    expect(pedidos).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('con exactamente 1000 filas pide una página más y termina', async () => {
    const { crearConsulta, pedidos } = tablaFalsa(1000);
    const { data } = await leerPaginado(crearConsulta);
    expect(data).toHaveLength(1000);
    expect(pedidos).toHaveLength(2);
  });

  it('respeta el máximo pedido', async () => {
    const { crearConsulta, pedidos } = tablaFalsa(5000);
    const { data } = await leerPaginado(crearConsulta, 1500);
    expect(data).toHaveLength(1500);
    expect(pedidos).toEqual([
      [0, 999],
      [1000, 1499],
    ]);
  });

  it('devuelve el error si una página falla', async () => {
    const { crearConsulta } = tablaFalsa(3000, 2);
    const { data, error } = await leerPaginado(crearConsulta);
    expect(error).toEqual({ message: 'caído' });
    expect(data).toEqual([]);
  });
});
