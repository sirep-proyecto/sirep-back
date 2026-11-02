import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { crearLectorDeReportes } from '../ia-extractor/ia-extractor.factory';
import {
  CampoEsperado,
  LectorDeReportes,
  ResultadoLectura,
} from '../ia-extractor/types';
import {
  calcularHuellaSHA256,
  extraerNumeroReporte,
  optimizarParaIA,
  procesarPaginasPDF,
} from './escaneos.util';

export class EscaneoDuplicadoError extends ConflictException {
  constructor(
    public readonly tipoDuplicado: 'archivo_duplicado' | 'reporte_duplicado',
    mensaje: string,
    public readonly datosExtra?: Record<string, any>,
  ) {
    super(mensaje);
  }
}

export interface ProcesarEscaneoInput {
  buffer: Buffer;
  filename?: string;
  caption?: string;
  mimetype?: string;
  enviadoPor?: string;
  telegramChatId?: number;
  empresaId?: string;
}

export interface ResultadoProcesamientoEscaneo {
  escaneoId: string;
  numeroReporte: string;
  estado: 'recibido' | 'procesado' | 'en_revision' | 'completo';
  campos: Record<string, any>;
  camposDudosos: string[];
  totalPaginas: number;
  huella: string;
  rutasPaginas: string[];
  metricasIA: {
    tokensEntrada: number;
    tokensSalida: number;
    costoUsd: number;
    latenciaMs: number;
    proveedor: string;
    modelo: string;
  };
}

@Injectable()
export class EscaneosService {
  private readonly logger = new Logger(EscaneosService.name);
  private lectorIA: LectorDeReportes | null = null;

  // Campos oficiales del formulario físico de GO Service Latam (Guía pág. 12-13)
  readonly camposFormulario: CampoEsperado[] = [
    { clave: 'tecnico', tipo: 'texto', descripcion: 'Nombre del técnico' },
    { clave: 'empresa', tipo: 'texto', descripcion: 'Nombre del cliente o empresa atendida' },
    { clave: 'fecha', tipo: 'fecha', descripcion: 'Fecha de atención en el reporte' },
    { clave: 'direccion', tipo: 'texto', descripcion: 'Dirección de la empresa' },
    { clave: 'equipo', tipo: 'texto', descripcion: 'Modelo y marca del equipo técnico' },
    { clave: 'motivo', tipo: 'texto', descripcion: 'Motivo de la orden de servicio' },
    { clave: 'estado_del_equipo', tipo: 'casilla', descripcion: 'Operativo o Inoperativo' },
    { clave: 'procedimiento', tipo: 'texto', descripcion: 'Descripción detallada del trabajo realizado' },
    { clave: 'conclusion', tipo: 'texto', descripcion: 'Conclusión técnica final' },
    { clave: 'recomendaciones', tipo: 'texto', descripcion: 'Recomendaciones para el cliente' },
    { clave: 'codigo_repuesto', tipo: 'texto', descripcion: 'Código o número de parte de repuestos usados' },
    { clave: 'hora_llegada', tipo: 'hora', descripcion: 'Hora de ingreso del técnico' },
    { clave: 'hora_salida', tipo: 'hora', descripcion: 'Hora de salida del técnico' },
  ];

  constructor(private readonly supabase: SupabaseService) {
    try {
      this.lectorIA = crearLectorDeReportes();
      this.logger.log(`Lector de IA inicializado: ${this.lectorIA.nombre} (${this.lectorIA.modelo})`);
    } catch (err: any) {
      this.logger.warn(`No se pudo inicializar LectorDeReportes al inicio: ${err?.message}`);
    }
  }

  private get client() {
    return this.supabase.getClient();
  }

  setLectorIA(lector: LectorDeReportes) {
    this.lectorIA = lector;
  }

  async procesarEscaneo(input: ProcesarEscaneoInput): Promise<ResultadoProcesamientoEscaneo> {
    const { buffer, filename, caption, mimetype = 'application/pdf', enviadoPor, telegramChatId } = input;
    const empresaId = input.empresaId || '00000000-0000-0000-0000-000000000000';

    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('El archivo enviado está vacío.');
    }

