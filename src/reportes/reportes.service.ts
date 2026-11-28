import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { esRolAdmin, normalizarRol } from '../auth/permisos';
import { RptechService } from '../rptech/rptech.service';
import { SupabaseService } from '../common/supabase.service';
import { leerPaginado } from '../common/leer-paginado';
import { EventosGateway } from '../realtime/eventos.gateway';
import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { EMPRESA_POR_DEFECTO } from '../escaneos/escaneos.service';
import {
  cargarDatasetPersistente,
  construirContextoDesdeReportes,
  normalizarTexto,
  registrarEdicionEnDataset,
  similitudTexto,
} from '../ia-extractor/normalizacion';
import { AccionRevisionDto } from './dto/accion-revision.dto';
import { columnasDesdeValores } from './reportes.columnas';
import { generarPdfReporte } from './reportes.pdf';
import {
  COLUMNAS_EXPORTACION_RPTECH,
  FilaReporteExportable,
  generarCsvReportes,
  generarExcelReportes,
} from './reportes.excel';
import {
  CampoGuardado,
  CampoContrato,
  DURACION_RESERVA_MS,
  FilaReporte,
  RevisionCampo,
  SugerenciaVinculo,
  VinculosReporte,
  aReporteContrato,
  campoRequiereRevision,
  construirCampos,
  derivarEstado,
  numeroVisible,
  reservaActiva,
  reservaDeFila,
  valorVigente,
} from './reportes.mapper';
import {
  TableroService,
  TipoAccionEvento,
  calcularCoincidenciaDobleRevision,
} from './tablero.service';

const PROBABILIDAD_DOBLE_REVISION = 0.05;

function esErrorColumnaFaltante(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return /column|columna|schema cache|pgrst204|42703/i.test(`${error.code ?? ''} ${error.message ?? ''}`);
}

const BUCKET = 'escaneos-originales';
// Las imágenes se piden a Storage con un enlace firmado y temporal: el bucket es privado porque son datos de clientes.
const VIGENCIA_ENLACES_SEG = 60 * 60;

// Sin `metadatos` completo: trae la salida cruda del modelo y no hace falta para listar.
const SELECCION =
  '*, escaneo:escaneos(id, ruta_original, paginas, enviado_por, telegram_chat_id, estado, creado_en, metadatos)';

@Injectable()
export class ReportesService {
  private readonly logger = new Logger(ReportesService.name);
  /** Por defecto en NestJS aplica 5% aleatorio; en pruebas unitarias sin TableroService evita azar. */
  private selectorDobleRevision: () => number = () => (this.tablero ? Math.random() : 1);

  constructor(
    private readonly supabase: SupabaseService,
    // Opcional para que las pruebas unitarias no necesiten el canal en vivo
    @Optional() private readonly eventos?: EventosGateway,
    // Envío del histórico a RP-TECH (docs/contrato-historico.md)
    @Optional() private readonly rptech?: RptechService,
    // Registro inmutable de eventos, métricas y doble revisión (Sprint 4 Entrega 2)
    @Optional() private readonly tablero?: TableroService,
  ) { }

  configurarSelectorDobleRevision(selector: () => number): void {
    this.selectorDobleRevision = selector;
  }

  private get client() {
    return this.supabase.getClient();
  }

  async listar(
    limite = 1000,
    usuario?: { id?: string; nombre?: string; email?: string; rol?: string; roles?: string[]; permisos?: string[] },
  ) {
    const { data, error } = await this.client
      .from('reportes')
      .select(SELECCION)
      .eq('empresa_id', EMPRESA_POR_DEFECTO)
      .order('creado_en', { ascending: false })
      .limit(limite);

    if (error) {
      this.logger.error(`No se pudieron listar los reportes: ${error.message}`);
      throw new InternalServerErrorException('No se pudieron cargar los reportes.');
    }

    let filas = (data as FilaReporte[]) ?? [];

    // SIREP-S4-T02: Si el usuario es únicamente ingestor (sube PDF y no es revisor ni administrador),
    // solo ve el estado de lo que él subió.
    if (
      usuario &&
      !esRolAdmin(usuario.rol, usuario.roles) &&
      normalizarRol(usuario.rol) === 'ingestor' &&
      !usuario.permisos?.includes('editar_campos')
    ) {
      const nombreNorm = (usuario.nombre || '').trim().toLowerCase();
      const userNorm = (usuario.email || '').replace(/@.*$/, '').trim().toLowerCase();
      filas = filas.filter((f) => {
        const env = (f.escaneo?.enviado_por || '').trim().toLowerCase();
        if (!env) return false;
        return env === nombreNorm || (userNorm !== '' && env === userNorm);
      });
    }

    // En la lista no se firman enlaces de imagen: el visor los pide al abrir un reporte.
    return filas.map((fila) => aReporteContrato(fila));
  }

  private esMismoUsuario(
    nombreA: string | null | undefined,
    idA: string | null | undefined,
    usuario?: { id?: string; nombre?: string },
  ): boolean {
    if (!usuario) return false;
    if (idA && usuario.id) {
      return idA === usuario.id;
    }
    const prop = (nombreA || '').trim().toLowerCase();
    const nom = (usuario.nombre || '').trim().toLowerCase();
    return Boolean(prop && nom && prop === nom);
  }

  /**
   * SIREP-S4-T03: Verifica si una reserva activa pertenece al usuario autenticado.
   */
  private esDuenoDeReserva(
    fila: FilaReporte,
    usuario?: { id?: string; nombre?: string; rol?: string; roles?: string[]; permisos?: string[] },
  ): boolean {
    if (!usuario) return true;
    const resv = reservaDeFila(fila);
    return this.esMismoUsuario(resv.reservado_por, resv.reservado_por_id, usuario);
  }

  private validarAccesoReserva(
    fila: FilaReporte,
    numero: string,
    usuario?: { id?: string; nombre?: string; rol?: string; roles?: string[]; permisos?: string[] },
    ahoraMs = Date.now(),
  ): void {
    if (!usuario) return;
    if (esRolAdmin(usuario.rol, usuario.roles) || usuario.permisos?.includes('gestionar_usuarios')) {
      return;
    }
    if (reservaActiva(fila, ahoraMs) && !this.esDuenoDeReserva(fila, usuario)) {
      const resv = reservaDeFila(fila);
      throw new ConflictException(
        `El reporte N° ${numero} está reservado por ${resv.reservado_por}. Solo quien lo reservó o el administrador puede modificarlo.`,
      );
    }
  }

