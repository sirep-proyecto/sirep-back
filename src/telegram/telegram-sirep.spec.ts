import { Logger, UnauthorizedException } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { EscaneosService, EscaneoDuplicadoError } from '../escaneos/escaneos.service';

describe('Backend 2: Telegram Webhook y Respuestas', () => {
  let controller: TelegramController;
  let telegramService: TelegramService;
  let mockEscaneosService: any;
  let mockConfigService: any;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'TELEGRAM_WEBHOOK_SECRET') return 'super-secret-123';
        if (key === 'TELEGRAM_BOT_TOKEN') return 'fake-bot-token';
        return null;
      }),
    };

    mockEscaneosService = {
      procesarEscaneo: jest.fn(),
    };

    telegramService = new TelegramService(mockConfigService, mockEscaneosService as EscaneosService);
    // Espiar enviarMensaje y descargarArchivo para pruebas
    jest.spyOn(telegramService, 'enviarMensaje').mockResolvedValue(undefined as any);
    jest.spyOn(telegramService, 'descargarArchivo').mockResolvedValue(Buffer.from('dummy-pdf'));

    controller = new TelegramController(telegramService, mockConfigService);
  });

  describe('TelegramController (Validación de secret_token)', () => {
    it('rechaza con 401 si el secret_token no se envía en los headers', async () => {
      await expect(
        controller.telegramWebhook({ message: {} }, undefined),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza con 401 si el secret_token es incorrecto', async () => {
      await expect(
        controller.telegramWebhook({ message: {} }, 'token-incorrecto'),
      ).rejects.toThrow('Secret token inválido');
    });

    it('acepta y retorna { ok: true } si el secret_token es válido', async () => {
      const res = await controller.telegramWebhook(
        { message: { chat: { id: 123 }, text: '/start' } },
        'super-secret-123',
      );
      expect(res).toEqual({ ok: true });
    });
  });

  describe('TelegramService (Manejo de duplicados)', () => {
    it('avisa al usuario cuando un archivo ya fue enviado anteriormente', async () => {
      mockEscaneosService.procesarEscaneo.mockRejectedValue(
        new EscaneoDuplicadoError('archivo_duplicado', 'Archivo ya enviado'),
      );

      const spyEnviar = jest.spyOn(telegramService, 'enviarMensaje');

      await telegramService.handleUpdate({
        message: {
          chat: { id: 999 },
          message_id: 1,
          document: { file_id: 'file-123', file_name: '000845.pdf' },
        },
      });

      expect(spyEnviar).toHaveBeenCalledWith(
        999,
        expect.stringContaining('Este archivo ya fue enviado anteriormente'),
      );
    });

    it('avisa al usuario cuando un número de reporte ya está registrado', async () => {
      mockEscaneosService.procesarEscaneo.mockRejectedValue(
        new EscaneoDuplicadoError('reporte_duplicado', 'Reporte registrado', { numeroReporte: '000845' }),
      );

      const spyEnviar = jest.spyOn(telegramService, 'enviarMensaje');

      await telegramService.handleUpdate({
        message: {
          chat: { id: 999 },
          message_id: 1,
          document: { file_id: 'file-456', file_name: '000845.pdf' },
          caption: '000845',
        },
      });

      expect(spyEnviar).toHaveBeenCalledWith(
        999,
        expect.stringContaining('El reporte N° <b>000845</b> ya se encuentra registrado'),
      );
    });
  });
});

