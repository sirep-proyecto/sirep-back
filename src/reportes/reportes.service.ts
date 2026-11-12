import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { EventosGateway } from '../realtime/eventos.gateway';
import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { EMPRESA_POR_DEFECTO } from '../escaneos/escaneos.service';
import {
  cargarDatasetPersistente,
  construirContextoDesdeReportes,
  normalizarTexto,
  registrarEdicionEnDataset,
} from '../ia-extractor/normalizacion';
import { AccionRevisionDto } from './dto/accion-revision.dto';
import { columnasDesdeValores } from './reportes.columnas';
import {
  COLUMNAS_EXPORTACION_RPTECH,
  FilaReporteExportable,
  generarCsvReportes,
  generarExcelReportes,
} from './reportes.excel';
import {
  CampoGuardado,
  CampoContrato,
  FilaReporte,
  RevisionCampo,
  aReporteContrato,
  campoRequiereRevision,
  construirCampos,
  derivarEstado,
  valorVigente,
} from './reportes.mapper';

const BUCKET = 'escaneos-originales';
// Las imágenes se piden a Storage con un enlace firmado y temporal: el bucket es privado porque son datos de clientes.
const VIGENCIA_ENLACES_SEG = 60 * 60;

// Sin `metadatos` completo: trae la salida cruda del modelo y no hace falta para listar.
const SELECCION =
  '*, escaneo:escaneos(id, ruta_original, paginas, enviado_por, estado, creado_en, metadatos)';

@Injectable()
export class ReportesService {
  private readonly logger = new Logger(ReportesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    // Opcional para que las pruebas unitarias no necesiten el canal en vivo
    @Optional() private readonly eventos?: EventosGateway,
  ) { }

  private get client() {
    return this.supabase.getClient();
  }

  async listar(limite = 1000) {
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
    // En la lista no se firman enlaces de imagen: el visor los pide al abrir un reporte.
    return (data as FilaReporte[]).map((fila) => aReporteContrato(fila));
  }

  async obtener(numero: string) {
    const fila = await this.buscarFila(numero);
    const urls = await this.firmarPaginas(fila);
    return aReporteContrato(fila, urls);
  }

  async revisarCampo(numero: string, campoId: string, accion: AccionRevisionDto) {
    if (!IDS_CAMPOS_FORMULARIO.includes(campoId)) {
      throw new NotFoundException(`El formulario no tiene el campo "${campoId}".`);
    }

    const fila = await this.buscarFila(numero);
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

    const { data: actualizadas, error } = await this.client
      .from('reportes')
      .update({
        campos_extraidos: guardados,
        campos_dudosos: pendientes,
        estado_reporte: pendientes.length === 0 ? 'aprobado' : 'pendiente_revision',
        ...columnasDesdeValores(valores),
        ...(accion.tipo === 'corregir' ? { corregido_por: actorRevisor, fecha_correccion: ahora } : {}),
      })
      .eq('id', fila.id)
      // Control de concurrencia: si otra persona guardó en el medio, `actualizado_en` ya cambió y no se pisa su trabajo.
      .eq('actualizado_en', fila.actualizado_en)
      .select('id');

    if (error) {
      this.logger.error(`No se pudo guardar la revisión de ${campoId}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo guardar la revisión.');
    }
    if (!actualizadas || actualizadas.length === 0) {
      throw new ConflictException('El reporte cambió mientras lo revisabas. Recarga e inténtalo de nuevo.');
    }

    if (fila.escaneo?.id) {
      const { error: errorEscaneo } = await this.client
        .from('escaneos')
        .update({ estado })
        .eq('id', fila.escaneo.id);
      if (errorEscaneo) {
        this.logger.warn(`No se pudo sincronizar el estado del escaneo: ${errorEscaneo.message}`);
      }
    }

    if (accion.tipo === 'corregir' || accion.tipo === 'confirmar') {
      await this.sincronizarDatasetConEdicion(campoId, accion, valorNuevo, base, valores);
    }

    this.eventos?.emitirCambio('actualizado', numero);

    return this.obtener(numero);
  }

  /**
   * SIREP-S3-T05: Exportación a Excel (.xlsx o .csv con BOM UTF-8) con todos los campos,
   * los 10 vitales primero, y nombres de columna acordados con RP-TECH.
   */
  async exportarReportes(formato: 'xlsx' | 'csv' = 'xlsx'): Promise<{
    buffer: Buffer;
    contentType: string;
    filename: string;
    totalReportes: number;
    columnas: string[];
  }> {
    const { data, error } = await this.client
      .from('reportes')
      .select(SELECCION)
      .eq('empresa_id', EMPRESA_POR_DEFECTO)
      .order('creado_en', { ascending: false })
      .limit(2000);

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