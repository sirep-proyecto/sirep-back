import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { EventosGateway } from '../realtime/eventos.gateway';
import { crearLectorDeReportes } from '../ia-extractor/ia-extractor.factory';
import { resolverTemperaturaConfigurada } from '../ia-extractor/anthropic.proveedor';
import { construirContextoDesdeReportes, registrarEdicionEnDataset } from '../ia-extractor/normalizacion';
import { CampoEsperado, ContextoAprendizaje, LectorDeReportes, ResultadoLectura } from '../ia-extractor/types';
import { aTexto, columnasDesdeValores } from '../reportes/reportes.columnas';
import { CAMPOS_FORMULARIO } from './campos-formulario';
import { ubicarCampos } from './ubicacion';
import {
  calcularHuellaSHA256,
  esPDF,
  extraerNumeroReporte,
  fusionarLecturas,
  normalizarFecha,
  optimizarParaIA,
  renderizarPaginasPDF,
  validarImagen,
} from './escaneos.util';

const BUCKET = 'escaneos-originales';
const COLUMNAS_EXISTENTE = 'id, numero_reporte, creado_en, enviado_por, telegram_chat_id';
export const EMPRESA_POR_DEFECTO = '00000000-0000-0000-0000-000000000000';

/** Datos del escaneo que ya existía, para que la página muestre "llegó por Telegram el 10/11". */
export interface DatosEscaneoExistente {
  escaneoId?: string;
  numeroReporte?: string;
  recibidoEn?: string;
  origen?: 'telegram' | 'web';
  enviadoPor?: string;
}

/**
 * Archivo o N° de reporte repetido (HTTP 409). El cuerpo JSON lleva `codigo`
 * ('archivo_duplicado' | 'reporte_duplicado') y, si se conocen, los datos del existente.
 */
export class EscaneoDuplicadoError extends ConflictException {
  constructor(
    public readonly tipoDuplicado: 'archivo_duplicado' | 'reporte_duplicado',
    mensaje: string,
    public readonly datosExtra?: DatosEscaneoExistente & Record<string, any>,
  ) {
    super({
      statusCode: 409,
      message: mensaje,
      codigo: tipoDuplicado,
      numeroReporte: datosExtra?.numeroReporte ?? null,
      escaneoId: datosExtra?.escaneoId ?? null,
      recibidoEn: datosExtra?.recibidoEn ?? null,
      origen: datosExtra?.origen ?? null,
      enviadoPor: datosExtra?.enviadoPor ?? null,
    });
  }
}

/**
 * Falla del proveedor de IA (sin clave, sin respuesta, error HTTP, JSON inválido).
 * El detalle técnico va al log; el mensaje que ve la secretaria es genérico
 * porque los errores de los proveedores son largos y no le sirven.
 */
