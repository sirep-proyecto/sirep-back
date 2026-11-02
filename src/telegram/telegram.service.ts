import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EscaneosService, EscaneoDuplicadoError } from '../escaneos/escaneos.service';

export interface TelegramUpdate {
  message?: {
    chat: { id: number | string };
    message_id: number;
    from?: { first_name?: string; username?: string };
    document?: { file_id: string; file_name?: string; mime_type?: string };
    photo?: Array<{ file_id: string }>;
    caption?: string;
    text?: string;
  };
}

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
      (message.photo && message.photo.length > 0
        ? message.photo[message.photo.length - 1].file_id
        : null);

    if (!fileId) {
      if (message.text?.startsWith('/start') || message.text?.startsWith('/help')) {
        await this.enviarMensaje(
          chatId,
          `👋 <b>Bienvenido al Bot de SIREP</b>\n\n` +
            `Por favor, envía el reporte técnico escaneado (en formato <b>PDF</b> o <b>Foto</b> a 300 dpi).\n` +
            `Puedes incluir el N° de reporte en el mensaje o en el nombre del archivo (ej: <code>000845.pdf</code>).`,
        );
        return;
      }

      await this.enviarMensaje(
        chatId,
        `📄 Por favor envía el escaneo del reporte técnico (PDF o foto) para procesarlo.`,
      );
      return;
    }

    const filename = message.document?.file_name || `escaneo_${Date.now()}.jpg`;
    const mimetype = message.document?.mime_type || (filename.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    const caption = message.caption || message.text;

    await this.enviarMensaje(chatId, `⏳ <i>Procesando reporte con IA, por favor espera un momento...</i>`);

    try {
      // 2. Descargar buffer de Telegram
      const buffer = await this.descargarArchivo(fileId);

      // 3. Procesar escaneo con el servicio de negocio
      const resultado = await this.escaneosService.procesarEscaneo({
        buffer,
        filename,
        caption,
        mimetype,
        enviadoPor: remitente,
        telegramChatId: Number(chatId),
      });

      // 4. Formatear respuesta de éxito
      let mensajeRespuesta = `✅ <b>Reporte N° ${resultado.numeroReporte} registrado</b>\n\n`;
      mensajeRespuesta += `<b>Cliente:</b> ${resultado.campos.cliente?.valor || '<i>[No detectado]</i>'}\n`;
      mensajeRespuesta += `<b>Fecha:</b> ${resultado.campos.fecha?.valor || '<i>[No detectada]</i>'}\n`;
      mensajeRespuesta += `<b>Serie:</b> ${resultado.campos.serie_equipo?.valor || '<i>[No detectada]</i>'}\n`;
      mensajeRespuesta += `<b>Procedimiento:</b> ${resultado.campos.procedimiento?.valor || '<i>[No detectado]</i>'}\n`;
      mensajeRespuesta += `<b>Código Repuesto:</b> ${resultado.campos.codigo_repuesto?.valor || '<i>[No detectado]</i>'}\n\n`;

      if (resultado.estado === 'en_revision') {
        mensajeRespuesta += `⚠️ <b>Atención:</b> Pasó a <b>Bandeja de Revisión</b> debido a campos dudosos o ilegibles: ` +
          `<code>${resultado.camposDudosos.join(', ')}</code>.`;
      } else {
        mensajeRespuesta += `✨ Todos los campos se leyeron con alta confianza.`;
      }

      await this.enviarMensaje(chatId, mensajeRespuesta);
    } catch (err: any) {
      if (err instanceof EscaneoDuplicadoError) {
        if (err.tipoDuplicado === 'archivo_duplicado') {
          await this.enviarMensaje(
            chatId,
            `⚠️ <b>Aviso:</b> Este archivo ya fue enviado anteriormente.\n<i>(No se crearon registros duplicados)</i>`,
          );
        } else if (err.tipoDuplicado === 'reporte_duplicado') {
          await this.enviarMensaje(
            chatId,
            `⚠️ <b>Aviso:</b> El reporte N° <b>${err.datosExtra?.numeroReporte || ''}</b> ya se encuentra registrado.`,
          );
        }
        return;
      }

      this.logger.error(`Error procesando reporte en Telegram: ${err?.message ?? err}`);
      await this.enviarMensaje(
        chatId,
        `❌ <b>Error al procesar el reporte:</b>\n${err?.message || 'Error desconocido'}. Por favor verifica el archivo y vuelve a intentar.`,
      );
    }
  }

  async descargarArchivo(fileId: string): Promise<Buffer> {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN no configurado');
    }

    const resInfo = await fetch(`${this.apiBase}/getFile?file_id=${fileId}`);
    if (!resInfo.ok) {
      throw new Error(`Fallo al consultar getFile en Telegram: HTTP ${resInfo.status}`);
    }

    const dataInfo = await resInfo.json();
    const filePath = dataInfo.result?.file_path;
    if (!filePath) {
      throw new Error('Telegram no devolvió la ruta del archivo (file_path).');
    }

    const resArchivo = await fetch(`${this.fileBase}/${filePath}`);
    if (!resArchivo.ok) {
      throw new Error(`Fallo al descargar archivo desde Telegram: HTTP ${resArchivo.status}`);
    }

    const arrayBuffer = await resArchivo.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async enviarMensaje(chatId: number | string, texto: string) {
    if (!this.token) {
      this.logger.warn(`Simulado mensaje a chat ${chatId}: ${texto}`);
      return;
    }

    try {
      await fetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: texto,
          parse_mode: 'HTML',
        }),
      });
    } catch (err: any) {
      this.logger.error(`Error enviando mensaje a Telegram: ${err?.message}`);
    }
  }
}
