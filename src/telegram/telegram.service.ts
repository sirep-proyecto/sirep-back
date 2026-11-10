import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EscaneosService,
  EscaneoDuplicadoError,
  LecturaIAError,
  ResultadoProcesamientoEscaneo,
} from '../escaneos/escaneos.service';

export interface TelegramUpdate {
  message?: {
    chat: { id: number | string };
    message_id: number;
    from?: { first_name?: string; username?: string };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string }>;
    caption?: string;
    text?: string;
  };
}

/** Los valores vienen de letra manuscrita leída por IA: un "<" suelto rompe el parse_mode HTML y Telegram descarta el mensaje. */
export function escaparHtml(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// getFile de la Bot API solo entrega archivos de hasta 20 MB
const LIMITE_DESCARGA_BYTES = 20 * 1024 * 1024;
const LIMITE_MENSAJE = 4000;

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token: string | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly escaneosService: EscaneosService,
  ) {
    this.token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
  }

  private get apiBase() {
    return `https://api.telegram.org/bot${this.token}`;
  }

  private get fileBase() {
    return `https://api.telegram.org/file/bot${this.token}`;
  }

  async handleUpdate(update: TelegramUpdate) {
    const message = update.message;
    if (!message) return;

    const chatId = message.chat.id;
    const remitente = message.from?.username || message.from?.first_name || 'telegram_user';

    // 1. Verificar si viene un archivo o foto
    const fileId =
      message.document?.file_id ||
      (message.photo && message.photo.length > 0 ? message.photo[message.photo.length - 1].file_id : null);

    if (!fileId) {
      if (message.text?.startsWith('/start') || message.text?.startsWith('/help')) {
        await this.enviarMensaje(
          chatId,
          `👋 <b>Bienvenido al Bot de SIREP</b>\n\n` +
          `Envía el reporte técnico escaneado en <b>PDF</b> (anverso y reverso en un solo archivo) o en <b>foto</b>, a 300 dpi.\n` +
          `Puedes poner el N° de reporte en el mensaje o en el nombre del archivo (ej: <code>000845.pdf</code>).`,
        );
        return;
      }

      await this.enviarMensaje(chatId, `📄 Por favor envía el escaneo del reporte técnico (PDF o foto) para procesarlo.`);
      return;
    }

    const filename = message.document?.file_name || `escaneo_${Date.now()}.jpg`;
    const mimetype = message.document?.mime_type || (filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    const caption = message.caption || message.text;

    // Se rechaza antes de descargar: Word, Excel, etc. no son reportes escaneados
    if (message.document && mimetype !== 'application/pdf' && !mimetype.startsWith('image/')) {
      await this.enviarMensaje(chatId, `⚠️ Solo puedo procesar <b>PDF</b> o <b>imágenes</b> (JPG, PNG). Recibí un archivo de tipo <code>${escaparHtml(mimetype)}</code>.`);
      return;
    }

    if ((message.document?.file_size ?? 0) > LIMITE_DESCARGA_BYTES) {
      await this.enviarMensaje(
        chatId,
        `⚠️ El archivo pesa más de 20 MB y Telegram no me permite descargarlo. Vuelve a escanear a menor tamaño (por ejemplo 200 dpi) o envía solo el reporte sin otras hojas.`,
      );
      return;
    }

    await this.enviarMensaje(chatId, `⏳ <i>Procesando reporte con IA, por favor espera un momento...</i>`);

    try {
      // 2. Descargar el archivo de Telegram
      const buffer = await this.descargarArchivo(fileId);

      // 3. Huella + N° + guardado + IA (ver EscaneosService)
      const resultado = await this.escaneosService.procesarEscaneo({
        buffer,
        filename,
        caption,
        mimetype,
        enviadoPor: remitente,
        telegramChatId: Number(chatId),
      });

      // 4. Responder al chat
      await this.enviarMensaje(chatId, this.formatearResultado(resultado));
    } catch (err: any) {
      await this.responderError(chatId, err);
    }
  }

  private formatearResultado(resultado: ResultadoProcesamientoEscaneo): string {
    const dudososSet = new Set(resultado.camposDudosos);

    const leerTexto = (clave: string, textoVacio: string, maxLargo = 600): string => {
      const campo = resultado.campos[clave];
      const valor = campo?.valor;
      if (valor === null || valor === undefined || valor === '') {
        if (campo?.noLeido || dudososSet.has(clave)) {
          return '<i>[No detectado]</i>';
        }
        return textoVacio;
      }
      const texto = typeof valor === 'boolean' ? (valor ? 'Sí' : 'No') : String(valor).trim();
      if (!texto) return textoVacio;
      const recortado = texto.length > maxLargo ? `${texto.slice(0, maxLargo)}…` : texto;
      return escaparHtml(recortado);
    };

    const num = escaparHtml(resultado.numeroReporte);
    const llegada = leerTexto('hora_llegada', '');
    const salida = leerTexto('hora_salida', '');
    const horario = llegada || salida ? `${llegada || '—'} - ${salida || '—'}` : 'No especificado';

    const ln = leerTexto('revision_linea_ln', '');
    const lt = leerTexto('revision_linea_lt', '');
    const nt = leerTexto('revision_linea_nt', '');
    const tieneLineas = Boolean(ln || lt || nt);

    const repTipo = leerTexto('repuestos_tipo', '');
    const repCod = leerTexto('codigo_repuesto', '');
    const repDesc = leerTexto('repuestos_descripcion', '');
    const repCant = leerTexto('repuestos_cantidad', '');
    const tieneRepuestos = Boolean(repTipo || repCod || repDesc || repCant);

    const firmaOp = resultado.campos.firma_operador?.valor ? 'Firmado' : 'Sin firmar';
    const firmaCli = resultado.campos.firma_cliente?.valor ? 'Firmado' : 'Sin firmar';
    const garantia = resultado.campos.garantia?.valor ? 'Sí' : 'No';
    const facturado = resultado.campos.facturado?.valor ? 'Sí' : 'No';

    let mensaje = `✅ <b>Reporte N° ${num} registrado</b> (${resultado.totalPaginas} pág.)\n\n`;
    mensaje += `<b># Reporte Técnico de Servicio Nº ${num}</b>\n\n`;

    mensaje += `<b>## Información General</b>\n`;
    mensaje += `- <b>Nº de Reporte:</b> <code>${num}</code>\n`;
    mensaje += `- <b>Fecha:</b> ${leerTexto('fecha', 'No especificada')}\n`;
    mensaje += `- <b>Horario:</b> ${horario}\n`;
    mensaje += `- <b>Técnico:</b> ${leerTexto('tecnico', 'No especificado')}\n`;
    mensaje += `- <b>Empresa / Cliente:</b> ${leerTexto('empresa', 'No especificado')}\n`;
    const telf = leerTexto('telefono', '');
    if (telf) mensaje += `- <b>Teléfono:</b> ${telf}\n`;
    mensaje += `- <b>Dirección:</b> ${leerTexto('direccion', 'No especificada')}\n`;
    const contacto = leerTexto('contacto', '');
    if (contacto) mensaje += `- <b>Contacto:</b> ${contacto}\n`;
    mensaje += `- <b>Equipo:</b> ${leerTexto('equipo', 'No especificado')}\n`;
    mensaje += `- <b>Motivo del Servicio:</b> ${leerTexto('motivo', 'No especificado')}\n\n`;

    mensaje += `<b>## Revisión Inicial</b>\n`;
    mensaje += `- <b>Estado del Equipo:</b> ${leerTexto('estado_del_equipo', 'No marcado')}\n`;
    const ultMant = leerTexto('ultimo_mantenimiento', '');
    if (ultMant) mensaje += `- <b>Último Mantenimiento:</b> ${ultMant}\n`;
    mensaje += `- <b>Limpieza del Equipo:</b> ${leerTexto('limpieza_equipo', 'No marcado')}\n`;
    mensaje += `- <b>Cabezales:</b> ${leerTexto('cabezales', 'No marcado')}\n`;
    mensaje += `- <b>Sistema de Protección:</b> ${leerTexto('sistema_proteccion', 'No marcado')}\n`;
    mensaje += `- <b>Tinta:</b> ${leerTexto('tinta', 'No marcado')}\n`;
    if (tieneLineas) {
      mensaje += `- <b>Revisión de Líneas:</b> L+N: ${ln || '-'} · L+T: ${lt || '-'} · N+T: ${nt || '-'}\n`;
    }
    const operador = leerTexto('operador', '');
    if (operador) mensaje += `- <b>Operador:</b> ${operador}\n`;
    mensaje += `\n`;

    mensaje += `<b>## Procedimiento Realizado</b>\n`;
    mensaje += `${leerTexto('procedimiento', 'Ninguno registrado.', 1000)}\n\n`;

    mensaje += `<b>## Conclusión</b>\n`;
    mensaje += `${leerTexto('conclusion', 'Ninguna registrada.', 600)}\n\n`;

    mensaje += `<b>## Recomendaciones</b>\n`;
    mensaje += `${leerTexto('recomendaciones', 'Ninguna registrada.', 600)}\n\n`;

    mensaje += `<b>## Repuestos Requeridos / Usados</b>\n`;
    if (tieneRepuestos) {
      if (repTipo) mensaje += `- <b>Tipo:</b> ${repTipo}\n`;
      if (repCod) mensaje += `- <b>Código:</b> ${repCod}\n`;
      if (repDesc) mensaje += `- <b>Descripción:</b> ${repDesc}\n`;
      if (repCant) mensaje += `- <b>Cantidad:</b> ${repCant}\n`;
      mensaje += `\n`;
    } else {
      mensaje += `Ninguno registrado\n\n`;
    }

    mensaje += `<b>## Conformidad y Cierre</b>\n`;
    mensaje += `- <b>Garantía:</b> ${garantia} · <b>Facturado:</b> ${facturado}\n`;
    mensaje += `- <b>Firmas:</b> Operador: ${firmaOp} · Cliente: ${firmaCli}\n\n`;

    if (resultado.camposDudosos.length > 0) {
      mensaje +=
        `⚠️ <b>Atención:</b> pasó a la <b>Bandeja de Revisión</b> por campos dudosos o ilegibles: ` +
        `<code>${escaparHtml(resultado.camposDudosos.join(', '))}</code>.`;
    } else {
      mensaje += `✨ Todos los campos se leyeron con buena confianza.`;
    }
    return mensaje;
  }

  private async responderError(chatId: number | string, err: any) {
    if (err instanceof EscaneoDuplicadoError) {
      if (err.tipoDuplicado === 'archivo_duplicado') {
        await this.enviarMensaje(
          chatId,
          `⚠️ <b>Aviso:</b> Este archivo ya fue enviado anteriormente.\n<i>(No se crearon registros duplicados)</i>`,
        );
      } else {
        await this.enviarMensaje(
          chatId,
          `⚠️ <b>Aviso:</b> El reporte N° <b>${escaparHtml(String(err.datosExtra?.numeroReporte || ''))}</b> ya se encuentra registrado.`,
        );
      }
      return;
    }

    this.logger.error(`Error procesando reporte en Telegram: ${err?.message ?? err}`);

    if (err instanceof LecturaIAError) {
      await this.enviarMensaje(
        chatId,
        `❌ <b>No pude leer el reporte con la IA en este momento.</b>\nNo se guardó nada. Intenta de nuevo en unos minutos; si se repite, avisa al equipo de desarrollo.`,
      );
      return;
    }

    // Errores 4xx propios del sistema (PDF dañado, demasiadas páginas...) traen un mensaje pensado para la secretaria.
    // Cualquier otro error es técnico (base de datos, red) y se muestra genérico.
    const mensajeUsuario =
      err instanceof HttpException && err.getStatus() < 500
        ? escaparHtml(String(err.message)).slice(0, 500)
        : 'Ocurrió un error interno. No se guardó el reporte.';

    await this.enviarMensaje(chatId, `❌ <b>Error al procesar el reporte:</b>\n${mensajeUsuario}\nVerifica el archivo y vuelve a intentar.`);
  }

  /**
   * fetch con tiempo límite y reintentos. "fetch failed" es un fallo de red (DNS, IPv6, VPN,
   * antivirus, corte momentáneo) y casi siempre se resuelve al reintentar; el motivo real
   * viene en `err.cause`, que antes no se registraba.
   */
  private async fetchConReintentos(
    url: string,
    init: RequestInit,
    etiqueta: string,
    { intentos = 3, timeoutMs = 30_000 }: { intentos?: number; timeoutMs?: number } = {},
  ): Promise<Response> {
    let ultimoError: any;
    for (let intento = 1; intento <= intentos; intento++) {
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err: any) {
        ultimoError = err;
        const causa = err?.cause?.code ?? err?.cause?.message ?? err?.name ?? err?.message;
        this.logger.warn(`${etiqueta}: intento ${intento}/${intentos} falló (${causa})`);
        if (intento < intentos) await new Promise((r) => setTimeout(r, 1000 * 2 ** (intento - 1)));
      }
    }
    throw ultimoError;
  }

  async descargarArchivo(fileId: string): Promise<Buffer> {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN no configurado');
    }

    const resInfo = await this.fetchConReintentos(
      `${this.apiBase}/getFile?file_id=${encodeURIComponent(fileId)}`,
      {},
      'Telegram getFile',
    );
    const dataInfo: any = await resInfo.json().catch(() => ({}));
    if (!resInfo.ok || !dataInfo.ok) {
      throw new Error(`Fallo al consultar getFile en Telegram: HTTP ${resInfo.status} ${dataInfo.description ?? ''}`.trim());
    }

    const filePath = dataInfo.result?.file_path;
    if (!filePath) {
      throw new Error('Telegram no devolvió la ruta del archivo (file_path).');
    }

    const resArchivo = await this.fetchConReintentos(`${this.fileBase}/${filePath}`, {}, 'Telegram descarga', {
      timeoutMs: 90_000,
    });
    if (!resArchivo.ok) {
      throw new Error(`Fallo al descargar archivo desde Telegram: HTTP ${resArchivo.status}`);
    }

    return Buffer.from(await resArchivo.arrayBuffer());
  }

  async enviarMensaje(chatId: number | string, texto: string) {
    if (!this.token) {
      this.logger.warn(`Simulado mensaje a chat ${chatId}: ${texto}`);
      return;
    }

    try {
      const res = await this.fetchConReintentos(
        `${this.apiBase}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: texto.slice(0, LIMITE_MENSAJE),
            parse_mode: 'HTML',
          }),
        },
        'Telegram sendMessage',
      );
      if (!res.ok) {
        // Antes un 400 (HTML mal formado, chat bloqueado) se ignoraba en silencio y la secretaria nunca recibía respuesta
        this.logger.error(`Telegram rechazó sendMessage: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      }
    } catch (err: any) {
      this.logger.error(
        `Error enviando mensaje a Telegram: ${err?.message} (${err?.cause?.code ?? err?.cause?.message ?? 'sin detalle'})`,
      );
    }
  }
}