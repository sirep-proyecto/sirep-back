import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  @Post('webhook')
  async telegramWebhook(
    @Body() update: any,
    @Headers('x-telegram-bot-api-secret-token') secretHeader: string | undefined,
  ) {
    const secretEsperado = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (!secretEsperado) {
      throw new UnauthorizedException('TELEGRAM_WEBHOOK_SECRET no configurado en el servidor.');
    }

    if (secretHeader !== secretEsperado) {
      this.logger.warn('Rechazado webhook de Telegram por secret_token inválido.');
      throw new UnauthorizedException('Secret token inválido');
    }

    // Se responde 200 de inmediato a Telegram para no bloquear el webhook;
    // el procesamiento y la respuesta al chat ocurren en background.
    this.telegramService.handleUpdate(update).catch((err) => {
      this.logger.error(`Error en procesamiento de update: ${err?.message ?? err}`);
    });

    return { ok: true };
  }
}