    // 1. Huella SHA-256 del archivo escaneado original
    const huella = calcularHuellaSHA256(buffer);

    // 2. Control de duplicados Nivel 1: Huella de archivo
    const { data: escaneoPorHuella } = await this.client
      .from('escaneos')
      .select('id, numero_reporte')
      .eq('huella', huella)
      .maybeSingle();

    if (escaneoPorHuella) {
      throw new EscaneoDuplicadoError(
        'archivo_duplicado',
        'Este archivo ya fue enviado anteriormente.',
        { escaneoId: escaneoPorHuella.id, numeroReporte: escaneoPorHuella.numero_reporte },
      );
    }

    // 3. Obtener número de reporte preliminar (del texto de Telegram o nombre de archivo)
    let numeroReporte = extraerNumeroReporte(caption) || extraerNumeroReporte(filename);

    // 4. Control de duplicados Nivel 2: N° de reporte impreso en talonario
    if (numeroReporte) {
      const { data: escaneoPorNumero } = await this.client
        .from('escaneos')
        .select('id, numero_reporte')
        .eq('empresa_id', empresaId)
        .eq('numero_reporte', numeroReporte)
        .maybeSingle();

      if (escaneoPorNumero) {
        throw new EscaneoDuplicadoError(
          'reporte_duplicado',
          `El reporte N° ${numeroReporte} ya se encuentra registrado.`,
          { numeroReporte },
        );
      }
    }

    // 5. Procesar páginas si es PDF (Guía pág. 10: "Un PDF de dos páginas queda guardado con su original y sus páginas")
    let totalPaginas = 1;
    let paginasBuffers: Buffer[] = [buffer];
    if (mimetype === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
      const infoPdf = await procesarPaginasPDF(buffer);
      totalPaginas = infoPdf.totalPaginas;
      paginasBuffers = infoPdf.paginas;
    }

    // 6. Guardar archivo original intacto sin comprimir en Storage
    const timestamp = Date.now();
    const ext = filename?.includes('.') ? filename.split('.').pop() : 'pdf';
    const rutaOriginal = `${empresaId}/${timestamp}_${numeroReporte || 'sin_num'}_orig.${ext}`;

    const { error: errorStorageOriginal } = await this.client.storage
      .from('escaneos-originales')
      .upload(rutaOriginal, buffer, { contentType: mimetype, upsert: false });

    if (errorStorageOriginal) {
      this.logger.error(`Error guardando archivo original en Storage: ${errorStorageOriginal.message}`);
      throw new InternalServerErrorException(
        `No se pudo almacenar el archivo original en Storage: ${errorStorageOriginal.message}`,
      );
    }

    // Guardar las páginas individuales
    const rutasPaginas: string[] = [];
    for (let p = 0; p < paginasBuffers.length; p++) {
      const rutaPag = `${empresaId}/${timestamp}_${numeroReporte || 'sin_num'}_pag_${p + 1}.${ext}`;
      rutasPaginas.push(rutaPag);
      const { error: errorStoragePagina } = await this.client.storage
        .from('escaneos-originales')
        .upload(rutaPag, paginasBuffers[p], { contentType: mimetype, upsert: false });

      if (errorStoragePagina) {
        this.logger.warn(`Advertencia al guardar página ${p + 1} en Storage: ${errorStoragePagina.message}`);
      }
    }

    // 7. Preparar copia comprimida para el modelo de IA
    const { buffer: bufferIA, mimetype: mimetypeIA } = await optimizarParaIA(buffer, mimetype);

    // 8. Lectura de campos con el modelo multimodal
    if (!this.lectorIA) {
      this.lectorIA = crearLectorDeReportes();
    }

    let resultadoLectura: ResultadoLectura;
    try {
      resultadoLectura = await this.lectorIA.leer(bufferIA, mimetypeIA, this.camposFormulario);
    } catch (err: any) {
      this.logger.error(`Error en la extracción con IA: ${err?.message}`);
      throw new BadRequestException(`Fallo en la lectura del modelo: ${err?.message}`);
    }

