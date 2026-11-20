import { Injectable, Logger } from '@nestjs/common';
import { esRolAdmin, normalizarListaRoles, normalizarRol, type RolCanonico } from '../auth/permisos';
import { SupabaseService } from '../common/supabase.service';
import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { normalizarTexto } from '../ia-extractor/normalizacion';
import {
  FilaReporte,
  construirCampos,
  numeroVisible,
  reservaActiva,
  reservaDeFila,
} from './reportes.mapper';

export type TipoAccionEvento =
  | 'tomar'
  | 'confirmar'
  | 'corregir'
  | 'marcar_ilegible'
  | 'cerrar'
  | 'liberar'
  | 'subir';

export const TIPOS_ACCION_EVENTO: readonly TipoAccionEvento[] = [
  'tomar',
  'confirmar',
  'corregir',
  'marcar_ilegible',
  'cerrar',
  'liberar',
  'subir',
];

/** SIREP-S4-T06: Acciones separadas por menos de 20 minutos forman la misma sesión activa. */
export const UMBRAL_SESION_MS = 20 * 60 * 1000;
const EMPRESA_POR_DEFECTO = '00000000-0000-0000-0000-000000000000';
const ZONA_HORARIA = 'America/Lima';

export interface RegistrarEventoInput {
  usuario_id?: string | null;
  usuario: string;
  reporte?: string | null;
  campo?: string | null;
  tipo_accion: TipoAccionEvento;
  detalle?: Record<string, unknown>;
  creado_en?: string;
}

export interface EventoRevision {
  id?: number | string;
  usuario_id: string | null;
  usuario: string;
  reporte: string | null;
  campo: string | null;
  tipo_accion: TipoAccionEvento;
  detalle: Record<string, unknown>;
  creado_en: string;
}

export interface SesionTrabajo {
  inicio: string;
  fin: string;
  duracion_ms: number;
  duracion_minutos: number;
  acciones: number;
}

export interface ResumenSesiones {
  sesiones: SesionTrabajo[];
  minutos_activos: number;
  horas_activas: number;
}

export interface MetricasRevisorPeriodo {
  reportes_cerrados: number;
  horas_activas: number;
  minutos_activos: number;
  sesiones: number;
  minutos_por_reporte: number;
  reportes_por_hora_activa: number;
  campos_corregidos: number;
  campos_confirmados: number;
  campos_ilegibles: number;
  campos_corregidos_por_reporte: number;
  ultima_actividad: string | null;
}

export interface MetricasRevisorPersona extends MetricasRevisorPeriodo {
  usuario_id: string | null;
  nombre: string;
  roles: RolCanonico[];
  hoy: MetricasRevisorPeriodo;
  esta_semana: MetricasRevisorPeriodo;
  por_dia: Array<{ fecha: string } & MetricasRevisorPeriodo>;
  por_semana: Array<{ semana: string } & MetricasRevisorPeriodo>;
}

export interface MetricasIngestorPeriodo {
  pdfs_subidos: number;
  duplicados: number;
  errores: number;
  horas_activas: number;
  minutos_activos: number;
  sesiones: number;
  ultima_actividad: string | null;
}

export interface MetricasIngestorPersona extends MetricasIngestorPeriodo {
  usuario_id: string | null;
  nombre: string;
  roles: RolCanonico[];
  hoy: MetricasIngestorPeriodo;
  esta_semana: MetricasIngestorPeriodo;
  por_dia: Array<{ fecha: string } & MetricasIngestorPeriodo>;
  por_semana: Array<{ semana: string } & MetricasIngestorPeriodo>;
}

export interface ProyeccionTermino {
  pendientes_totales: number;
  promedio_diario_revisados: number;
  dias_con_actividad: number;
  dias_restantes_estimados: number | null;
  fecha_estimada_termino: string | null;
}

export interface AlertaCalidad {
  numero_reporte: string;
  revisor: string;
  cerrado_en: string;
  duracion_minutos: number;
  campos_corregidos: number;
  motivo: string;
}

export interface DiscrepanciaDobleRevision {
  campo: string;
  valor_primera: string | null;
  valor_segunda: string | null;
}

export interface ResultadoCoincidenciaDobleRevision {
  porcentaje_coincidencia: number;
  campos_coincidentes: number;
  campos_totales: number;
  discrepancias: DiscrepanciaDobleRevision[];
}

export interface TableroAdministrador {
  generado_en: string;
  resumen: {
    subidos: number;
    en_cola: number;
    en_revision: number;
    revisados: number;
    doble_revision_pendiente: number;
    enviados_rptech: number;
    pendientes_envio_rptech: number;
  };
  proyeccion: ProyeccionTermino & {
    serie_diaria: Array<{ fecha: string; revisados: number }>;
  };
  revisores: MetricasRevisorPersona[];
  ingestores: MetricasIngestorPersona[];
  reservas_activas: Array<{
    numero_reporte: string;
    cliente: string;
    reservado_por: string;
    reservado_por_id: string | null;
    reservado_en: string;
    expira_en: string;
    minutos_transcurridos: number;
  }>;
  alertas_calidad: AlertaCalidad[];
  doble_revision: {
    pendientes: Array<{
      numero_reporte: string;
      primer_revisor: string;
      elegido_en: string;
    }>;
    completadas: Array<{
      numero_reporte: string;
      primer_revisor: string;
      segundo_revisor: string;
      porcentaje_coincidencia: number;
      campos_coincidentes: number;
      campos_totales: number;
      completado_en: string;
      discrepancias: DiscrepanciaDobleRevision[];
    }>;
    promedio_coincidencia: number | null;
  };
}

