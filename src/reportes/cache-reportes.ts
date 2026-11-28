import { Logger } from '@nestjs/common';
import { leerPaginado } from '../common/leer-paginado';
import { SupabaseService } from '../common/supabase.service';
import type { FilaReporte } from './reportes.mapper';

/** Columnas de la lista de reportes (igual que `SELECCION` en reportes.service). */
export const SELECCION_LISTA =
  '*, escaneo:escaneos(id, ruta_original, paginas, enviado_por, telegram_chat_id, estado, creado_en, metadatos)';

/** Cada cuánto se descarta la copia y se vuelve a leer todo (por si se borró algún reporte). */
const RECARGA_COMPLETA_MS = 10 * 60 * 1000;
/** Margen hacia atrás al pedir cambios, por transacciones que confirman tarde con una hora anterior. */
const MARGEN_CAMBIOS_MS = 60 * 1000;
/** Cuántos ids caben en un filtro `in` sin que la URL sea demasiado larga. */
const IDS_POR_CONSULTA = 100;

type FilaConFecha = FilaReporte & { actualizado_en?: string | null; escaneo_id?: string | null };

/**
 * Copia en memoria de la lista de reportes de una empresa.
 *
 * Antes, cada vez que una bandeja se refrescaba (después de cada revisión o subida, en todos los
 * navegadores abiertos), el back volvía a descargar de Supabase todos los reportes completos.
 * Eso fue casi todo el tráfico de salida (egress) del proyecto.
 *
 * Ahora la primera lectura trae todo y las siguientes solo lo que cambió desde la última
 * (`actualizado_en` de `reportes` y de `escaneos`, que mantienen sus triggers). Un conteo detecta
 * reportes borrados, y cada 10 minutos se recarga todo de nuevo.
 *
 * Se registra en ReportesModule con una fábrica (necesita el id de empresa).
 */
