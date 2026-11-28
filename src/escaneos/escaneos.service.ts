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
import { IaConfigService } from '../configuracion/ia-config.service';
import { ClaveIaUsuarioService, esFalloDeClave } from '../configuracion/clave-usuario.service';
import { ocultarClaves } from '../ia-extractor/lectura-comun';
import { resolverTemperaturaConfigurada } from '../ia-extractor/anthropic.proveedor';
import { construirContextoDesdeReportes, registrarEdicionEnDataset } from '../ia-extractor/normalizacion';
import { CampoEsperado, ContextoAprendizaje, LectorDeReportes, ResultadoLectura } from '../ia-extractor/types';
import { aTexto, columnasDesdeValores } from '../reportes/reportes.columnas';
import { TableroService } from '../reportes/tablero.service';
import { CAMPOS_FORMULARIO } from './campos-formulario';
import { ubicarCampos } from './ubicacion';
import { enParalelo, paginasEnParalelo } from './paralelo';
import {
  paginaParaGuardar,
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
/** Reportes recientes que se leen para el contexto de aprendizaje de la IA. */
const REPORTES_PARA_CONTEXTO = 100;
/** Cuánto se reutiliza ese contexto entre subidas. */
const VIGENCIA_CONTEXTO_MS = 2 * 60 * 1000;
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
  enviadoPorId?: string;
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
  /** Con qué clave se leyó: la personal de quien subió, la de la empresa, o la de la empresa porque la personal falló. */
  claveIa?: { origen: 'personal' | 'empresa' | 'respaldo_empresa'; aviso: string | null };
}

@Injectable()
export class EscaneosService {
  private readonly logger = new Logger(EscaneosService.name);
  private contextoGuardado: {
    empresaId: string;
    valor: { contexto: ContextoAprendizaje; totalReportesPrevios: number };
    venceEn: number;
  } | null = null;
  private lectorIA: LectorDeReportes | null = null;
  private lectorFijo = false;

  // Campos del formulario físico de GO Service Latam: ver campos-formulario.ts
  readonly camposFormulario: CampoEsperado[] = [...CAMPOS_FORMULARIO];