function redondear2(n: number): number {
  return Math.round(n * 100) / 100;
}

function tablaNoExiste(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const texto = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
  return (
    texto.includes('42p01') ||
    texto.includes('pgrst205') ||
    texto.includes('does not exist') ||
    texto.includes('could not find the table')
  );
}

const fmtFechaLima = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function fechaCalendarioLima(isoOMs: string | number): string {
  const fecha = typeof isoOMs === 'number' ? new Date(isoOMs) : new Date(isoOMs);
  if (!Number.isFinite(fecha.getTime())) return '1970-01-01';
  return fmtFechaLima.format(fecha);
}

export function inicioSemanaCalendario(fechaYYYYMMDD: string): string {
  const d = new Date(`${fechaYYYYMMDD}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return fechaYYYYMMDD;
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function sumarDiasFecha(fechaYYYYMMDD: string, dias: number): string {
  const d = new Date(`${fechaYYYYMMDD}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * SIREP-S4-T06: Calcula sesiones de trabajo a partir de timestamps de eventos.
 * Acciones separadas por menos de 20 minutos forman una sesión continua;
 * pausas >= 20 minutos cortan la sesión y el tiempo muerto no cuenta.
 */
export function calcularSesionesDesdeEventos(
  timestampsIso: readonly string[],
  umbralMs = UMBRAL_SESION_MS,
): ResumenSesiones {
  const ordenados = timestampsIso
    .map((t) => Date.parse(t))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  if (ordenados.length === 0) {
    return { sesiones: [], minutos_activos: 0, horas_activas: 0 };
  }

  const sesiones: SesionTrabajo[] = [];
  let inicio = ordenados[0];
  let fin = ordenados[0];
  let acciones = 1;

  for (let i = 1; i < ordenados.length; i++) {
    const actual = ordenados[i];
    if (actual - fin < umbralMs) {
      fin = actual;
      acciones++;
    } else {
      const duracionMs = fin - inicio;
      sesiones.push({
        inicio: new Date(inicio).toISOString(),
        fin: new Date(fin).toISOString(),
        duracion_ms: duracionMs,
        duracion_minutos: redondear2(duracionMs / 60_000),
        acciones,
      });
      inicio = actual;
      fin = actual;
      acciones = 1;
    }
  }

  const ultimoDuracionMs = fin - inicio;
  sesiones.push({
    inicio: new Date(inicio).toISOString(),
    fin: new Date(fin).toISOString(),
    duracion_ms: ultimoDuracionMs,
    duracion_minutos: redondear2(ultimoDuracionMs / 60_000),
    acciones,
  });

  const minutosActivos = redondear2(sesiones.reduce((acc, s) => acc + s.duracion_ms / 60_000, 0));
  return {
    sesiones,
    minutos_activos: minutosActivos,
    horas_activas: redondear2(minutosActivos / 60),
  };
}

/**
 * SIREP-S4-T07: Calcula ritmo diario y fecha estimada de término (pendientes / promedio diario).
 */
export function calcularProyeccionTermino(
  pendientesTotales: number,
  revisadosPorDia: Record<string, number>,
  fechaReferencia = new Date(),
): ProyeccionTermino {
  const hoy = fechaCalendarioLima(fechaReferencia.getTime());
  const fechasActivas = Object.keys(revisadosPorDia)
    .filter((f) => (revisadosPorDia[f] ?? 0) > 0)
    .sort();
  const totalCerrados = fechasActivas.reduce((acc, f) => acc + (revisadosPorDia[f] ?? 0), 0);
  const diasConActividad = fechasActivas.length;
  const promedioDiario = diasConActividad > 0 ? redondear2(totalCerrados / diasConActividad) : 0;

  if (pendientesTotales <= 0) {
    return {
      pendientes_totales: 0,
      promedio_diario_revisados: promedioDiario,
      dias_con_actividad: diasConActividad,
      dias_restantes_estimados: 0,
      fecha_estimada_termino: hoy,
    };
  }

  if (promedioDiario <= 0) {
    return {
      pendientes_totales: pendientesTotales,
      promedio_diario_revisados: 0,
      dias_con_actividad: 0,
      dias_restantes_estimados: null,
      fecha_estimada_termino: null,
    };
  }

  const diasRestantes = Math.ceil(pendientesTotales / promedioDiario);
  return {
    pendientes_totales: pendientesTotales,
    promedio_diario_revisados: promedioDiario,
    dias_con_actividad: diasConActividad,
    dias_restantes_estimados: diasRestantes,
    fecha_estimada_termino: sumarDiasFecha(hoy, diasRestantes),
  };
}

/**
 * SIREP-S4-T07: Detecta reportes cerrados en muy pocos minutos y sin ninguna corrección.
 */
export function detectarAlertasCalidad(
  reportes: FilaReporte[],
  eventos: EventoRevision[],
  umbralMinutos = 2,
): AlertaCalidad[] {
  const eventosPorReporte = new Map<string, EventoRevision[]>();
  for (const ev of eventos) {
    if (!ev.reporte || ev.tipo_accion === 'subir' || ev.tipo_accion === 'liberar') continue;
    const lista = eventosPorReporte.get(ev.reporte) ?? [];
    lista.push(ev);
    eventosPorReporte.set(ev.reporte, lista);
  }

  const alertas: AlertaCalidad[] = [];
  for (const fila of reportes) {
    const numero = numeroVisible(fila);
    const campos = construirCampos(fila.campos_extraidos);
    const pendientes = campos.filter((c) => c.estado_revision === 'pendiente');
    const estaCerrado =
      pendientes.length === 0 ||
      fila.bloqueado === true ||
      fila.estado_reporte === 'aprobado' ||
      fila.estado_reporte === 'aprobado_rptech' ||
      fila.estado_reporte === 'cerrado';
    if (!estaCerrado) continue;

    const evs = eventosPorReporte.get(numero) ?? [];
    const correccionesEnCampos = campos.filter((c) => c.estado_revision === 'corregido').length;
    const correccionesEnEventos = evs.filter((e) => e.tipo_accion === 'corregir').length;
    if (correccionesEnCampos > 0 || correccionesEnEventos > 0) continue;

    const marcasTiempo: number[] = [];
    let huboAccionHumana = false;
    let revisor = fila.corregido_por || '';

    for (const ev of evs) {
      const ms = Date.parse(ev.creado_en);
      if (Number.isFinite(ms)) marcasTiempo.push(ms);
      if (ev.tipo_accion !== 'tomar') huboAccionHumana = true;
      if (ev.usuario) revisor = ev.usuario;
    }

    for (const c of campos) {
      if (['confirmado', 'ilegible', 'omitido'].includes(c.estado_revision)) {
        huboAccionHumana = true;
        if (c.revisado_por) revisor = c.revisado_por;
        if (c.revisado_en) {
          const ms = Date.parse(c.revisado_en);
          if (Number.isFinite(ms)) marcasTiempo.push(ms);
        }
      }
    }

    if (!huboAccionHumana || marcasTiempo.length === 0) continue;

    const inicioMs = Math.min(...marcasTiempo);
    const finMs = Math.max(...marcasTiempo);
    const duracionMin = redondear2((finMs - inicioMs) / 60_000);

    if (duracionMin < umbralMinutos) {
      alertas.push({
        numero_reporte: numero,
        revisor: revisor || 'Revisor',
        cerrado_en: new Date(finMs).toISOString(),
        duracion_minutos: duracionMin,
        campos_corregidos: 0,
        motivo: `Cerrado en ${duracionMin.toFixed(1)} min sin ninguna corrección`,
      });
    }
  }

  return alertas.sort((a, b) => Date.parse(b.cerrado_en) - Date.parse(a.cerrado_en));
}

/**
 * SIREP-S4-T08: Compara campo por campo (los 31 campos) entre la 1ª y la 2ª revisión a ciegas.
 */
export function calcularCoincidenciaDobleRevision(
  primera: Record<string, string | null>,
  segunda: Record<string, string | null>,
): ResultadoCoincidenciaDobleRevision {
  const discrepancias: DiscrepanciaDobleRevision[] = [];
  let coincidentes = 0;

  for (const id of IDS_CAMPOS_FORMULARIO) {
    const v1 = primera[id] ?? null;
    const v2 = segunda[id] ?? null;
    if (normalizarTexto(v1 ?? '') === normalizarTexto(v2 ?? '')) {
      coincidentes++;
    } else {
      discrepancias.push({
        campo: id,
        valor_primera: v1,
        valor_segunda: v2,
      });
    }
  }

  const total = IDS_CAMPOS_FORMULARIO.length;
  return {
    porcentaje_coincidencia: total > 0 ? redondear2((coincidentes / total) * 100) : 100,
    campos_coincidentes: coincidentes,
    campos_totales: total,
    discrepancias,
  };
}

@Injectable()
export class TableroService {
  private readonly logger = new Logger(TableroService.name);
  private avisoTablaFaltante = false;

  constructor(private readonly supabase: SupabaseService) {}

  private get db() {
    return this.supabase.getClient();
  }

  /**
   * SIREP-S4-T05: Registra un evento inmutable (append-only) en `eventos_revision`.
   * Si aún no se aplicó la migración SQL, guarda de forma transparente en `actividad_usuarios`
   * para no perder ninguna acción ni romper el flujo principal.
   */
  async registrarEvento(input: RegistrarEventoInput): Promise<void> {
    const fila = {
      empresa_id: EMPRESA_POR_DEFECTO,
      usuario_id: input.usuario_id ?? null,
      usuario: (input.usuario || '').trim() || 'sistema',
      reporte: input.reporte ?? null,
      campo: input.campo ?? null,
      tipo_accion: input.tipo_accion,
      detalle: input.detalle ?? {},
      ...(input.creado_en ? { creado_en: input.creado_en } : {}),
    };

    try {
      const res: any = await this.db.from('eventos_revision').insert(fila);
      const error = res?.error;
      if (!error) return;

      if (tablaNoExiste(error)) {
        if (!this.avisoTablaFaltante) {
          this.avisoTablaFaltante = true;
          this.logger.warn(
            'Falta la tabla eventos_revision: se respalda temporalmente en actividad_usuarios hasta aplicar 20261119120000.',
          );
        }
        await this.db.from('actividad_usuarios').insert({
          usuario_id: fila.usuario_id,
          usuario: fila.usuario,
          accion: `s4_evento_${fila.tipo_accion}`,
          detalle: {
            reporte: fila.reporte,
            campo: fila.campo,
            ...fila.detalle,
          },
          ...(fila.creado_en ? { creado_en: fila.creado_en } : {}),
        });
        return;
      }

      this.logger.warn(`No se pudo registrar evento "${fila.tipo_accion}": ${error.message}`);
    } catch (e) {
      this.logger.warn(`No se pudo registrar evento "${fila.tipo_accion}": ${String(e)}`);
    }
  }

  /** Lista los eventos registrados en `eventos_revision` (con respaldo desde `actividad_usuarios` si falta la tabla). */
  async listarEventos(filtro: { limite?: number; usuarioId?: string; reporte?: string; tipoAccion?: string } = {}): Promise<EventoRevision[]> {
    const limite = Math.min(Math.max(Number(filtro.limite) || 500, 1), 2000);
    try {
      let consulta = this.db
        .from('eventos_revision')
        .select('id, usuario_id, usuario, reporte, campo, tipo_accion, detalle, creado_en')
        .order('creado_en', { ascending: false })
        .limit(limite);
      if (filtro.usuarioId) consulta = consulta.eq('usuario_id', filtro.usuarioId);
      if (filtro.reporte) consulta = consulta.eq('reporte', filtro.reporte);
      if (filtro.tipoAccion) consulta = consulta.eq('tipo_accion', filtro.tipoAccion);

      const { data, error } = await consulta;
      if (!error && Array.isArray(data)) {
        return data as EventoRevision[];
      }
      if (error && !tablaNoExiste(error)) {
        this.logger.warn(`Error leyendo eventos_revision: ${error.message}`);
      }
    } catch {
      // Continúa al respaldo con actividad_usuarios
    }

    return this.leerEventosDesdeActividad(limite);
  }

  private async leerEventosDesdeActividad(limite = 1500): Promise<EventoRevision[]> {
    try {
      const { data, error } = await this.db
        .from('actividad_usuarios')
        .select('id, usuario_id, usuario, accion, detalle, creado_en')
        .order('creado_en', { ascending: false })
        .limit(limite);
      if (error || !Array.isArray(data)) return [];

      const salida: EventoRevision[] = [];
      for (const row of data as any[]) {
        const det = (row.detalle && typeof row.detalle === 'object' ? row.detalle : {}) as Record<string, unknown>;
        const reporte = typeof det.reporte === 'string' ? det.reporte : null;
        const campo = typeof det.campo === 'string' ? det.campo : null;
        let tipoAccion: TipoAccionEvento | null = null;

        if (typeof row.accion === 'string' && row.accion.startsWith('s4_evento_')) {
          const candidato = row.accion.slice('s4_evento_'.length) as TipoAccionEvento;
          if (TIPOS_ACCION_EVENTO.includes(candidato)) tipoAccion = candidato;
        } else if (row.accion === 'reporte_reservado') tipoAccion = 'tomar';
        else if (row.accion === 'reporte_liberado') tipoAccion = 'liberar';
        else if (row.accion === 'reporte_cerrado') tipoAccion = 'cerrar';
        else if (row.accion === 'escaneo_subido') tipoAccion = 'subir';
        else if (row.accion === 'campo_revisado') {
          if (det.tipo === 'corregir') tipoAccion = 'corregir';
          else if (det.tipo === 'ilegible') tipoAccion = 'marcar_ilegible';
          else if (det.tipo === 'confirmar' || det.tipo === 'omitir') tipoAccion = 'confirmar';
        }

        if (!tipoAccion) continue;
        salida.push({
          id: row.id,
          usuario_id: row.usuario_id ?? null,
          usuario: String(row.usuario || 'sistema'),
          reporte,
          campo,
          tipo_accion: tipoAccion,
          detalle: det,
          creado_en: String(row.creado_en),
        });
      }
      return salida;
    } catch {
      return [];
    }
  }

  /** Consulta usuarios de producción de forma tolerante en tests con mocks parciales. */
  private async cargarUsuarios(): Promise<Array<{ id: string; usuario: string; nombre: string; rol: RolCanonico; roles: RolCanonico[]; ultimo_acceso?: string | null }>> {
    try {
      const res: any = await this.db
        .from('usuarios')
        .select('id, usuario, nombre, rol, permisos, activo, ultimo_acceso')
        .order('creado_en', { ascending: true });
      if (!Array.isArray(res?.data)) return [];
      return res.data.filter((u: any) => u && u.activo !== false).map((u: any) => {
        const tieneGestion = Array.isArray(u.permisos) && u.permisos.includes('gestionar_usuarios');
        const rolBase: RolCanonico =
          esRolAdmin(u.rol, u.roles) || tieneGestion ? 'administrador' : normalizarRol(u.rol);
        const roles = normalizarListaRoles(rolBase, u.roles);
        if (
          rolBase !== 'administrador' &&
          Array.isArray(u.permisos) &&
          u.permisos.includes('subir_escaneos') &&
          u.permisos.includes('editar_campos') &&
          roles.length === 1
        ) {
          roles.push(roles[0] === 'ingestor' ? 'revisor' : 'ingestor');
        }
        return {
          id: u.id,
          usuario: u.usuario,
          nombre: u.nombre,
          rol: rolBase,
          roles,
          ultimo_acceso: u.ultimo_acceso ?? null,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Complementa eventos reales de `eventos_revision` con revisiones históricas guardadas en `reportes`
   * y cargas en `escaneos` que no tengan evento equivalente, para que las métricas sobre la BD de producción
   * nunca salgan en cero.
   */
  private combinarConDatosHistoricos(
    eventosBase: EventoRevision[],
    reportes: FilaReporte[],
    escaneos: Array<{ id: string; numero_reporte: string | null; enviado_por: string | null; creado_en: string; estado?: string }>,
  ): EventoRevision[] {
    const combinados = [...eventosBase];
    const clavesCampo = new Set(
      eventosBase
        .filter((e) => e.reporte && e.campo)
        .map((e) => `${e.reporte}|${e.campo}|${e.tipo_accion}`),
    );
    const reportesConCierre = new Set(
      eventosBase.filter((e) => e.tipo_accion === 'cerrar' && e.reporte).map((e) => e.reporte as string),
    );
    const subidasRegistradas = new Set(
      eventosBase
        .filter((e) => e.tipo_accion === 'subir' && e.reporte)
        .map((e) => `${(e.usuario || '').toLowerCase()}|${e.reporte}|${fechaCalendarioLima(e.creado_en)}`),
    );

    for (const fila of reportes) {
      const numero = numeroVisible(fila);
      const campos = construirCampos(fila.campos_extraidos);
      let ultimaHora: string | null = null;
      let ultimoRevisor: string | null = fila.corregido_por || null;

      for (const c of campos) {
        if (!c.revisado_en || !c.revisado_por) continue;
        let tipoAccion: TipoAccionEvento | null = null;
        if (c.estado_revision === 'corregido') tipoAccion = 'corregir';
        else if (c.estado_revision === 'ilegible') tipoAccion = 'marcar_ilegible';
        else if (c.estado_revision === 'confirmado' || c.estado_revision === 'omitido') tipoAccion = 'confirmar';

        if (!tipoAccion) continue;
        if (!ultimaHora || Date.parse(c.revisado_en) > Date.parse(ultimaHora)) {
          ultimaHora = c.revisado_en;
          ultimoRevisor = c.revisado_por;
        }

        const clave = `${numero}|${c.id}|${tipoAccion}`;
        if (!clavesCampo.has(clave)) {
          clavesCampo.add(clave);
          combinados.push({
            usuario_id: null,
            usuario: c.revisado_por,
            reporte: numero,
            campo: c.id,
            tipo_accion: tipoAccion,
            detalle: { historico: true },
            creado_en: c.revisado_en,
          });
        }
      }

      const sinPendientes = !campos.some((c) => c.estado_revision === 'pendiente');
      const estaCerrado =
        sinPendientes ||
        fila.bloqueado === true ||
        fila.estado_reporte === 'aprobado' ||
        fila.estado_reporte === 'aprobado_rptech' ||
        fila.estado_reporte === 'cerrado';

      if (estaCerrado && !reportesConCierre.has(numero) && ultimoRevisor && ultimaHora) {
        reportesConCierre.add(numero);
        combinados.push({
          usuario_id: null,
          usuario: ultimoRevisor,
          reporte: numero,
          campo: null,
          tipo_accion: 'cerrar',
          detalle: { historico: true },
          creado_en: fila.importado_en || ultimaHora,
        });
      }
    }

    for (const esc of escaneos) {
      const autor = (esc.enviado_por || '').trim();
      const num = esc.numero_reporte || null;
      if (!autor || autor === 'telegram' || !esc.creado_en) continue;
      const clave = `${autor.toLowerCase()}|${num}|${fechaCalendarioLima(esc.creado_en)}`;
      if (num && subidasRegistradas.has(clave)) continue;
      if (num) subidasRegistradas.add(clave);
      combinados.push({
        usuario_id: null,
        usuario: autor,
        reporte: num,
        campo: null,
        tipo_accion: 'subir',
        detalle: { resultado: 'procesado', historico: true },
        creado_en: esc.creado_en,
      });
    }

    return combinados;
  }

  private perteneceAPersona(
    evento: EventoRevision,
    persona: { id?: string | null; usuario?: string; nombre: string },
  ): boolean {
    if (persona.id && evento.usuario_id && evento.usuario_id === persona.id) return true;
    const evNom = (evento.usuario || '').trim().toLowerCase();
    const pNom = persona.nombre.trim().toLowerCase();
    const pUser = (persona.usuario || '').trim().toLowerCase();
    return Boolean(evNom && (evNom === pNom || (pUser && evNom === pUser)));
  }

  private calcularPeriodoRevisor(eventos: EventoRevision[], ultimoAcceso?: string | null): MetricasRevisorPeriodo {
    const cerrados = new Set<string>();
    let cierresSinNumero = 0;
    let corregidos = 0;
    let confirmados = 0;
    let ilegibles = 0;
    let maxMs = 0;

    for (const ev of eventos) {
      const ms = Date.parse(ev.creado_en);
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
      if (ev.tipo_accion === 'cerrar') {
        if (ev.reporte) cerrados.add(ev.reporte);
        else cierresSinNumero++;
      } else if (ev.tipo_accion === 'corregir') {
        corregidos++;
      } else if (ev.tipo_accion === 'confirmar') {
        confirmados++;
      } else if (ev.tipo_accion === 'marcar_ilegible') {
        ilegibles++;
      }
    }

    const totalCerrados = cerrados.size + cierresSinNumero;
    const resumenSesiones = calcularSesionesDesdeEventos(eventos.map((e) => e.creado_en));
    const minutosPorReporte = totalCerrados > 0 ? redondear2(resumenSesiones.minutos_activos / totalCerrados) : 0;
    const reportesPorHora =
      resumenSesiones.horas_activas > 0 ? redondear2(totalCerrados / resumenSesiones.horas_activas) : 0;
    const corregidosPorReporte = totalCerrados > 0 ? redondear2(corregidos / totalCerrados) : 0;

    return {
      reportes_cerrados: totalCerrados,
      horas_activas: resumenSesiones.horas_activas,
      minutos_activos: resumenSesiones.minutos_activos,
      sesiones: resumenSesiones.sesiones.length,
      minutos_por_reporte: minutosPorReporte,
      reportes_por_hora_activa: reportesPorHora,
      campos_corregidos: corregidos,
      campos_confirmados: confirmados,
      campos_ilegibles: ilegibles,
      campos_corregidos_por_reporte: corregidosPorReporte,
      ultima_actividad: maxMs > 0 ? new Date(maxMs).toISOString() : (ultimoAcceso ?? null),
    };
  }

  private calcularPeriodoIngestor(eventos: EventoRevision[], ultimoAcceso?: string | null): MetricasIngestorPeriodo {
    let subidos = 0;
    let duplicados = 0;
    let errores = 0;
    let maxMs = 0;

    for (const ev of eventos) {
      const ms = Date.parse(ev.creado_en);
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
      if (ev.tipo_accion !== 'subir') continue;
      const res = ev.detalle?.resultado;
      if (res === 'duplicado') duplicados++;
      else if (res === 'error') errores++;
      else subidos++;
    }

    const resumenSesiones = calcularSesionesDesdeEventos(eventos.map((e) => e.creado_en));
    return {
      pdfs_subidos: subidos,
      duplicados,
      errores,
      horas_activas: resumenSesiones.horas_activas,
      minutos_activos: resumenSesiones.minutos_activos,
      sesiones: resumenSesiones.sesiones.length,
      ultima_actividad: maxMs > 0 ? new Date(maxMs).toISOString() : (ultimoAcceso ?? null),
    };
  }

  private agruparPorPeriodo<T>(
    eventos: EventoRevision[],
    fechaHoy: string,
    semanaActual: string,
    calcular: (evs: EventoRevision[]) => T,
  ): {
    total: T;
    hoy: T;
    esta_semana: T;
    por_dia: Array<{ fecha: string } & T>;
    por_semana: Array<{ semana: string } & T>;
  } {
    const porDiaMap = new Map<string, EventoRevision[]>();
    const porSemanaMap = new Map<string, EventoRevision[]>();

    for (const ev of eventos) {
      const dia = fechaCalendarioLima(ev.creado_en);
      const semana = inicioSemanaCalendario(dia);
      const lDia = porDiaMap.get(dia) ?? [];
      lDia.push(ev);
      porDiaMap.set(dia, lDia);

      const lSem = porSemanaMap.get(semana) ?? [];
      lSem.push(ev);
      porSemanaMap.set(semana, lSem);
    }

    const porDia = [...porDiaMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 30)
      .map(([fecha, evs]) => ({ fecha, ...calcular(evs) }));

    const porSemana = [...porSemanaMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 12)
      .map(([semana, evs]) => ({ semana, ...calcular(evs) }));

    return {
      total: calcular(eventos),
      hoy: calcular(porDiaMap.get(fechaHoy) ?? []),
      esta_semana: calcular(porSemanaMap.get(semanaActual) ?? []),
      por_dia: porDia,
      por_semana: porSemana,
    };
  }

  /**
   * SIREP-S4-T06, T07 y T08: Consolida todas las métricas del Tablero del Administrador.
   */
  async obtenerTablero(ahoraMs = Date.now()): Promise<TableroAdministrador> {
    const [cuentas, resReportes, resEscaneos, eventosGuardados] = await Promise.all([
      this.cargarUsuarios(),
      this.db
        .from('reportes')
        .select(
          '*, escaneo:escaneos(id, ruta_original, paginas, enviado_por, telegram_chat_id, estado, creado_en)',
        )
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('creado_en', { ascending: false })
        .limit(2000),
      this.db
        .from('escaneos')
        .select('id, numero_reporte, enviado_por, estado, creado_en')
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('creado_en', { ascending: false })
        .limit(2000),
      this.listarEventos({ limite: 2000 }),
    ]);

    const reportes = (Array.isArray(resReportes?.data) ? resReportes.data : []) as FilaReporte[];
    const escaneos = (Array.isArray(resEscaneos?.data) ? resEscaneos.data : []) as Array<{
      id: string;
      numero_reporte: string | null;
      enviado_por: string | null;
      creado_en: string;
      estado?: string;
    }>;

    const eventos = this.combinarConDatosHistoricos(eventosGuardados, reportes, escaneos);
    const hoy = fechaCalendarioLima(ahoraMs);
    const semanaActual = inicioSemanaCalendario(hoy);

    // 1. Resumen de estado general + reservas activas + doble revisión (T07 y T08)
    let enCola = 0;
    let enRevision = 0;
    let revisados = 0;
    let dobleRevPendientesCount = 0;
    let enviadosRptech = 0;
    let pendientesEnvioRptech = 0;

    const reservasActivas: TableroAdministrador['reservas_activas'] = [];
    const doblePendientes: TableroAdministrador['doble_revision']['pendientes'] = [];
    const dobleCompletadas: TableroAdministrador['doble_revision']['completadas'] = [];

    for (const fila of reportes) {
      const numero = numeroVisible(fila);
      const dobleRev = fila.datos_originales?.__doble_revision as any;
      if (dobleRev?.estado === 'pendiente' || fila.doble_revision_estado === 'pendiente') {
        dobleRevPendientesCount++;
        doblePendientes.push({
          numero_reporte: numero,
          primer_revisor: String(dobleRev?.primer_revisor || 'Revisor'),
          elegido_en: String(dobleRev?.elegido_en || fila.actualizado_en),
        });
      } else if (dobleRev?.estado === 'completada' || fila.doble_revision_estado === 'completada') {
        const pct =
          typeof dobleRev?.porcentaje_coincidencia === 'number'
            ? dobleRev.porcentaje_coincidencia
            : Number(fila.doble_revision_coincidencia ?? 0);
        dobleCompletadas.push({
          numero_reporte: numero,
          primer_revisor: String(dobleRev?.primer_revisor || 'Revisor 1'),
          segundo_revisor: String(dobleRev?.segundo_revisor || fila.doble_revision_por || 'Revisor 2'),
          porcentaje_coincidencia: pct,
          campos_coincidentes: Number(dobleRev?.campos_coincidentes ?? 0),
          campos_totales: Number(dobleRev?.campos_totales ?? IDS_CAMPOS_FORMULARIO.length),
          completado_en: String(dobleRev?.completado_en || fila.actualizado_en),
          discrepancias: Array.isArray(dobleRev?.discrepancias) ? dobleRev.discrepancias : [],
        });
      }

      const campos = construirCampos(fila.campos_extraidos);
      const tienePendientes = campos.some((c) => c.estado_revision === 'pendiente');
      const estaCerrado =
        !tienePendientes ||
        fila.bloqueado === true ||
        fila.estado_reporte === 'aprobado' ||
        fila.estado_reporte === 'aprobado_rptech' ||
        fila.estado_reporte === 'cerrado';

      if (estaCerrado && dobleRev?.estado !== 'pendiente') {
        revisados++;
        if (fila.rptech_id || fila.estado_reporte === 'aprobado_rptech') {
          enviadosRptech++;
        } else if (fila.origen === 'historico') {
          pendientesEnvioRptech++;
        }
      } else if (reservaActiva(fila, ahoraMs)) {
        enRevision++;
        const resv = reservaDeFila(fila);
        const resTs = resv.reservado_en ? Date.parse(resv.reservado_en) : ahoraMs;
        reservasActivas.push({
          numero_reporte: numero,
          cliente: fila.cliente ?? '',
          reservado_por: resv.reservado_por ?? 'Revisor',
          reservado_por_id: resv.reservado_por_id ?? null,
          reservado_en: resv.reservado_en ?? new Date(ahoraMs).toISOString(),
          expira_en: new Date(resTs + 4 * 60 * 60 * 1000).toISOString(),
          minutos_transcurridos: redondear2(Math.max(0, ahoraMs - resTs) / 60_000),
        });
      } else {
        const intervino = campos.some((c) =>
          ['confirmado', 'corregido', 'ilegible', 'omitido'].includes(c.estado_revision),
        );
        if (intervino) enRevision++;
        else enCola++;
      }
    }

    // 2. Ritmo diario y fecha estimada de término (SIREP-S4-T07)
    const cerradosPorDia = new Map<string, Set<string>>();
    let cierresSinNumeroPorDia: Record<string, number> = {};
    for (const ev of eventos) {
      if (ev.tipo_accion !== 'cerrar') continue;
      const dia = fechaCalendarioLima(ev.creado_en);
      if (ev.reporte) {
        const set = cerradosPorDia.get(dia) ?? new Set<string>();
        set.add(ev.reporte);
        cerradosPorDia.set(dia, set);
      } else {
        cierresSinNumeroPorDia[dia] = (cierresSinNumeroPorDia[dia] ?? 0) + 1;
      }
    }
    const revisadosPorDiaObj: Record<string, number> = {};
    for (const [dia, set] of cerradosPorDia.entries()) {
      revisadosPorDiaObj[dia] = set.size + (cierresSinNumeroPorDia[dia] ?? 0);
    }
    for (const [dia, cant] of Object.entries(cierresSinNumeroPorDia)) {
      if (!(dia in revisadosPorDiaObj)) revisadosPorDiaObj[dia] = cant;
    }

    const proyeccionBase = calcularProyeccionTermino(enCola + enRevision, revisadosPorDiaObj, new Date(ahoraMs));
    const serieDiaria = Object.entries(revisadosPorDiaObj)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-14)
      .map(([fecha, rev]) => ({ fecha, revisados: rev }));

    // 3. Personas: asegurar que aparezcan cuentas oficiales + cualquier actor que tenga eventos en BD
    const personasMapa = new Map<
      string,
      { id: string | null; usuario?: string; nombre: string; roles: RolCanonico[]; ultimo_acceso: string | null }
    >();
    for (const c of cuentas) {
      personasMapa.set(c.nombre.trim().toLowerCase(), {
        id: c.id,
        usuario: c.usuario,
        nombre: c.nombre,
        roles: c.roles ?? [normalizarRol(c.rol)],
        ultimo_acceso: c.ultimo_acceso ?? null,
      });
    }

    const buscarClavePersona = (nombre: string, usuarioId: string | null) => {
      for (const [k, p] of personasMapa.entries()) {
        if ((usuarioId && p.id === usuarioId) || p.nombre.toLowerCase() === nombre.toLowerCase() || p.usuario === nombre.toLowerCase()) {
          return k;
        }
      }
      return null;
    };

    for (const ev of eventos) {
      const nom = (ev.usuario || '').trim();
      if (!nom || nom === 'sistema' || nom === 'telegram') continue;
      if (buscarClavePersona(nom, ev.usuario_id)) continue;
      const rolInferido: RolCanonico = ev.tipo_accion === 'subir' ? 'ingestor' : 'revisor';
      personasMapa.set(nom.toLowerCase(), {
        id: ev.usuario_id,
        nombre: nom,
        roles: [rolInferido],
        ultimo_acceso: ev.creado_en,
      });
    }

    const revisores: MetricasRevisorPersona[] = [];
    const ingestores: MetricasIngestorPersona[] = [];

    for (const persona of personasMapa.values()) {
      const evsPersona = eventos.filter((ev) => this.perteneceAPersona(ev, persona));
      const evsRevision = evsPersona.filter((ev) => ev.tipo_accion !== 'subir');
      const evsIngesta = evsPersona.filter((ev) => ev.tipo_accion === 'subir');

      if (persona.roles.includes('revisor') || evsRevision.length > 0) {
        const agr = this.agruparPorPeriodo(evsPersona, hoy, semanaActual, (evs) =>
          this.calcularPeriodoRevisor(evs, persona.ultimo_acceso),
        );
        revisores.push({
          usuario_id: persona.id,
          nombre: persona.nombre,
          roles: persona.roles,
          ...agr.total,
          hoy: agr.hoy,
          esta_semana: agr.esta_semana,
          por_dia: agr.por_dia,
          por_semana: agr.por_semana,
        });
      }

      if (persona.roles.includes('ingestor') || evsIngesta.length > 0) {
        const agr = this.agruparPorPeriodo(evsIngesta, hoy, semanaActual, (evs) =>
          this.calcularPeriodoIngestor(evs, persona.ultimo_acceso),
        );
        ingestores.push({
          usuario_id: persona.id,
          nombre: persona.nombre,
          roles: persona.roles,
          ...agr.total,
          hoy: agr.hoy,
          esta_semana: agr.esta_semana,
          por_dia: agr.por_dia,
          por_semana: agr.por_semana,
        });
      }
    }

    revisores.sort((a, b) => b.reportes_cerrados - a.reportes_cerrados || b.horas_activas - a.horas_activas);
    ingestores.sort((a, b) => b.pdfs_subidos - a.pdfs_subidos || a.nombre.localeCompare(b.nombre));

    const alertasCalidad = detectarAlertasCalidad(reportes, eventos, 2);
    const promedioCoincidencia =
      dobleCompletadas.length > 0
        ? redondear2(
            dobleCompletadas.reduce((acc, d) => acc + d.porcentaje_coincidencia, 0) / dobleCompletadas.length,
          )
        : null;

    return {
      generado_en: new Date(ahoraMs).toISOString(),
      resumen: {
        subidos: Math.max(reportes.length, escaneos.length),
        en_cola: enCola,
        en_revision: enRevision,
        revisados,
        doble_revision_pendiente: dobleRevPendientesCount,
        enviados_rptech: enviadosRptech,
        pendientes_envio_rptech: pendientesEnvioRptech,
      },
      proyeccion: {
        ...proyeccionBase,
        serie_diaria: serieDiaria,
      },
      revisores,
      ingestores,
      reservas_activas: reservasActivas,
      alertas_calidad: alertasCalidad,
      doble_revision: {
        pendientes: doblePendientes,
        completadas: dobleCompletadas,
        promedio_coincidencia: promedioCoincidencia,
      },
    };
  }
}
