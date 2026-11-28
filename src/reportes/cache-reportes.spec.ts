import { CacheReportes } from './cache-reportes';

const EMPRESA = 'emp-1';

interface Fila {
  id: string;
  empresa_id: string;
  creado_en: string;
  actualizado_en: string;
  escaneo_id?: string | null;
  [k: string]: unknown;
}

/** Base de datos falsa que entiende las consultas que usa la caché y cuenta las filas que devuelve. */
function crearBase(reportes: Fila[], escaneos: Fila[]) {
  const stats = { consultas: 0, filasDevueltas: 0, conteos: 0 };
  const tablas: Record<string, Fila[]> = { reportes, escaneos };

  const from = (tabla: string) => {
    const filtros: Array<(f: Fila) => boolean> = [];
    let soloConteo = false;
    let orden: { col: string; asc: boolean } | null = null;
    let corte: [number, number] | null = null;
    const ejecutar = () => {
      stats.consultas++;
      let filas = tablas[tabla].filter((f) => filtros.every((ok) => ok(f)));
      if (soloConteo) {
        stats.conteos++;
        return { data: null, count: filas.length, error: null };
      }
      if (orden) {
        const { col, asc } = orden;
        filas = [...filas].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (corte) filas = filas.slice(corte[0], corte[1] + 1);
      const data = filas.map((f) =>
        tabla === 'reportes' ? { ...f, escaneo: escaneos.find((e) => e.id === f.escaneo_id) ?? null } : { ...f },
      );
      stats.filasDevueltas += data.length;
      return { data, error: null };
    };
    const q: any = {
      select: (_cols: string, opts?: { head?: boolean }) => {
        soloConteo = Boolean(opts?.head);
        return q;
      },
      eq: (col: string, v: unknown) => (filtros.push((f) => f[col] === v), q),
      gte: (col: string, v: string) => (filtros.push((f) => String(f[col]) >= v), q),
      in: (col: string, vs: unknown[]) => (filtros.push((f) => vs.includes(f[col])), q),
      order: (col: string, o: { ascending: boolean }) => ((orden ??= { col, asc: o.ascending }), q),
      limit: (n: number) => ((corte = [0, n - 1]), q),
      range: (a: number, b: number) => ((corte = [a, b]), q),
      then: (res: any, rej: any) => Promise.resolve(ejecutar()).then(res, rej),
    };
    return q;
  };
  const supabase: any = { getClient: () => ({ from }) };
  return { supabase, stats };
}

const fecha = (min: number) => new Date(Date.UTC(2026, 10, 25, 12, min)).toISOString();

function reporte(n: number, extra: Partial<Fila> = {}): Fila {
  return {
    id: `r${String(n).padStart(4, '0')}`,
    empresa_id: EMPRESA,
    creado_en: fecha(n),
    actualizado_en: fecha(n),
    escaneo_id: `e${n}`,
    estado: 'pendiente',
    ...extra,
  };
}

function escaneo(n: number, extra: Partial<Fila> = {}): Fila {
  return { id: `e${n}`, empresa_id: EMPRESA, creado_en: fecha(n), actualizado_en: fecha(n), estado: 'procesado', ...extra };
}

describe('CacheReportes', () => {
  let reportes: Fila[];
  let escaneos: Fila[];
  let reloj: number;

  beforeEach(() => {
    reportes = Array.from({ length: 1200 }, (_, i) => reporte(i));
    escaneos = Array.from({ length: 1200 }, (_, i) => escaneo(i));
    reloj = Date.UTC(2026, 10, 26);
  });

  const crear = () => {
    const base = crearBase(reportes, escaneos);
    return { cache: new CacheReportes(base.supabase, EMPRESA, () => reloj), stats: base.stats };
  };

  it('la primera lectura trae todos los reportes (más de 1000), del más nuevo al más antiguo', async () => {
    const { cache } = crear();
    const lista = await cache.listar();
    expect(lista).toHaveLength(1200);
    expect(lista[0].id).toBe('r1199');
    expect(lista[1199].id).toBe('r0000');
  });

  it('las lecturas siguientes sin cambios casi no traen filas', async () => {
    const { cache, stats } = crear();
    await cache.listar();
    const antes = stats.filasDevueltas;
    const lista = await cache.listar();
    expect(lista).toHaveLength(1200);
    // Solo vuelve a traer lo que cae dentro del margen de 1 minuto, no los 1200.
    expect(stats.filasDevueltas - antes).toBeLessThan(10);
  });

  it('ve un reporte editado y uno nuevo sin recargar todo', async () => {
    const { cache, stats } = crear();
    await cache.listar();
    reportes[5] = { ...reportes[5], estado: 'revisado', actualizado_en: fecha(5000) };
    reportes.push(reporte(1200, { creado_en: fecha(5001), actualizado_en: fecha(5001) }));
    escaneos.push(escaneo(1200));
    const antes = stats.filasDevueltas;

    const lista = await cache.listar();
    expect(lista).toHaveLength(1201);
    expect(lista[0].id).toBe('r1200');
    expect((lista.find((f) => f.id === 'r0005') as any).estado).toBe('revisado');
    expect(stats.filasDevueltas - antes).toBeLessThan(20);
  });

  it('ve un cambio que solo tocó el escaneo', async () => {
    const { cache } = crear();
    await cache.listar();
    escaneos[7] = { ...escaneos[7], estado: 'error', actualizado_en: fecha(6000) };
    const lista = await cache.listar();
    expect((lista.find((f) => f.id === 'r0007') as any).escaneo.estado).toBe('error');
  });

  it('si se borró un reporte, el conteo no cuadra y recarga todo', async () => {
    const { cache } = crear();
    await cache.listar();
    reportes.splice(3, 1);
    const lista = await cache.listar();
    expect(lista).toHaveLength(1199);
    expect(lista.some((f) => f.id === 'r0003')).toBe(false);
  });

  it('pasados 10 minutos recarga todo', async () => {
    const { cache, stats } = crear();
    await cache.listar();
    reloj += 10 * 60 * 1000;
    const antes = stats.filasDevueltas;
    await cache.listar();
    expect(stats.filasDevueltas - antes).toBeGreaterThanOrEqual(1200);
  });

  it('varias peticiones a la vez comparten la misma lectura', async () => {
    const { cache, stats } = crear();
    await cache.listar();
    const antes = stats.consultas;
    await Promise.all([cache.listar(), cache.listar(), cache.listar(), cache.listar(), cache.listar()]);
    // Una actualización en curso + como mucho una encadenada, no cinco.
    const porActualizacion = 4; // cambios en reportes, cambios en escaneos, sus reportes y conteo
    expect(stats.consultas - antes).toBeLessThanOrEqual(2 * porActualizacion);
  });
});