export class LecturaIAError extends BadGatewayException {
  constructor(public readonly detalle: string) {
    super({
      statusCode: 502,
      codigo: 'lectura_ia',
      message: 'No se pudo leer el reporte con la IA. No se guardó nada; intenta de nuevo en unos minutos.',
    });
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

  // Campos del formulario físico de GO Service Latam: ver campos-formulario.ts
  readonly camposFormulario: CampoEsperado[] = [...CAMPOS_FORMULARIO];

  constructor(
    private readonly supabase: SupabaseService,
    // Opcional para que las pruebas unitarias no necesiten el canal en vivo
    @Optional() private readonly eventos?: EventosGateway,
  ) {
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

  /** Borra de Storage lo ya subido cuando el procesamiento falla, para no dejar archivos huérfanos. */
  private async limpiarStorage(rutas: string[]) {
    if (rutas.length === 0) return;
    try {
      const { error } = await this.client.storage.from(BUCKET).remove(rutas);
      if (error) this.logger.warn(`No se pudo limpiar Storage tras un fallo: ${error.message}`);
    } catch (err: any) {
      this.logger.warn(`No se pudo limpiar Storage tras un fallo: ${err?.message}`);
    }
  }

  async procesarEscaneo(input: ProcesarEscaneoInput): Promise<ResultadoProcesamientoEscaneo> {
    const { buffer, filename, caption, enviadoPor, telegramChatId } = input;
    const empresaId = input.empresaId || EMPRESA_POR_DEFECTO;

    if (!buffer || buffer.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        codigo: 'archivo_danado',
        message: 'El archivo está vacío o no se pudo leer. Vuelve a seleccionarlo.',
      });
    }

    // 1. Huella SHA-256 y duplicado nivel 1 (mismo archivo reenviado)
    const huella = calcularHuellaSHA256(buffer);
    const { data: escaneoPorHuella } = await this.client
      .from('escaneos')
      .select(COLUMNAS_EXISTENTE)
      .eq('empresa_id', empresaId)
      .eq('huella', huella)
      .maybeSingle();

    if (escaneoPorHuella) {
      throw new EscaneoDuplicadoError(
        'archivo_duplicado',
        'Este archivo ya fue enviado anteriormente.',
        this.datosDelExistente(escaneoPorHuella),
      );
    }

    // 2. N° preliminar (texto del envío o nombre del archivo) y duplicado nivel 2 (mismo papel escaneado dos veces)
    let numeroReporte = extraerNumeroReporte(caption) || extraerNumeroReporte(filename);
    if (numeroReporte) {
      await this.verificarNumeroNoRegistrado(empresaId, numeroReporte);
    }

    // 3. Lector de IA listo antes de guardar nada: si falta la clave no se sube basura a Storage
    const lector = this.obtenerLector();

    // 4. Una imagen por página. Se hace antes de subir para rechazar PDF dañados o demasiado largos sin dejar rastro.
    const esPdf = esPDF(buffer);
    let imagenesPaginas: Buffer[];
    let extensionOriginal = 'pdf';
    let mimetypeOriginal = 'application/pdf';

    if (esPdf) {
      imagenesPaginas = await renderizarPaginasPDF(buffer);
    } else {
      const formato = await validarImagen(buffer);
      extensionOriginal = formato.extension;
      mimetypeOriginal = formato.mimetype;
      imagenesPaginas = [buffer];
    }
    const totalPaginas = imagenesPaginas.length;

    // 5. Guardar el original sin comprimir y las imágenes de cada página
    const base = `${empresaId}/${Date.now()}_${numeroReporte || 'sin_num'}`;
    const rutaOriginal = `${base}_orig.${extensionOriginal}`;
    const subidos: string[] = [];

    await this.subirArchivo(rutaOriginal, buffer, mimetypeOriginal);
    subidos.push(rutaOriginal);

    // Una foto ya ES su única página: no se duplica en Storage
    const rutasPaginas: string[] = [];
    try {
      for (let i = 0; i < imagenesPaginas.length; i++) {
        if (!esPdf) {
          rutasPaginas.push(rutaOriginal);
          continue;
        }
        const ruta = `${base}_pag_${i + 1}.png`;
        await this.subirArchivo(ruta, imagenesPaginas[i], 'image/png');
        subidos.push(ruta);
        rutasPaginas.push(ruta);
      }
    } catch (err) {
      await this.limpiarStorage(subidos);
      throw err;
    }

    try {
      // 6. Lectura con el modelo, página por página, inyectando el contexto de correcciones aprendidas
      const { contexto, totalReportesPrevios } = await this.obtenerContextoYConteo(empresaId);
      const temperaturaConfigurada = resolverTemperaturaConfigurada();
      const limiteRevisionCompleta = this.resolverLimiteRevisionCompleta();
      const enModoRevisionCompleta =
        limiteRevisionCompleta > 0 && totalReportesPrevios < limiteRevisionCompleta;

      const lecturas: ResultadoLectura[] = [];
      for (const [indice, pagina] of imagenesPaginas.entries()) {
        const copiaIA = await optimizarParaIA(pagina);
        try {
          const lecturaPagina = await lector.leer(
            copiaIA.buffer,
            copiaIA.mimetype,
            this.camposFormulario,
            temperaturaConfigurada,
            contexto,
          );
          // La caja del modelo es relativa a la imagen de ESTA página: se anota cuál es
          for (const campo of lecturaPagina.campos) {
            if (campo.caja) campo.caja.pagina = indice + 1;
          }
          lecturas.push(lecturaPagina);
        } catch (err: any) {
          this.logger.error(`Error en la extracción con IA: ${err?.message}`);
          throw new LecturaIAError(err?.message ?? 'error desconocido');
        }
      }
      const lectura = fusionarLecturas(lecturas);

      // 6b. Ubicar cada campo en ESTE escaneo con las etiquetas impresas que encontró la IA.
      // Se usa la página con más etiquetas (el anverso). Si no hay ajuste fiable, quedan las cajas de antes.
      const mejorPagina = lecturas
        .map((l, i) => ({ etiquetas: l.etiquetas ?? [], pagina: i + 1 }))
        .sort((x, y) => y.etiquetas.length - x.etiquetas.length)[0];
      if (mejorPagina && mejorPagina.etiquetas.length > 0) {
        const { campos, ubicacion } = ubicarCampos(lectura.campos, mejorPagina.etiquetas, mejorPagina.pagina);
        if (ubicacion) {
          lectura.campos = campos;
          this.logger.log(
            `Ubicación por etiquetas: ${ubicacion.anclasUsadas.length}/${mejorPagina.etiquetas.length} anclas, ` +
              `error medio ${(ubicacion.errorMedio * 100).toFixed(2)} % de la página`,
          );
        } else {
          this.logger.warn(`Ubicación por etiquetas descartada (${mejorPagina.etiquetas.length} etiquetas, ajuste no fiable)`);
        }
      }

      // 7. Si el N° no vino en el envío, se usa el que leyó el modelo y se revisa duplicado de nuevo
      if (!numeroReporte && lectura.numeroReporte) {
        numeroReporte = extraerNumeroReporte(lectura.numeroReporte);
        if (numeroReporte) {
          await this.verificarNumeroNoRegistrado(empresaId, numeroReporte);
        }
      }

      // 8. Campos dudosos o no leídos = lo que irá a la bandeja de revisión
      // SIREP-S3-T18: En producción, los primeros N reportes (30 por defecto) se revisan completos campo por campo.
      const camposDudosos: string[] = [];
      const camposMapa: Record<string, any> = {};
      for (const campo of lectura.campos) {
        const marcadoParaRevision = enModoRevisionCompleta
          ? true
          : Boolean(campo.dudoso || campo.confianza === 'baja' || campo.noLeido);
        const campoFinal = enModoRevisionCompleta ? { ...campo, dudoso: true } : campo;
        camposMapa[campo.clave] = campoFinal;
        if (marcadoParaRevision) {
          camposDudosos.push(campo.clave);
        }
      }
      // "procesado" = el modelo leyó y hay campos esperando a una persona; "en_revision" lo asigna la bandeja
      // cuando alguien ya intervino; sin dudosos el reporte queda "completo". Es la misma regla de la bandeja.
      const estado: 'procesado' | 'completo' = camposDudosos.length > 0 ? 'procesado' : 'completo';

      // 9. Persistir escaneo
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
            uso: lectura.uso,
            salida_cruda: lectura.salidaCruda,
            filename,
          },
        })
        .select('id')
        .single();

      if (errorEscaneo || !escaneoInsertado) {
        // 23505 = índice único: otro envío igual terminó justo antes (carrera entre dos mensajes)
        if ((errorEscaneo as any)?.code === '23505') {
          const porHuella = String(errorEscaneo?.message).includes('huella');
          // El envío ganador ya existe: se busca para informar cuándo y por dónde llegó (si falla, se avisa sin esos datos)
          const existente = await this.buscarExistente(
            empresaId,
            porHuella ? { huella } : { numero_reporte: numeroReporte },
          );
          throw porHuella
            ? new EscaneoDuplicadoError(
              'archivo_duplicado',
              'Este archivo ya fue enviado anteriormente.',
              existente ?? undefined,
            )
            : new EscaneoDuplicadoError(
              'reporte_duplicado',
              `El reporte N° ${numeroReporte} ya se encuentra registrado.`,
              { ...existente, numeroReporte: numeroReporte ?? existente?.numeroReporte },
            );
        }
        const msg = errorEscaneo?.message || 'No se obtuvo el ID del registro creado';
        this.logger.error(`Error persistiendo escaneo en base de datos: ${msg}`);
        throw new InternalServerErrorException(`Error al registrar el escaneo: ${msg}`);
      }

      const escaneoId = escaneoInsertado.id;

      // 10. Persistir reporte (origen histórico, vinculado a su escaneo). Todo campo del formulario
      // tiene su columna: antes solo 6 se guardaban y el resto vivía únicamente en el JSON.
      const valores = Object.fromEntries(lectura.campos.map((c) => [c.clave, aTexto(c.valor)]));
      const { error: errorReporte } = await this.client.from('reportes').insert({
        empresa_id: empresaId,
        escaneo_id: escaneoId,
        numero_talonario: numeroReporte || null,
        origen: 'historico',
        ...columnasDesdeValores(valores),
        estado_reporte: estado === 'procesado' ? 'pendiente_revision' : 'aprobado',
        campos_extraidos: camposMapa,
        campos_dudosos: camposDudosos,
      });

      if (errorReporte) {
        // Sin esto el escaneo quedaba guardado sin reporte y reenviarlo se rechazaba como "duplicado"
        await this.client.from('escaneos').delete().eq('id', escaneoId);
        this.logger.error(`Error persistiendo reporte técnico: ${errorReporte.message}`);
        throw new InternalServerErrorException(`Error al registrar reporte técnico: ${errorReporte.message}`);
      }

      // 11. Actualizar el dataset portable con los datos confiables leídos (ej. nuevos usuarios en contacto y dirección del local)
      const valorConfiable = (clave: string) =>
        !camposDudosos.includes(clave) && valores[clave] ? valores[clave] : null;
      registrarEdicionEnDataset({
        empresa: valorConfiable('empresa'),
        direccion: valorConfiable('direccion'),
        contacto: valorConfiable('contacto'),
        telefono: valorConfiable('telefono'),
        tecnico: valorConfiable('tecnico'),
        equipo: valorConfiable('equipo'),
        operador: valorConfiable('operador'),
      });

      this.eventos?.emitirCambio('creado', numeroReporte);

      return {
        escaneoId,
        numeroReporte: numeroReporte || 'Sin N° detectado',
        estado,
        campos: camposMapa,
        camposDudosos,
        totalPaginas,
        huella,
        rutasPaginas,
        metricasIA: lectura.uso,
      };
    } catch (err) {
      await this.limpiarStorage(subidos);
      throw err;
    }
  }

  private obtenerLector(): LectorDeReportes {
    if (this.lectorIA) return this.lectorIA;
    try {
      this.lectorIA = crearLectorDeReportes();
      return this.lectorIA;
    } catch (err: any) {
      this.logger.error(`Proveedor de IA no disponible: ${err?.message}`);
      throw new LecturaIAError(err?.message ?? 'proveedor no configurado');
    }
  }

  private resolverLimiteRevisionCompleta(): number {
    const raw = process.env.REVISION_COMPLETA_PRIMEROS_N;
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
    if (process.env.MODO_REVISION_COMPLETA_30 === 'true') return 30;
    return process.env.NODE_ENV === 'production' ? 30 : 0;
  }

  /**
   * Consulta el dataset portable (`data/dataset-clientes.json`), la tabla `dataset_clientes`
   * y el historial de `reportes` de la BD conectada para que el modelo aprenda de cada edición
   * y además informe cuántos reportes previos existen para la cuota de revisión completa (T18).
   */
  private async obtenerContextoYConteo(
    empresaId: string,
  ): Promise<{ contexto: ContextoAprendizaje; totalReportesPrevios: number }> {
    let filasReportes: any[] = [];
    let filasDataset: any[] = [];

    try {
      const consulta: any = this.client
        .from('reportes')
        .select('cliente, tecnico_asignado, serie_equipo, direccion, contacto, telefono, operador, campos_extraidos')
        .eq('empresa_id', empresaId);

      const ordenada = typeof consulta.order === 'function'
        ? consulta.order('actualizado_en', { ascending: false })
        : consulta;
      const limitada = typeof ordenada.limit === 'function' ? ordenada.limit(100) : ordenada;
      const res = await limitada;
      if (Array.isArray(res?.data)) {
        filasReportes = res.data;
      }
    } catch {
      // Si la BD original aún no tiene alguna columna opcional, intenta la consulta mínima
      try {
        const resMin: any = await this.client
          .from('reportes')
          .select('cliente, tecnico_asignado, serie_equipo, direccion, campos_extraidos')
          .eq('empresa_id', empresaId);
        if (Array.isArray(resMin?.data)) filasReportes = resMin.data;
      } catch {
        filasReportes = [];
      }
    }

    try {
      const consultaCat: any = this.client
        .from('dataset_clientes')
        .select('nombre_cliente, direcciones, contactos, direccion_por_contacto, correcciones')
        .eq('empresa_id', empresaId);
      const resCat = await consultaCat;
      if (Array.isArray(resCat?.data)) {
        filasDataset = resCat.data;
      }
    } catch {
      // Si la BD original aún no aplicó la migración de `dataset_clientes`, continúa con el JSON portable + `reportes`
      filasDataset = [];
    }

    // SIREP-S3-T16: Cargar también los clientes conocidos desde la tabla `clientes` de RP-TECH si está presente
    try {
      const consultaClientesRpTech: any = this.client
        .from('clientes')
        .select('*');
      const limitadaCli =
        typeof consultaClientesRpTech?.limit === 'function'
          ? consultaClientesRpTech.limit(500)
          : consultaClientesRpTech;
      const resCli = await limitadaCli;
      if (Array.isArray(resCli?.data)) {
        for (const cli of resCli.data) {
          const nombre =
            cli?.nombre ||
            cli?.razon_social ||
            cli?.nombre_comercial ||
            cli?.empresa ||
            cli?.nombre_cliente;
          if (typeof nombre === 'string' && nombre.trim()) {
            const dir = cli?.direccion ? [String(cli.direccion).trim()] : [];
            const cont = cli?.contacto ? [String(cli.contacto).trim()] : [];
            filasDataset.push({
              nombre_cliente: nombre.trim(),
              direcciones: dir,
              contactos: cont,
              direccion_por_contacto: {},
              correcciones: [],
            });
          }
        }
      }
    } catch {
      // Si la tabla `clientes` no existe en el entorno actual, se continúa sin error
    }

    return {
      contexto: construirContextoDesdeReportes(filasReportes, filasDataset),
      totalReportesPrevios: filasReportes.length,
    };
  }

  private async verificarNumeroNoRegistrado(empresaId: string, numeroReporte: string) {
    const { data } = await this.client
      .from('escaneos')
      .select(COLUMNAS_EXISTENTE)
      .eq('empresa_id', empresaId)
      .eq('numero_reporte', numeroReporte)
      .maybeSingle();

    if (data) {
      throw new EscaneoDuplicadoError(
        'reporte_duplicado',
        `El reporte N° ${numeroReporte} ya se encuentra registrado.`,
        { ...this.datosDelExistente(data), numeroReporte },
      );
    }
  }

  /** Convierte la fila de `escaneos` en los datos que acompañan al 409. Sin chat de Telegram = subido desde la web. */
  private datosDelExistente(fila: any): DatosEscaneoExistente {
    return {
      escaneoId: fila?.id,
      numeroReporte: fila?.numero_reporte ?? undefined,
      recibidoEn: fila?.creado_en ?? undefined,
      origen: fila?.telegram_chat_id ? 'telegram' : 'web',
      enviadoPor: fila?.enviado_por ?? undefined,
    };
  }

  private async buscarExistente(
    empresaId: string,
    filtro: Record<string, string | null>,
  ): Promise<DatosEscaneoExistente | null> {
    try {
      let consulta: any = this.client.from('escaneos').select(COLUMNAS_EXISTENTE).eq('empresa_id', empresaId);
      for (const [col, valor] of Object.entries(filtro)) consulta = consulta.eq(col, valor);
      const { data } = await consulta.maybeSingle();
      return data ? this.datosDelExistente(data) : null;
    } catch {
      return null;
    }
  }

  private async subirArchivo(ruta: string, contenido: Buffer, contentType: string) {
    const { error } = await this.client.storage.from(BUCKET).upload(ruta, contenido, { contentType, upsert: false });
    if (error) {
      this.logger.error(`Error guardando ${ruta} en Storage: ${error.message}`);
      throw new InternalServerErrorException(`No se pudo almacenar el archivo en Storage: ${error.message}`);
    }
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