  private async actualizarReporteConFallback(
    fila: FilaReporte,
    cambios: Record<string, unknown>,
    opts?: {
      actualizadoEn?: string;
      reservar?: { reservado_por_id: string | null; reservado_por: string | null; reservado_en: string | null } | null;
    },
  ): Promise<{ actualizadas: Array<{ id: string }> | null; error: any }> {
    const ejecutar = async (parche: Record<string, unknown>) => {
      let q = this.client.from('reportes').update(parche).eq('id', fila.id);
      if (opts?.actualizadoEn !== undefined) {
        q = q.eq('actualizado_en', opts.actualizadoEn);
      }
      const res = await q.select('id');
      return { actualizadas: (res.data as Array<{ id: string }> | null) ?? null, error: res.error };
    };

    const res = await ejecutar(cambios);
    if (!res.error || !esErrorColumnaFaltante(res.error)) {
      return res;
    }

    const {
      reservado_por_id: _rId,
      reservado_por: _rNom,
      reservado_en: _rEn,
      doble_revision_estado: _dEst,
      doble_revision_por: _dPor,
      doble_revision_coincidencia: _dCoin,
      ...resto
    } = cambios;

    const parcheFallback: Record<string, unknown> = { ...resto };
    if (opts && 'reservar' in opts) {
      const baseOriginal = { ...((cambios.datos_originales as Record<string, any>) ?? fila.datos_originales ?? {}) };
      if (opts.reservar) {
        baseOriginal.__reserva = opts.reservar;
      } else {
        delete baseOriginal.__reserva;
      }
      parcheFallback.datos_originales = baseOriginal;
    }

    return ejecutar(parcheFallback);
  }

  /**
   * SIREP-S4-T03: Devuelve la reserva activa del revisor autenticado (si existe y no venció las 4 horas).
   */
  async obtenerMiReserva(
    usuario: { id: string; nombre: string },
    ahoraMs = Date.now(),
  ): Promise<{ reporte: any | null }> {
    const { data, error } = await leerPaginado(() =>
      this.client
        .from('reportes')
        .select(SELECCION)
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('creado_en', { ascending: true })
        .order('id', { ascending: true }),
    );

    if (error) {
      throw new InternalServerErrorException('No se pudo consultar la reserva actual.');
    }

    const filas = (Array.isArray(data) ? data : []) as FilaReporte[];
    const mia = filas.find((f) => reservaActiva(f, ahoraMs) && this.esDuenoDeReserva(f, usuario));
    if (!mia) return { reporte: null };
    return { reporte: await this.obtener(numeroVisible(mia)) };
  }

  /**
   * SIREP-S4-T03: Cola libre con reserva ("Siguiente reporte").
   * - Si el revisor ya tiene una reserva activa (< 4 horas y no cerrada), devuelve esa misma (1 sola reserva por revisor).
   * - Si una reserva lleva >= 4 horas sin cerrarse, se considera vencida y vuelve a la cola.
   * - Entrega el reporte pendiente más antiguo y lo reserva atómicamente a nombre del revisor.
   */
  async tomarSiguienteReporteDeCola(
    usuario: { id: string; nombre: string },
    ahoraMs = Date.now(),
  ): Promise<{
    status: 'asignado' | 'reserva_existente' | 'cola_vacia';
    numero_reporte: string | null;
    mensaje: string;
    reporte: any | null;
  }> {
    const nombreRevisor = (usuario?.nombre || '').trim() || 'Revisor';
    const { data, error } = await leerPaginado(() =>
      this.client
        .from('reportes')
        .select(SELECCION)
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('creado_en', { ascending: true })
        .order('id', { ascending: true }),
    );

    if (error) {
      this.logger.error(`No se pudo consultar la cola de reportes: ${error.message}`);
      throw new InternalServerErrorException('No se pudo consultar la cola de revisión.');
    }

    const filas = (Array.isArray(data) ? data : []) as FilaReporte[];

    // 1. Verificar si el revisor ya tiene una reserva activa (regla: una sola reserva a la vez).
    const reservaPropia = filas.find((f) => {
      if (!reservaActiva(f, ahoraMs) || !this.esDuenoDeReserva(f, usuario)) return false;
      const campos = construirCampos(f.campos_extraidos);
      return campos.some((c) => c.estado_revision === 'pendiente');
    });

    if (reservaPropia) {
      const numero = numeroVisible(reservaPropia);
      return {
        status: 'reserva_existente',
        numero_reporte: numero,
        mensaje: `Ya tienes reservado el reporte N° ${numero}. Termínalo o libéralo antes de tomar otro.`,
        reporte: await this.obtener(numero),
      };
    }

    // 2. Ordenar por antigüedad (creado_en ASC) y filtrar reportes con campos pendientes y sin reserva vigente.
    const candidatos = [...filas]
      .sort((a, b) => Date.parse(a.creado_en) - Date.parse(b.creado_en))
      .filter((f) => {
        if (f.bloqueado || f.estado_reporte === 'aprobado_rptech' || f.estado_reporte === 'cerrado') {
          return false;
        }
        if (reservaActiva(f, ahoraMs)) {
          return false;
        }
        // SIREP-S4-T08: El segundo revisor de una doble revisión debe ser distinto al primero.
        const dobleRev = f.datos_originales?.__doble_revision as
          | { estado?: string; primer_revisor?: string | null; primer_revisor_id?: string | null }
          | undefined;
        if (
          dobleRev?.estado === 'pendiente' &&
          this.esMismoUsuario(dobleRev.primer_revisor, dobleRev.primer_revisor_id, usuario)
        ) {
          return false;
        }
        const campos = construirCampos(f.campos_extraidos);
        return campos.some((c) => c.estado_revision === 'pendiente');
      });

    const ahoraIso = new Date(ahoraMs).toISOString();

    for (const candidato of candidatos) {
      const datosReserva = {
        reservado_por_id: usuario.id || null,
        reservado_por: nombreRevisor,
        reservado_en: ahoraIso,
      };
      const { actualizadas, error: errUpd } = await this.actualizarReporteConFallback(
        candidato,
        datosReserva,
        { actualizadoEn: candidato.actualizado_en, reservar: datosReserva },
      );

      if (errUpd) {
        this.logger.warn(`Fallo reservando reporte ${candidato.id}: ${errUpd.message}`);
        continue;
      }

      // Si otro revisor lo reservó en el mismo instante (actualizado_en cambió), probamos con el siguiente más antiguo.
      if (!actualizadas || actualizadas.length === 0) {
        continue;
      }

      candidato.reservado_por_id = usuario.id || null;
      candidato.reservado_por = nombreRevisor;
      candidato.reservado_en = ahoraIso;

      const numero = numeroVisible(candidato);
      await this.tablero?.registrarEvento({
        usuario_id: usuario.id || null,
        usuario: nombreRevisor,
        reporte: numero,
        tipo_accion: 'tomar',
        creado_en: ahoraIso,
      });
      this.eventos?.emitirCambio('actualizado', numero);

      return {
        status: 'asignado',
        numero_reporte: numero,
        mensaje: `Reporte N° ${numero} reservado a nombre de ${nombreRevisor} por 4 horas.`,
        reporte: await this.obtener(numero),
      };
    }

    return {
      status: 'cola_vacia',
      numero_reporte: null,
      mensaje: 'No hay reportes pendientes disponibles en la cola en este momento.',
      reporte: null,
    };
  }