  constructor(
    private readonly supabase: SupabaseService,
    // Opcional para que las pruebas unitarias no necesiten el canal en vivo
    @Optional() private readonly eventos?: EventosGateway,
    // Proveedor elegido en Configuración > Lectura con IA. Opcional: sin él (pruebas) se usa el .env
    @Optional() private readonly iaConfig?: IaConfigService,
    @Optional() private readonly tablero?: TableroService,
    // Clave de Gemini propia de quien sube el reporte (Configuración > Mi clave de Gemini)
    @Optional() private readonly clavesUsuario?: ClaveIaUsuarioService,
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

  /** Fija un lector a mano (pruebas); tiene prioridad sobre lo elegido en Configuración. */
  setLectorIA(lector: LectorDeReportes) {
    this.lectorIA = lector;
    this.lectorFijo = true;
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
    const actor = input.enviadoPor || 'telegram';
    const numeroPreliminar =
      extraerNumeroReporte(input.caption) || extraerNumeroReporte(input.filename) || null;
    try {
      const resultado = await this.ejecutarProcesamientoEscaneo(input);
      await this.tablero?.registrarEvento({
        usuario_id: input.enviadoPorId ?? null,
        usuario: actor,
        reporte:
          resultado.numeroReporte && resultado.numeroReporte !== 'Sin N° detectado'
            ? resultado.numeroReporte
            : null,
        tipo_accion: 'subir',
        detalle: {
          resultado: 'procesado',
          filename: input.filename,
          escaneoId: resultado.escaneoId,
        },
      });
      return resultado;
    } catch (err: any) {
      if (err instanceof EscaneoDuplicadoError) {
        await this.tablero?.registrarEvento({
          usuario_id: input.enviadoPorId ?? null,
          usuario: actor,
          reporte: err.datosExtra?.numeroReporte ?? numeroPreliminar,
          tipo_accion: 'subir',
          detalle: {
            resultado: 'duplicado',
            tipo_duplicado: err.tipoDuplicado,
            filename: input.filename,
          },
        });
      } else {
        await this.tablero?.registrarEvento({
          usuario_id: input.enviadoPorId ?? null,
          usuario: actor,
          reporte: numeroPreliminar,
          tipo_accion: 'subir',
          detalle: {
            resultado: 'error',
            codigo: err?.response?.codigo ?? err?.codigo ?? 'error_subida',
            mensaje: err?.message ?? 'Error al procesar escaneo',
            filename: input.filename,
          },
        });
      }
      throw err;
    }
  }

  private async ejecutarProcesamientoEscaneo(input: ProcesarEscaneoInput): Promise<ResultadoProcesamientoEscaneo> {
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

    // 3. Lector de IA listo antes de guardar nada: si falta la clave no se sube basura a Storage.
    // Primero la clave personal de quien sube (cada clave tiene su propio cupo por minuto);
    // si no tiene, la de la empresa. Con lector fijo (pruebas) no se usan claves personales.
    const personal = this.lectorFijo ? null : ((await this.clavesUsuario?.lectorPara(input.enviadoPorId)) ?? null);
    let lector = personal?.lector ?? (await this.obtenerLector());
    // 'personal' | 'empresa' | 'respaldo_empresa' (la personal falló y se usó la de la empresa)
    let origenClave: 'personal' | 'empresa' | 'respaldo_empresa' = personal ? 'personal' : 'empresa';
    let avisoClave: string | null = null;
    // Si la clave personal falla en una página, todas las que siguen usan la de la empresa.
    // Una sola promesa: si dos páginas fallan a la vez, se cambia una vez.
    let cambioAEmpresa: Promise<LectorDeReportes> | null = null;
    const pasarAEmpresa = (err: any): Promise<LectorDeReportes> => {
      cambioAEmpresa ??= (async () => {
        const motivo = ocultarClaves(String(err?.message ?? err), '').slice(0, 300);
        this.logger.warn(`Clave personal de ${personal!.usuarioId} falló; se usa la de la empresa: ${motivo}`);
        void this.clavesUsuario?.registrarError(personal!.usuarioId, motivo);
        origenClave = 'respaldo_empresa';
        avisoClave = Number(err?.codigoHttp) === 429
          ? 'Tu clave de Gemini llegó a su límite de uso; este reporte se leyó con la clave de la empresa.'
          : 'Tu clave de Gemini no funcionó; este reporte se leyó con la clave de la empresa. Revísala en Configuración.';
        lector = await this.obtenerLector();
        return lector;
      })();
      return cambioAEmpresa;
    };

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
        // Las páginas se guardan en WebP (mucho más livianas que PNG); el original queda intacto.
        const ruta = `${base}_pag_${i + 1}.webp`;
        await this.subirArchivo(ruta, await paginaParaGuardar(imagenesPaginas[i]), 'image/webp');
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

      // Cada página se lee en su propia llamada (igual que antes), pero varias a la vez:
      // no cambia lo que lee el modelo, solo el tiempo total. El límite evita saturar
      // a Gemini (más 503/429) y la memoria del servidor. Las lecturas quedan en orden.
      const lecturas: ResultadoLectura[] = await enParalelo(
        imagenesPaginas,
        paginasEnParalelo(),
        async (pagina, indice) => {
          const copiaIA = await optimizarParaIA(pagina);
          const leerCon = (l: LectorDeReportes) =>
            l.leer(copiaIA.buffer, copiaIA.mimetype, this.camposFormulario, temperaturaConfigurada, contexto);
          try {
            let lecturaPagina: ResultadoLectura;
            const usado = lector;
            try {
              lecturaPagina = await leerCon(usado);
            } catch (err: any) {
              // Falló la clave personal (inválida o sin cupo): esta página se reintenta con la de la empresa
              if (personal && usado === personal.lector && esFalloDeClave(err)) {
                lecturaPagina = await leerCon(await pasarAEmpresa(err));
              } else {
                throw err;
              }
            }
            // La caja del modelo es relativa a la imagen de ESTA página: se anota cuál es
            for (const campo of lecturaPagina.campos) {
              if (campo.caja) campo.caja.pagina = indice + 1;
            }
            return lecturaPagina;
          } catch (err: any) {
            this.logger.error(`Error en la extracción con IA (página ${indice + 1}): ${err?.message}`);
            throw new LecturaIAError(err?.message ?? 'error desconocido');
          }
        },
      );
      const lectura = fusionarLecturas(lecturas);
      if (personal && origenClave === 'personal') void this.clavesUsuario?.registrarUso(personal.usuarioId);

      // 6b. Ubicar cada campo en ESTE escaneo con las etiquetas impresas que encontró la IA.
      // Se usa la PRIMERA página (en orden) cuyo ajuste es fiable: normalmente el anverso.
      // No se elige "la que tiene más etiquetas" porque en el reverso la IA también puede
      // leer el formulario que se transparenta del otro lado.
      let ubicada = false;
      for (const [indice, lecturaPagina] of lecturas.entries()) {
        const etiquetas = lecturaPagina.etiquetas ?? [];
        if (etiquetas.length === 0) continue;
        const { campos, ubicacion } = ubicarCampos(lectura.campos, etiquetas, indice + 1);
        if (!ubicacion) continue;
        lectura.campos = campos;
        ubicada = true;
        this.logger.log(
          `Ubicación por etiquetas (página ${indice + 1}): ${ubicacion.anclasUsadas.length}/${etiquetas.length} anclas, ` +
            `error medio ${(ubicacion.errorMedio * 100).toFixed(2)} % de la página`,
        );
        break;
      }
      if (!ubicada && lecturas.some((l) => (l.etiquetas ?? []).length > 0)) {
        this.logger.warn('Ubicación por etiquetas descartada: ninguna página dio un ajuste fiable');
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
            // Con qué clave se leyó (para saber a qué cuenta de Google se cobró). Nunca la clave.
            clave_ia: {
              origen: origenClave,
              usuario_id: personal?.usuarioId ?? null,
              final: origenClave === 'empresa' ? null : (personal?.final ?? null),
            },
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
        claveIa: { origen: origenClave, aviso: avisoClave },
      };
    } catch (err) {
      await this.limpiarStorage(subidos);
      throw err;
    }
  }