export class CacheReportes {
  private readonly logger = new Logger(CacheReportes.name);
  private filas = new Map<string, FilaConFecha>();
  private marcaReportes: number | null = null;
  private marcaEscaneos: number | null = null;
  private cargadoEn = 0;
  private enCurso: Promise<void> | null = null;
  private pendiente: Promise<void> | null = null;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly empresaId: string,
    private readonly ahora: () => number = () => Date.now(),
  ) {}

  private get db(): any {
    return this.supabase.getClient();
  }

  /** Todos los reportes al día, del más nuevo al más antiguo (como la consulta original). */
  async listar(): Promise<FilaReporte[]> {
    await this.refrescar();
    return [...this.filas.values()].sort(ordenarPorCreacionDesc);
  }

  /** Olvida la copia: la próxima lectura vuelve a traer todo. */
  invalidar(): void {
    this.filas = new Map();
    this.marcaReportes = null;
    this.marcaEscaneos = null;
    this.cargadoEn = 0;
  }

  /**
   * Si ya hay una actualización en curso, puede haber empezado antes del cambio que el llamador
   * quiere ver. Por eso se encadena (una sola) actualización más, que comparten todos los que esperan.
   */
  private refrescar(): Promise<void> {
    if (!this.enCurso) {
      this.enCurso = this.actualizar().finally(() => {
        this.enCurso = null;
      });
      return this.enCurso;
    }
    if (!this.pendiente) {
      this.pendiente = this.enCurso
        .catch(() => undefined)
        .then(() => {
          this.pendiente = null;
          return this.refrescar();
        });
    }
    return this.pendiente;
  }

  private async actualizar(): Promise<void> {
    const vencida = this.ahora() - this.cargadoEn >= RECARGA_COMPLETA_MS;
    if (this.marcaReportes === null || vencida) {
      await this.cargarTodo();
      return;
    }
    await this.cargarCambios();
    if ((await this.contarReportes()) !== this.filas.size) {
      this.logger.log('La cantidad de reportes no coincide con la copia en memoria; se recarga todo.');
      await this.cargarTodo();
    }
  }

  private async cargarTodo(): Promise<void> {
    const { data, error } = await leerPaginado<FilaConFecha>(() =>
      this.db
        .from('reportes')
        .select(SELECCION_LISTA)
        .eq('empresa_id', this.empresaId)
        .order('creado_en', { ascending: false })
        .order('id', { ascending: true }),
    );
    if (error) throw new Error(error.message);
    const marcaEscaneos = await this.ultimaActualizacionEscaneos();

    this.filas = new Map(data.map((f) => [f.id, f]));
    this.marcaReportes = maximaFecha(data);
    this.marcaEscaneos = marcaEscaneos;
    this.cargadoEn = this.ahora();
  }

  private async cargarCambios(): Promise<void> {
    const desdeReportes = new Date((this.marcaReportes ?? 0) - MARGEN_CAMBIOS_MS).toISOString();
    const desdeEscaneos = new Date((this.marcaEscaneos ?? 0) - MARGEN_CAMBIOS_MS).toISOString();

    const [reportes, escaneos] = await Promise.all([
      leerPaginado<FilaConFecha>(() =>
        this.db
          .from('reportes')
          .select(SELECCION_LISTA)
          .eq('empresa_id', this.empresaId)
          .gte('actualizado_en', desdeReportes)
          .order('id', { ascending: true }),
      ),
      leerPaginado<{ id: string; actualizado_en: string | null }>(() =>
        this.db
          .from('escaneos')
          .select('id, actualizado_en')
          .eq('empresa_id', this.empresaId)
          .gte('actualizado_en', desdeEscaneos)
          .order('id', { ascending: true }),
      ),
    ]);
    if (reportes.error) throw new Error(reportes.error.message);
    if (escaneos.error) throw new Error(escaneos.error.message);

    // Un cambio solo en el escaneo (p. ej. su estado) no toca `reportes.actualizado_en`. Se releen
    // siempre después de las otras lecturas (aunque su reporte ya viniera) para que el escaneo
    // embebido no quede con una versión anterior a este cambio.
    const porEscaneo = await this.leerPorEscaneo(escaneos.data.map((e) => e.id));

    for (const fila of [...reportes.data, ...porEscaneo]) this.filas.set(fila.id, fila);
    this.marcaReportes = Math.max(this.marcaReportes ?? 0, maximaFecha(reportes.data) ?? 0);
    this.marcaEscaneos = Math.max(this.marcaEscaneos ?? 0, maximaFecha(escaneos.data) ?? 0);
  }

  private async leerPorEscaneo(idsEscaneo: string[]): Promise<FilaConFecha[]> {
    const salida: FilaConFecha[] = [];
    for (let i = 0; i < idsEscaneo.length; i += IDS_POR_CONSULTA) {
      const lote = idsEscaneo.slice(i, i + IDS_POR_CONSULTA);
      const { data, error } = await this.db
        .from('reportes')
        .select(SELECCION_LISTA)
        .eq('empresa_id', this.empresaId)
        .in('escaneo_id', lote);
      if (error) throw new Error(error.message);
      salida.push(...((data ?? []) as FilaConFecha[]));
    }
    return salida;
  }

  private async contarReportes(): Promise<number> {
    const { count, error } = await this.db
      .from('reportes')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', this.empresaId);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  private async ultimaActualizacionEscaneos(): Promise<number | null> {
    const { data, error } = await this.db
      .from('escaneos')
      .select('id, actualizado_en')
      .eq('empresa_id', this.empresaId)
      .order('actualizado_en', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return maximaFecha(data ?? []);
  }
}

function maximaFecha(filas: Array<{ actualizado_en?: string | null }>): number | null {
  let maxima: number | null = null;
  for (const fila of filas) {
    const t = fila.actualizado_en ? Date.parse(fila.actualizado_en) : NaN;
    if (!Number.isNaN(t) && (maxima === null || t > maxima)) maxima = t;
  }
  return maxima;
}

function ordenarPorCreacionDesc(a: FilaReporte, b: FilaReporte): number {
  const ta = Date.parse(String(a.creado_en ?? '')) || 0;
  const tb = Date.parse(String(b.creado_en ?? '')) || 0;
  if (ta !== tb) return tb - ta;
  return String(a.id).localeCompare(String(b.id));
}
