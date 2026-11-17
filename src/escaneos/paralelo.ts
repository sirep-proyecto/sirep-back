/**
 * Responsabilidad: ejecutar una tarea por elemento con un máximo de N a la vez,
 * devolviendo los resultados en el MISMO orden de entrada.
 * Existe para leer las páginas de un PDF en paralelo sin saturar al proveedor de IA
 * ni la memoria del servidor. Si una tarea falla, se rechaza con ese error y no se
 * empiezan tareas nuevas (las que ya estaban en curso terminan solas).
 */

/** Páginas que se leen a la vez (env `IA_PAGINAS_EN_PARALELO`, 3 por defecto, entre 1 y 10). */
export function paginasEnParalelo(): number {
  const n = Number(process.env.IA_PAGINAS_EN_PARALELO);
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 3;
}

export async function enParalelo<T, R>(
  elementos: readonly T[],
  limite: number,
  tarea: (elemento: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(elementos.length);
  let siguiente = 0;
  let fallo = false;
  const trabajador = async () => {
    while (!fallo && siguiente < elementos.length) {
      const indice = siguiente++;
      try {
        resultados[indice] = await tarea(elementos[indice], indice);
      } catch (err) {
        fallo = true;
        throw err;
      }
    }
  };
  const trabajadores = Array.from({ length: Math.max(1, Math.min(limite, elementos.length)) }, trabajador);
  await Promise.all(trabajadores);
  return resultados;
}