  private async obtenerLector(): Promise<LectorDeReportes> {
    if (this.lectorFijo && this.lectorIA) return this.lectorIA;
    if (this.iaConfig) {
      try {
        return await this.iaConfig.lectorActual();
      } catch (err: any) {
        this.logger.error(`Proveedor de IA no disponible: ${err?.message}`);
        throw new LecturaIAError(err?.message ?? 'proveedor no configurado');
      }
    }
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
    const guardado = this.contextoGuardado;
    if (guardado && guardado.empresaId === empresaId && Date.now() < guardado.venceEn) {
      return guardado.valor;
    }
    const valor = await this.consultarContextoYConteo(empresaId);
    // Solo se reutiliza cuando ya hay 100 reportes previos (el tope de la consulta): a partir de ahí
    // el conteo no cambia y el modo de revisión completa queda decidido. Evita volver a descargar
    // 100 reportes en cada subida; a cambio, una corrección hecha en los últimos 2 minutos tarda
    // hasta 2 minutos en llegar al contexto de la IA.
    this.contextoGuardado =
      valor.totalReportesPrevios >= REPORTES_PARA_CONTEXTO
        ? { empresaId, valor, venceEn: Date.now() + VIGENCIA_CONTEXTO_MS }
        : null;
    return valor;
  }

  private async consultarContextoYConteo(
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
      const limitada = typeof ordenada.limit === 'function' ? ordenada.limit(REPORTES_PARA_CONTEXTO) : ordenada;
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

  async listarEscaneos(
    limite = 50,
    usuario?: { nombre?: string; email?: string; rol?: string; roles?: string[]; permisos?: string[] },
  ) {
    const { data, error } = await this.client
      .from('escaneos')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(limite);

    if (error) throw new BadRequestException(error.message);
    const lista = Array.isArray(data) ? data : [];

    // SIREP-S4-T02: El ingestor solo ve sus propias cargas.
    if (
      usuario &&
      usuario.rol !== 'administrador' &&
      usuario.rol !== 'admin' &&
      !usuario.permisos?.includes('editar_campos') &&
      !usuario.permisos?.includes('gestionar_usuarios')
    ) {
      const nombreNorm = (usuario.nombre || '').trim().toLowerCase();
      const userNorm = (usuario.email || '').replace(/@.*$/, '').trim().toLowerCase();
      return lista.filter((e: any) => {
        const env = String(e?.enviado_por || '').trim().toLowerCase();
        return env === nombreNorm || (userNorm !== '' && env === userNorm);
      });
    }

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