  /**
   * SIREP-S4-T03: Libera manualmente un reporte reservado para que vuelva a la cola.
   * Puede hacerlo el administrador (cualquier reporte) o el propio revisor dueño de la reserva.
   */
  async liberarReporte(
    numero: string,
    usuario: { id?: string; nombre?: string; rol?: string; roles?: string[]; permisos?: string[] },
    ahoraMs = Date.now(),
  ): Promise<{
    status: 'liberado' | 'sin_reserva';
    numero_reporte: string;
    mensaje: string;
    reporte: any;
  }> {
    const fila = await this.buscarFila(numero);
    const esAdmin =
      esRolAdmin(usuario?.rol, usuario?.roles) || Boolean(usuario?.permisos?.includes('gestionar_usuarios'));

    const resv = reservaDeFila(fila);
    if (reservaActiva(fila, ahoraMs) && !esAdmin && !this.esDuenoDeReserva(fila, usuario)) {
      throw new ForbiddenException(
        `Solo ${resv.reservado_por} o un administrador pueden liberar la reserva del reporte N° ${numero}.`,
      );
    }

    if (!resv.reservado_por && !resv.reservado_en && !resv.reservado_por_id) {
      return {
        status: 'sin_reserva',
        numero_reporte: numero,
        mensaje: `El reporte N° ${numero} no tenía ninguna reserva activa.`,
        reporte: await this.obtener(numero),
      };
    }

    const parcheLimpiar: Record<string, unknown> = {
      reservado_por_id: null,
      reservado_por: null,
      reservado_en: null,
    };
    if (fila.datos_originales?.__reserva) {
      const sinReserva = { ...fila.datos_originales };
      delete sinReserva.__reserva;
      parcheLimpiar.datos_originales = sinReserva;
    }

    const { error } = await this.actualizarReporteConFallback(fila, parcheLimpiar, { reservar: null });

    if (error) {
      this.logger.error(`No se pudo liberar la reserva de ${numero}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo liberar la reserva del reporte.');
    }

    fila.reservado_por_id = null;
    fila.reservado_por = null;
    fila.reservado_en = null;
    if (fila.datos_originales?.__reserva) {
      delete fila.datos_originales.__reserva;
    }

    await this.tablero?.registrarEvento({
      usuario_id: usuario?.id ?? null,
      usuario: usuario?.nombre || 'Revisor',
      reporte: numero,
      tipo_accion: 'liberar',
      creado_en: new Date(ahoraMs).toISOString(),
    });
    this.eventos?.emitirCambio('actualizado', numero);
    return {
      status: 'liberado',
      numero_reporte: numero,
      mensaje: `El reporte N° ${numero} fue liberado y volvió a la cola.`,
      reporte: await this.obtener(numero),
    };
  }

  async obtener(numero: string) {
    const fila = await this.buscarFila(numero);
    const urls = await this.firmarPaginas(fila);
    const vinculos = await this.calcularVinculosSugeridos(fila);
    return aReporteContrato(fila, urls, vinculos);
  }

  /**
   * PDF del reporte con el formato del reporte técnico de RP-TECH y los valores ya revisados
   * (corrección humana > lectura de la IA). Incluye un anexo con el escaneo original; si no se
   * puede descargar el escaneo, el PDF sale igual solo con el formulario.
   */
  async generarPdf(numero: string): Promise<{ buffer: Buffer; filename: string }> {
    const fila = await this.buscarFila(numero);
    const campos = construirCampos(fila.campos_extraidos);
    const numeroReporte = numeroVisible(fila);
    const escaneo = await this.descargarPaginas(fila);
    const logo = await this.leerLogo();
    try {
      const pdf = await generarPdfReporte(
        { numero: numeroReporte, campos, revisadoPor: fila.corregido_por ?? null, revisadoEn: fila.fecha_correccion ?? null },
        escaneo,
        logo,
      );
      return { buffer: Buffer.from(pdf), filename: `Reporte_${numeroReporte.replace(/[^\w.-]/g, '_')}.pdf` };
    } catch (e) {
      this.logger.error(`No se pudo generar el PDF de ${numeroReporte}: ${(e as Error).message}`);
      throw new InternalServerErrorException('No se pudo generar el PDF del reporte.');
    }
  }

  /** Descarga del storage las páginas del escaneo, en orden. Una que falle se omite. */
  private async descargarPaginas(fila: FilaReporte): Promise<Uint8Array[]> {
    const rutas = fila.escaneo?.metadatos?.rutas_paginas?.length
      ? fila.escaneo.metadatos.rutas_paginas
      : fila.escaneo?.ruta_original
        ? [fila.escaneo.ruta_original]
        : [];
    const paginas: Uint8Array[] = [];
    for (const ruta of rutas) {
      const { data, error } = await this.client.storage.from(BUCKET).download(ruta);
      if (error || !data) {
        this.logger.warn(`No se pudo descargar ${ruta} para el PDF: ${error?.message ?? 'sin datos'}`);
        continue;
      }
      paginas.push(new Uint8Array(await data.arrayBuffer()));
    }
    return paginas;
  }

  /** Logo opcional del encabezado: ruta en `PDF_LOGO_PATH`; sin ella se escribe el nombre de la empresa. */
  private async leerLogo(): Promise<Uint8Array | null> {
    const ruta = process.env.PDF_LOGO_PATH?.trim();
    if (!ruta) return null;
    try {
      return new Uint8Array(await readFile(ruta));
    } catch (e) {
      this.logger.warn(`No se pudo leer el logo del PDF (${ruta}): ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * SIREP-S3-T10: Sugerencia de vinculación de cliente, equipo y técnico buscando
   * por similitud en los catálogos y reportes previos.
   */
  async calcularVinculosSugeridos(fila: FilaReporte): Promise<VinculosReporte> {
    const buscarMejor = (texto: string | null | undefined, candidatos: Array<{ id?: string; nombre: string }>): SugerenciaVinculo | null => {
      const limpio = (texto || '').trim();
      if (!limpio || candidatos.length === 0) return null;
      let mejor: SugerenciaVinculo | null = null;
      let mejorSim = 0;
      for (const cand of candidatos) {
        const score = similitudTexto(limpio, cand.nombre);
        if (score >= 0.55 && score > mejorSim) {
          mejorSim = score;
          mejor = { id: cand.id, nombre: cand.nombre, similitud: Math.round(score * 100) / 100 };
        }
      }
      return mejor;
    };

    const dataset = await this.obtenerDatasetClientes();
    const clientesCandidatos: Array<{ id?: string; nombre: string }> = (dataset.clientes ?? []).map((c) => ({
      nombre: c.nombre,
    }));
    const equiposCandidatos: Array<{ id?: string; nombre: string }> = (dataset.valoresConocidos?.equipo ?? []).map((e) => ({
      nombre: e,
    }));
    const tecnicosCandidatos: Array<{ id?: string; nombre: string }> = (dataset.valoresConocidos?.tecnico ?? []).map((t) => ({
      nombre: t,
    }));

    const cargarCatalogo = async (tabla: string, destino: Array<{ id?: string; nombre: string }>) => {
      try {
        const res: any = await this.client.from(tabla).select('id, nombre').eq('empresa_id', EMPRESA_POR_DEFECTO).limit(500);
        if (Array.isArray(res?.data)) {
          for (const item of res.data) {
            if (typeof item?.id === 'string' && typeof item?.nombre === 'string' && item.nombre.trim()) {
              destino.unshift({ id: item.id, nombre: item.nombre.trim() });
            }
          }
        }
      } catch {
        // Si la tabla aún no existe o no aplica en el entorno actual, continúa con el dataset aprendido.
      }
    };

    await Promise.all([
      cargarCatalogo('clientes', clientesCandidatos),
      cargarCatalogo('equipos', equiposCandidatos),
      cargarCatalogo('perfiles', tecnicosCandidatos),
    ]);

    return {
      cliente: buscarMejor(fila.cliente, clientesCandidatos),
      equipo: buscarMejor(fila.serie_equipo, equiposCandidatos),
      tecnico: buscarMejor(fila.tecnico_asignado, tecnicosCandidatos),
    };
  }

  /**
   * SIREP-S3-T10: Guarda vínculos manuales o sugeridos (`cliente_id`, `equipo_id`, `tecnico_perfil_id`)
   * manteniendo intacto el texto manuscrito originalmente leído (`cliente`, `serie_equipo`, `tecnico_asignado`).
   */
  async vincularEntidades(
    numero: string,
    vinculos: { cliente_id?: string | null; equipo_id?: string | null; tecnico_perfil_id?: string | null },
    usuario?: { id?: string; nombre?: string; rol?: string; roles?: string[]; permisos?: string[] },
  ) {
    const fila = await this.buscarFila(numero);
    if (fila.bloqueado || fila.estado_reporte === 'cerrado') {
      throw new ConflictException(`El reporte N° ${numero} está cerrado y bloqueado.`);
    }
    this.validarAccesoReserva(fila, numero, usuario);

    const actualizacion: Record<string, any> = {};
    if (vinculos.cliente_id !== undefined) actualizacion.cliente_id = vinculos.cliente_id || null;
    if (vinculos.equipo_id !== undefined) actualizacion.equipo_id = vinculos.equipo_id || null;
    if (vinculos.tecnico_perfil_id !== undefined) actualizacion.tecnico_perfil_id = vinculos.tecnico_perfil_id || null;

    if (Object.keys(actualizacion).length === 0) {
      throw new BadRequestException('Debe especificar al menos un identificador de vínculo.');
    }

    const { error } = await this.client
      .from('reportes')
      .update(actualizacion)
      .eq('id', fila.id);

    if (error) {
      this.logger.error(`No se pudieron guardar los vínculos de ${numero}: ${error.message}`);
      throw new InternalServerErrorException('No se pudieron guardar los vínculos del reporte.');
    }

    this.eventos?.emitirCambio('actualizado', numero);
    return this.obtener(numero);
  }

  private prepararDobleRevisionSiCorresponde(
    fila: FilaReporte,
    guardados: Record<string, CampoGuardado>,
    camposActuales: CampoContrato[],
    pendientes: string[],
    valores: Record<string, string | null>,
    accionTipo: AccionRevisionDto['tipo'],
    actorRevisor: string,
    usuarioId: string | undefined,
    ahora: string,
  ): {
    parcheExtra: Record<string, unknown>;
    estadoEscaneo?: 'procesado';
    aprobadoParaRptech: boolean;
    dobleRevisionIniciada: boolean;
    dobleRevisionCompletada: boolean;
    datosOriginalesNuevos?: Record<string, any>;
  } {
    if (pendientes.length > 0 || accionTipo === 'reabrir') {
      return {
        parcheExtra: {},
        aprobadoParaRptech: false,
        dobleRevisionIniciada: false,
        dobleRevisionCompletada: false,
      };
    }

    const dobleRevActual = fila.datos_originales?.__doble_revision as any;
    const originalesSinReserva = { ...(fila.datos_originales ?? {}) };
    delete originalesSinReserva.__reserva;

    if (dobleRevActual?.estado === 'pendiente') {
      const coincidencia = calcularCoincidenciaDobleRevision(
        dobleRevActual.valores_primera_revision ?? {},
        valores,
      );
      const datosOriginalesNuevos = {
        ...originalesSinReserva,
        __doble_revision: {
          ...dobleRevActual,
          estado: 'completada',
          segundo_revisor: actorRevisor,
          segundo_revisor_id: usuarioId ?? null,
          completado_en: ahora,
          porcentaje_coincidencia: coincidencia.porcentaje_coincidencia,
          campos_coincidentes: coincidencia.campos_coincidentes,
          campos_totales: coincidencia.campos_totales,
          discrepancias: coincidencia.discrepancias,
        },
      };
      return {
        parcheExtra: {
          doble_revision_estado: 'completada',
          doble_revision_por: actorRevisor,
          doble_revision_coincidencia: coincidencia.porcentaje_coincidencia,
          datos_originales: datosOriginalesNuevos,
        },
        aprobadoParaRptech: true,
        dobleRevisionIniciada: false,
        dobleRevisionCompletada: true,
        datosOriginalesNuevos,
      };
    }

    const veniaPendiente =
      camposActuales.some((c) => c.estado_revision === 'pendiente') ||
      fila.estado_reporte === 'pendiente_revision';

    if (!dobleRevActual?.estado && veniaPendiente && this.selectorDobleRevision() < PROBABILIDAD_DOBLE_REVISION) {
      const guardadosSinRevision: Record<string, CampoGuardado> = {};
      const revisionesPrimera: Record<string, RevisionCampo> = {};

      for (const [k, campo] of Object.entries(guardados)) {
        if (campo?.revision) {
          revisionesPrimera[k] = campo.revision;
          const { revision: _omit, ...limpio } = campo;
          guardadosSinRevision[k] = limpio;
        } else {
          guardadosSinRevision[k] = campo;
        }
      }

      const camposReset = construirCampos(guardadosSinRevision);
      const pendientesReset = camposReset
        .filter((c) => c.estado_revision === 'pendiente')
        .map((c) => c.id);

      if (pendientesReset.length > 0) {
        const valoresReset = Object.fromEntries(camposReset.map((c) => [c.id, valorVigente(c)]));
        const datosOriginalesNuevos = {
          ...originalesSinReserva,
          __doble_revision: {
            estado: 'pendiente',
            primer_revisor: actorRevisor,
            primer_revisor_id: usuarioId ?? null,
            elegido_en: ahora,
            valores_primera_revision: valores,
            revisiones_primera_revision: revisionesPrimera,
          },
        };
        return {
          parcheExtra: {
            campos_extraidos: guardadosSinRevision,
            campos_dudosos: pendientesReset,
            estado_reporte: 'pendiente_revision',
            ...columnasDesdeValores(valoresReset),
            corregido_por: null,
            fecha_correccion: null,
            doble_revision_estado: 'pendiente',
            datos_originales: datosOriginalesNuevos,
          },
          estadoEscaneo: 'procesado',
          aprobadoParaRptech: false,
          dobleRevisionIniciada: true,
          dobleRevisionCompletada: false,
          datosOriginalesNuevos,
        };
      }
    }

    return {
      parcheExtra: fila.datos_originales?.__reserva ? { datos_originales: originalesSinReserva } : {},
      aprobadoParaRptech: true,
      dobleRevisionIniciada: false,
      dobleRevisionCompletada: false,
    };
  }

  private tipoEventoDeAccion(tipo: AccionRevisionDto['tipo']): TipoAccionEvento | null {
    switch (tipo) {
      case 'corregir':
        return 'corregir';
      case 'ilegible':
        return 'marcar_ilegible';
      case 'confirmar':
      case 'omitir':
        return 'confirmar';
      default:
        return null;
    }
  }

  async revisarCampo(
    numero: string,
    campoId: string,
    accion: AccionRevisionDto,
    usuario?: { id?: string; nombre?: string; rol?: string; roles?: string[]; permisos?: string[] },
  ) {
    if (!IDS_CAMPOS_FORMULARIO.includes(campoId)) {
      throw new NotFoundException(`El formulario no tiene el campo "${campoId}".`);
    }

    const fila = await this.buscarFila(numero);
    const estaBloqueado =
      fila.bloqueado === true || fila.estado_reporte === 'aprobado_rptech' || fila.estado_reporte === 'cerrado';
    if (estaBloqueado && accion.tipo !== 'reabrir') {
      throw new ConflictException(`El reporte histórico N° ${numero} ya está cerrado y bloqueado. Reabre el campo antes de editarlo.`);
    }
    this.validarAccesoReserva(fila, numero, usuario);

    const dobleRevActual = fila.datos_originales?.__doble_revision as any;
    if (
      dobleRevActual?.estado === 'pendiente' &&
      !esRolAdmin(usuario?.rol, usuario?.roles) &&
      this.esMismoUsuario(dobleRevActual.primer_revisor, dobleRevActual.primer_revisor_id, usuario)
    ) {
      throw new ConflictException(
        `El reporte N° ${numero} fue seleccionado para doble revisión a ciegas; debe revisarlo un técnico distinto a ${dobleRevActual.primer_revisor}.`,
      );
    }

    // Un reporte que RP-TECH ya guardó no se reabre: allá entra cerrado y no se modifica,
    // así que una corrección aquí ya no llegaría y las dos bases quedarían distintas.
    if (accion.tipo === 'reabrir' && fila.rptech_id) {
      throw new ConflictException(`El reporte N° ${numero} ya está en RP-TECH y no se puede reabrir.`);
    }

    const guardados: Record<string, CampoGuardado> = { ...(fila.campos_extraidos ?? {}) };
    const camposActuales = construirCampos(guardados);
    const actual = camposActuales.find((c) => c.id === campoId) as CampoContrato;
    const pendiente = actual.estado_revision === 'pendiente';

    if (accion.tipo === 'reabrir') {
      if (pendiente || actual.estado_revision === 'auto') {
        throw new ConflictException(`El campo "${campoId}" no está resuelto.`);
      }
    } else if (accion.tipo === 'confirmar' && !pendiente) {
      throw new ConflictException(`El campo "${campoId}" no está pendiente de revisión.`);
    }

    const valorNuevo = accion.valor?.trim() ?? '';
    if (accion.tipo === 'corregir' && valorNuevo === '') {
      throw new BadRequestException('La corrección no puede quedar vacía.');
    }

    const actorRevisor = accion.actor?.trim() || 'revisor';
    const accionConActor: AccionRevisionDto = { ...accion, actor: actorRevisor };

    const ahora = new Date().toISOString();
    const base: CampoGuardado = guardados[campoId] ?? {
      clave: campoId,
      valor: null,
      confianza: 'baja',
      noLeido: true,
      dudoso: true,
    };
    const revision = this.aplicarAccion(accionConActor, valorNuevo, ahora, base);
    guardados[campoId] = { ...base, revision };

    const camposNuevos = construirCampos(guardados);
    const estado = derivarEstado(camposNuevos);
    const pendientes = camposNuevos.filter((c) => c.estado_revision === 'pendiente').map((c) => c.id);

    // Las columnas consultables reflejan el valor vigente (el corregido), no el que leyó el modelo.
    const valores = Object.fromEntries(camposNuevos.map((c) => [c.id, valorVigente(c)]));

    const cierreInfo = this.prepararDobleRevisionSiCorresponde(
      fila,
      guardados,
      camposActuales,
      pendientes,
      valores,
      accion.tipo,
      actorRevisor,
      usuario?.id,
      ahora,
    );

    const parcheActualizacion: Record<string, unknown> = {
      campos_extraidos: guardados,
      campos_dudosos: pendientes,
      estado_reporte: pendientes.length === 0 ? 'aprobado' : 'pendiente_revision',
      ...(accion.tipo === 'reabrir' ? { bloqueado: false } : {}),
      ...(pendientes.length === 0
        ? { reservado_por_id: null, reservado_por: null, reservado_en: null }
        : {}),
      ...columnasDesdeValores(valores),
      ...(accion.tipo === 'corregir' ? { corregido_por: actorRevisor, fecha_correccion: ahora } : {}),
      ...cierreInfo.parcheExtra,
    };

    const { actualizadas, error } = await this.actualizarReporteConFallback(
      fila,
      parcheActualizacion,
      {
        actualizadoEn: fila.actualizado_en,
        ...(pendientes.length === 0 ? { reservar: null } : {}),
      },
    );

    if (error) {
      this.logger.error(`No se pudo guardar la revisión de ${campoId}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo guardar la revisión.');
    }
    if (!actualizadas || actualizadas.length === 0) {
      throw new ConflictException('El reporte cambió mientras lo revisabas. Recarga e inténtalo de nuevo.');
    }

    const tipoEv = this.tipoEventoDeAccion(accion.tipo);
    if (tipoEv) {
      await this.tablero?.registrarEvento({
        usuario_id: usuario?.id ?? null,
        usuario: actorRevisor,
        reporte: numero,
        campo: campoId,
        tipo_accion: tipoEv,
        detalle: accion.tipo === 'omitir' ? { modo: 'omitir' } : {},
        creado_en: ahora,
      });
    }

    if (pendientes.length === 0 && accion.tipo !== 'reabrir') {
      await this.tablero?.registrarEvento({
        usuario_id: usuario?.id ?? null,
        usuario: actorRevisor,
        reporte: numero,
        campo: null,
        tipo_accion: 'cerrar',
        detalle: {
          doble_revision_iniciada: cierreInfo.dobleRevisionIniciada,
          doble_revision_completada: cierreInfo.dobleRevisionCompletada,
        },
        creado_en: ahora,
      });
    }

    const estadoEscaneoFinal = cierreInfo.estadoEscaneo ?? estado;
    if (fila.escaneo?.id) {
      const { error: errorEscaneo } = await this.client
        .from('escaneos')
        .update({ estado: estadoEscaneoFinal })
        .eq('id', fila.escaneo.id);
      if (errorEscaneo) {
        this.logger.warn(`No se pudo sincronizar el estado del escaneo: ${errorEscaneo.message}`);
      }
    }

    if (accion.tipo === 'corregir' || accion.tipo === 'confirmar') {
      await this.sincronizarDatasetConEdicion(campoId, accion, valorNuevo, base, valores);
    }

    // SIREP-S4-T10: Envío automático a RP-TECH al aprobar el reporte en la bandeja.
    if (
      cierreInfo.aprobadoParaRptech &&
      fila.origen === 'historico' &&
      !fila.rptech_id &&
      this.rptech?.configurado()
    ) {
      const filaParaEnvio: FilaReporte = {
        ...fila,
        campos_extraidos: guardados,
        estado_reporte: 'aprobado',
        ...columnasDesdeValores(valores),
        ...(cierreInfo.datosOriginalesNuevos ? { datos_originales: cierreInfo.datosOriginalesNuevos } : {}),
      };
      try {
        const resEnvio = await this.rptech.enviar(filaParaEnvio);
        if (resEnvio.estado === 'clave_invalida') {
          await this.client
            .from('reportes')
            .update({
              rptech_error: {
                codigo: 'clave_invalida',
                detalle: 'RP-TECH rechazó la clave de SIREP. Revisa RPTECH_CLAVE.',
              },
              rptech_enviado_en: ahora,
            })
            .eq('id', fila.id);
        }
      } catch (errEnvio: any) {
        this.logger.warn(`Error en envío automático a RP-TECH de ${numero}: ${errEnvio?.message}`);
      }
    }

    this.eventos?.emitirCambio('actualizado', numero);
    return this.obtener(numero);
  }

  private exigirEnvio(): RptechService {
    if (!this.rptech?.configurado()) {
      throw new ServiceUnavailableException('Falta configurar el envío a RP-TECH (RPTECH_URL y RPTECH_CLAVE).');
    }
    return this.rptech;
  }

  /**
   * SIREP-S3-T11: Contrato de importación idempotente.
   * Recibe un reporte revisado y garantiza que múltiples invocaciones no dupliquen
   * registros ni corrompan el estado.
   */
  async importarReporteRevisado(numero: string, usuario = 'sistema'): Promise<{
    status: 'ya_importado' | 'importado_exitoso';
    numero_reporte: string;
    mensaje: string;
    reporte: any;
  }> {
    const fila = await this.buscarFila(numero);
    const campos = construirCampos(fila.campos_extraidos);
    const pendientes = campos.filter((c) => c.estado_revision === 'pendiente');

    if (pendientes.length > 0) {
      throw new BadRequestException(
        `El reporte N° ${numero} aún tiene ${pendientes.length} campo(s) pendiente(s) de revisión.`,
      );
    }

    if (fila.bloqueado || fila.estado_reporte === 'cerrado' || fila.estado_reporte === 'aprobado_rptech') {
      const actual = await this.obtener(numero);
      return {
        status: 'ya_importado',
        numero_reporte: numero,
        mensaje: `El reporte N° ${numero} ya se encontraba cerrado e importado previamente.`,
        reporte: actual,
      };
    }

    if (fila.origen !== 'historico') {
      throw new BadRequestException(`El reporte N° ${numero} no es histórico: no se envía a RP-TECH.`);
    }

    // Solo se marca como importado cuando RP-TECH confirma que lo guardó.
    // Los vínculos con las tablas de SIREP no se envían: sus ids no existen en RP-TECH.
    const resultado = await this.exigirEnvio().enviar(fila);
    if (resultado.estado === 'clave_invalida') {
      throw new ServiceUnavailableException('RP-TECH rechazó la clave de SIREP. Revisa RPTECH_CLAVE.');
    }
    if (resultado.estado === 'reintentar') {
      throw new ServiceUnavailableException(`No se pudo enviar a RP-TECH; se reintentará. ${resultado.detalle}`);
    }
    if (resultado.estado === 'observado') {
      this.eventos?.emitirCambio('actualizado', numero);
      throw new ConflictException({
        message: `RP-TECH no aceptó el reporte N° ${numero}. Corrígelo en la bandeja y vuelve a enviarlo.`,
        codigo: resultado.codigo,
        detalle: resultado.detalle,
      });
    }

    this.eventos?.emitirCambio('actualizado', numero);
    const actualizado = await this.obtener(numero);

    return {
      status: resultado.yaExistia ? 'ya_importado' : 'importado_exitoso',
      numero_reporte: numero,
      mensaje: `Reporte N° ${numero} guardado en RP-TECH y cerrado.`,
      reporte: actualizado,
    };
  }

  /**
   * SIREP-S3-T13: Pasa en lote los reportes ya revisados (sin campos pendientes) a estado
   * cerrado/importado en producción sin volver a escanearlos ni consumir tokens de IA.
   */
  async importarReportesRevisadosEnLote(usuario = 'sistema'): Promise<{
    totalRevisadosListos: number;
    importadosNuevos: number;
    yaImportados: number;
    pendientesOmitidos: number;
    numerosImportados: string[];
    observados: string[];
    porReintentar: string[];
  }> {
    const rptech = this.exigirEnvio();
    const { data, error } = await leerPaginado(() =>
      this.client
        .from('reportes')
        .select(SELECCION)
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('creado_en', { ascending: true })
        .order('id', { ascending: true }),
    );

    if (error) {
      this.logger.error(`No se pudieron cargar los reportes para lote: ${error.message}`);
      throw new InternalServerErrorException('No se pudieron cargar los reportes para importación en lote.');
    }

    const filas = (Array.isArray(data) ? data : []) as FilaReporte[];
    let totalRevisadosListos = 0;
    let importadosNuevos = 0;
    let yaImportados = 0;
    let pendientesOmitidos = 0;
    const numerosImportados: string[] = [];
    const observados: string[] = [];
    const porReintentar: string[] = [];
    void usuario;

    for (const fila of filas) {
      if (fila.origen !== 'historico') continue;
      const campos = construirCampos(fila.campos_extraidos);
      const tienePendientes = campos.some((c) => c.estado_revision === 'pendiente');
      if (tienePendientes) {
        pendientesOmitidos++;
        continue;
      }

      totalRevisadosListos++;
      if (fila.bloqueado || fila.estado_reporte === 'aprobado_rptech' || fila.estado_reporte === 'cerrado') {
        yaImportados++;
        continue;
      }

      const numero = numeroVisible(fila);
      const resultado = await rptech.enviar(fila);
      if (resultado.estado === 'clave_invalida') {
        throw new ServiceUnavailableException('RP-TECH rechazó la clave de SIREP. Revisa RPTECH_CLAVE.');
      }
      if (resultado.estado === 'observado') {
        observados.push(numero);
        this.eventos?.emitirCambio('actualizado', numero);
        continue;
      }
      if (resultado.estado === 'reintentar') {
        porReintentar.push(numero);
        continue;
      }
      if (resultado.yaExistia) {
        yaImportados++;
        this.eventos?.emitirCambio('actualizado', numero);
        continue;
      }

      importadosNuevos++;
      numerosImportados.push(numero);
      this.eventos?.emitirCambio('actualizado', numero);
    }

    return {
      totalRevisadosListos,
      importadosNuevos,
      yaImportados,
      pendientesOmitidos,
      numerosImportados,
      observados,
      porReintentar,
    };
  }

  /**
   * SIREP-S3-T18: Genera métricas agregadas por campo (confirmados, corregidos, ilegibles, omitidos y
   * confianza declarada) sin incluir ningún dato de clientes.
   */
  async obtenerMetricasCampos(): Promise<{
    fecha: string;
    totalReportes: number;
    metricas: Array<{
      campo: string;
      total: number;
      confirmados: number;
      corregidos: number;
      ilegibles: number;
      confianza_declarada: string;
      omitidos: number;
    }>;
    csv: string;
  }> {
    const { data, error } = await leerPaginado(() =>
      this.client
        .from('reportes')
        .select('campos_extraidos')
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('id', { ascending: true }),
    );

    if (error) {
      this.logger.error(`No se pudieron calcular métricas por campo: ${error.message}`);
      throw new InternalServerErrorException('No se pudieron calcular las métricas por campo.');
    }

    const filas = Array.isArray(data) ? data : [];
    const contadores = new Map<
      string,
      { total: number; confirmados: number; corregidos: number; ilegibles: number; omitidos: number; alta: number; media: number; baja: number }
    >();

    for (const id of IDS_CAMPOS_FORMULARIO) {
      contadores.set(id, { total: 0, confirmados: 0, corregidos: 0, ilegibles: 0, omitidos: 0, alta: 0, media: 0, baja: 0 });
    }

    for (const fila of filas) {
      const campos = construirCampos((fila as any)?.campos_extraidos);
      for (const c of campos) {
        const entry = contadores.get(c.id);
        if (!entry) continue;
        entry.total++;
        if (c.estado_revision === 'confirmado' || c.estado_revision === 'auto') {
          entry.confirmados++;
        } else if (c.estado_revision === 'corregido') {
          entry.corregidos++;
        } else if (c.estado_revision === 'omitido') {
          entry.omitidos++;
        } else if (c.estado_revision === 'ilegible' || c.no_leido) {
          entry.ilegibles++;
        }
        if (c.confianza === 'alta') entry.alta++;
        else if (c.confianza === 'media') entry.media++;
        else if (c.confianza === 'baja') entry.baja++;
      }
    }

    const metricas = IDS_CAMPOS_FORMULARIO.map((campo) => {
      const c = contadores.get(campo)!;
      return {
        campo,
        total: c.total,
        confirmados: c.confirmados,
        corregidos: c.corregidos,
        ilegibles: c.ilegibles,
        confianza_declarada: `alta:${c.alta}|media:${c.media}|baja:${c.baja}`,
        omitidos: c.omitidos,
      };
    });

    const lineas = [
      'campo,total,confirmados,corregidos,ilegibles,confianza_declarada,omitidos',
      ...metricas.map(
        (m) => `${m.campo},${m.total},${m.confirmados},${m.corregidos},${m.ilegibles},${m.confianza_declarada},${m.omitidos}`,
      ),
    ];

    return {
      fecha: new Date().toISOString().slice(0, 10),
      totalReportes: filas.length,
      metricas,
      csv: `${lineas.join('\n')}\n`,
    };
  }

  /**
   * SIREP-S3-T05: Exportación a Excel (.xlsx o .csv con BOM UTF-8) con todos los campos,
   */
  async exportarReportes(formato: 'xlsx' | 'csv' = 'xlsx'): Promise<{
    buffer: Buffer;
    contentType: string;
    filename: string;
    totalReportes: number;
    columnas: string[];
  }> {
    const { data, error } = await leerPaginado(() =>
      this.client
        .from('reportes')
        .select(SELECCION)
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('creado_en', { ascending: false })
        .order('id', { ascending: true }),
    );

    if (error) {
      this.logger.error(`No se pudieron exportar los reportes: ${error.message}`);
      throw new InternalServerErrorException('No se pudieron exportar los reportes.');
    }

    const filas = (Array.isArray(data) ? data : []) as FilaReporteExportable[];
    const fechaHoy = new Date().toISOString().slice(0, 10);
    const columnas = COLUMNAS_EXPORTACION_RPTECH.map((c) => c.columna);

    if (formato === 'csv') {
      const csv = generarCsvReportes(filas);
      return {
        buffer: Buffer.from(csv, 'utf-8'),
        contentType: 'text/csv; charset=utf-8',
        filename: `reportes_sirep_${fechaHoy}.csv`,
        totalReportes: filas.length,
        columnas,
      };
    }

    const xlsx = generarExcelReportes(filas);
    return {
      buffer: xlsx,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `reportes_sirep_${fechaHoy}.xlsx`,
      totalReportes: filas.length,
      columnas,
    };
  }

  /**
   * Devuelve el dataset actualizable de clientes, direcciones de locales y usuarios registrados en `contacto`,
   * combinando el archivo portable (`data/dataset-clientes.json`) con la base de datos conectada.
   */
  async obtenerDatasetClientes() {
    try {
      const { data } = await this.client
        .from('reportes')
        .select('cliente, tecnico_asignado, serie_equipo, direccion, contacto, telefono, operador, campos_extraidos')
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .order('actualizado_en', { ascending: false })
        .limit(100);
      const filas = Array.isArray(data) ? data : [];
      return construirContextoDesdeReportes(filas as any);
    } catch {
      return construirContextoDesdeReportes([]);
    }
  }

  /**
   * Actualiza el dataset portable (`data/dataset-clientes.json`) y la tabla `dataset_clientes` (si está disponible)
   * con cada edición o confirmación en la bandeja, guardando el cliente, la dirección del local y el usuario de contacto.
   */
  private async sincronizarDatasetConEdicion(
    campoId: string,
    accion: AccionRevisionDto,
    valorNuevo: string,
    base: CampoGuardado,
    valores: Record<string, string | null>,
  ) {
    const valorOriginal = typeof base.valor === 'string' ? base.valor.trim() : null;
    const datasetActualizado = registrarEdicionEnDataset({
      empresa: valores.empresa,
      direccion: valores.direccion,
      contacto: valores.contacto,
      telefono: valores.telefono,
      tecnico: valores.tecnico,
      equipo: valores.equipo,
      operador: valores.operador,
      correccion:
        accion.tipo === 'corregir' && valorNuevo
          ? {
              campo: campoId,
              valorErroneo: valorOriginal,
              valorCorregido: valorNuevo,
            }
          : null,
    });

    if (!valores.empresa) return;

    try {
      const normEmpresa = normalizarTexto(valores.empresa);
      const clienteEnDataset = datasetActualizado.clientes.find(
        (c) => normalizarTexto(c.nombre) === normEmpresa,
      );
      if (!clienteEnDataset) return;

      const tablaDataset: any = this.client.from('dataset_clientes');
      if (typeof tablaDataset?.upsert === 'function') {
        await tablaDataset.upsert(
          {
            empresa_id: EMPRESA_POR_DEFECTO,
            clave_normalizada: normEmpresa,
            nombre_cliente: clienteEnDataset.nombre,
            direcciones: clienteEnDataset.direcciones,
            contactos: clienteEnDataset.contactos,
            direccion_por_contacto: clienteEnDataset.direccionPorContacto ?? {},
            correcciones: datasetActualizado.correcciones.slice(0, 60),
          },
          { onConflict: 'empresa_id,clave_normalizada' },
        );
      }
    } catch {
      // Si la base original aún no tiene la tabla `dataset_clientes`, el dataset portable en disco y memoria ya guardó el cambio.
    }
  }

  private aplicarAccion(
    accion: AccionRevisionDto,
    valor: string,
    ahora: string,
    base: CampoGuardado,
  ): RevisionCampo {
    const estadoAlReabrir = campoRequiereRevision(base) ? 'pendiente' : 'auto';
    const vacia: RevisionCampo = {
      estado: estadoAlReabrir,
      valor_corregido: null,
      revisado_por: null,
      revisado_en: null,
      corregido_por: null,
      corregido_en: null,
    };
    const actor = accion.actor?.trim() || 'revisor';
    switch (accion.tipo) {
      case 'confirmar':
        return { ...vacia, estado: 'confirmado', revisado_por: actor, revisado_en: ahora };
      case 'ilegible':
        return { ...vacia, estado: 'ilegible', revisado_por: actor, revisado_en: ahora };
      // "Omitir" = el campo estaba vacío en el papel. Solo lo hace una persona; nunca se aplica solo.
      case 'omitir':
        return { ...vacia, estado: 'omitido', revisado_por: actor, revisado_en: ahora };
      case 'corregir':
        return {
          estado: 'corregido',
          valor_corregido: valor,
          revisado_por: actor,
          revisado_en: ahora,
          corregido_por: actor,
          corregido_en: ahora,
        };
      case 'reabrir':
        return vacia;
    }
  }

  /** Busca por N° de talonario; los reportes sin N° se abren con `SN-` + inicio de su id. */
  private async buscarFila(numero: string): Promise<FilaReporte> {
    const limpio = numero.trim();
    const sinNumero = limpio.match(/^SN-([0-9a-f]{8})$/i);

    if (sinNumero) {
      const { data, error } = await this.client
        .from('reportes')
        .select(SELECCION)
        .eq('empresa_id', EMPRESA_POR_DEFECTO)
        .is('numero_talonario', null);
      if (error) throw new InternalServerErrorException('No se pudo buscar el reporte.');
      const fila = (data as FilaReporte[] | null)?.find((f) => f.id.startsWith(sinNumero[1].toLowerCase()));
      if (!fila) throw new NotFoundException(`No existe el reporte N° ${limpio}.`);
      return fila;
    }

    const { data, error } = await this.client
      .from('reportes')
      .select(SELECCION)
      .eq('empresa_id', EMPRESA_POR_DEFECTO)
      .eq('numero_talonario', limpio)
      .order('creado_en', { ascending: false })
      .limit(1);

    if (error) {
      this.logger.error(`No se pudo buscar el reporte ${limpio}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo buscar el reporte.');
    }
    const fila = (data as FilaReporte[] | null)?.[0];
    if (!fila) throw new NotFoundException(`No existe el reporte N° ${limpio}.`);
    return fila;
  }

  private async firmarPaginas(fila: FilaReporte): Promise<string[]> {
    const rutas = fila.escaneo?.metadatos?.rutas_paginas?.length
      ? fila.escaneo.metadatos.rutas_paginas
      : fila.escaneo?.ruta_original
        ? [fila.escaneo.ruta_original]
        : [];
    if (rutas.length === 0) return [];

    const { data, error } = await this.client.storage.from(BUCKET).createSignedUrls(rutas, VIGENCIA_ENLACES_SEG);
    if (error || !data) {
      this.logger.warn(`No se pudieron firmar las imágenes del reporte ${fila.id}: ${error?.message}`);
      return [];
    }
    // Se conserva el orden de las páginas; una ruta que falló queda fuera en lugar de romper el visor.
    return data.map((d) => d.signedUrl).filter((u): u is string => Boolean(u));
  }
}