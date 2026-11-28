/**
 * Supabase (PostgREST) devuelve como máximo `max_rows` filas por consulta (1000 por defecto),
 * aunque se pida `.limit(2000)`. Para leer más hay que pedir páginas con `.range()`.
 */
export const FILAS_POR_PAGINA = 1000;

/** Lo mínimo que se usa de un query builder de Supabase. */
interface ConsultaPaginable {
  range(desde: number, hasta: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

/**
 * Lee todas las filas de una consulta, página a página, hasta `maximo` filas.
 * `crearConsulta` debe devolver una consulta nueva en cada llamada (con su orden ya aplicado,
 * para que las páginas no se repitan ni salten filas).
 * Si una página falla, devuelve el error y lo leído hasta ahí no se usa.
 */
export async function leerPaginado<T = any>(
  crearConsulta: () => ConsultaPaginable,
  maximo = Number.POSITIVE_INFINITY,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const filas: T[] = [];
  while (filas.length < maximo) {
    const desde = filas.length;
    const tamano = Math.min(FILAS_POR_PAGINA, maximo - desde);
    const { data, error } = await crearConsulta().range(desde, desde + tamano - 1);
    if (error) return { data: [], error };
    const pagina = (Array.isArray(data) ? data : []) as T[];
    filas.push(...pagina);
    if (pagina.length < tamano) break;
  }
  return { data: filas, error: null };
}