    // Si no teníamos número de reporte previo, usar el leído por el modelo si está disponible
    if (!numeroReporte && resultadoLectura.numeroReporte) {
      numeroReporte = resultadoLectura.numeroReporte;

      // Re-verificar duplicado con el número extraído por el modelo
      const { data: duplicadoIA } = await this.client
        .from('escaneos')
        .select('id')
        .eq('empresa_id', empresaId)
        .eq('numero_reporte', numeroReporte)
        .maybeSingle();

      if (duplicadoIA) {
        throw new EscaneoDuplicadoError(
          'reporte_duplicado',
          `El reporte N° ${numeroReporte} ya se encuentra registrado.`,
          { numeroReporte },
        );
      }
    }

    // 9. Identificar campos dudosos o no leídos para la bandeja de revisión
    const camposDudosos: string[] = [];
    const camposMapa: Record<string, any> = {};

    for (const campo of resultadoLectura.campos) {
      camposMapa[campo.clave] = campo;
      if (campo.dudoso || campo.confianza === 'baja' || campo.noLeido) {
        camposDudosos.push(campo.clave);
      }
    }

    const estado: 'recibido' | 'procesado' | 'en_revision' =
      camposDudosos.length > 0 ? 'en_revision' : 'procesado';

    // 10. Persistir en tabla `escaneos`
    const { data: escaneoInsertado, error: errorEscaneo } = await this.client
      .from('escaneos')
      .insert({
        empresa_id: empresaId,
        numero_reporte: numeroReporte || null,
        ruta_original: rutaOriginal,
        huella,
        paginas: totalPaginas,
        enviado_por: enviadoPor || 'telegram',
        telegram_chat_id: telegramChatId || null,
        estado,
        metadatos: {
          rutas_paginas: rutasPaginas,
          uso: resultadoLectura.uso,
          salida_cruda: resultadoLectura.salidaCruda,
          filename,
        },
      })
      .select('id')
      .single();

    if (errorEscaneo || !escaneoInsertado) {
      const msg = errorEscaneo?.message || 'No se obtuvo el ID del registro creado';
      this.logger.error(`Error persistiendo escaneo en base de datos: ${msg}`);
      throw new InternalServerErrorException(`Error al registrar el escaneo: ${msg}`);
    }

    const escaneoId = escaneoInsertado.id;

    // 11. Persistir en tabla `reportes` (integrada con RP-TECH como histórico)
    const { error: errorReporte } = await this.client.from('reportes').insert({
      empresa_id: empresaId,
      escaneo_id: escaneoId,
      numero_talonario: numeroReporte || null,
      origen: 'historico',
      cliente: camposMapa.empresa?.valor || null,
      fecha: camposMapa.fecha?.valor || null,
      serie_equipo: camposMapa.equipo?.valor || null,
      procedimiento: camposMapa.procedimiento?.valor || null,
      codigo_repuesto: camposMapa.codigo_repuesto?.valor || null,
      tecnico_asignado: camposMapa.tecnico?.valor || null,
      estado_reporte: estado === 'en_revision' ? 'pendiente_revision' : 'aprobado',
      campos_extraidos: camposMapa,
      campos_dudosos: camposDudosos,
    });

    if (errorReporte) {
      this.logger.error(`Error persistiendo reporte técnico: ${errorReporte.message}`);
      throw new InternalServerErrorException(`Error al registrar reporte técnico: ${errorReporte.message}`);
    }

    return {
      escaneoId,
      numeroReporte: numeroReporte || 'Sin N° detectado',
      estado,
      campos: camposMapa,
      camposDudosos,
      totalPaginas,
      huella,
      rutasPaginas,
      metricasIA: resultadoLectura.uso,
    };
  }

  async listarEscaneos(limite = 50) {
    const { data, error } = await this.client
      .from('escaneos')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(limite);

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async obtenerEscaneoPorId(id: string) {
    const { data, error } = await this.client
      .from('escaneos')
      .select('*, reportes(*)')
      .eq('id', id)
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }
}
