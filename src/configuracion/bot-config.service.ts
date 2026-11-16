import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

/**
 * Configuración del bot de Telegram desde la app.
 *
 * El backend de SIREP es uno solo, pero su dirección pública puede cambiar
 * (otro túnel de ngrok, otro dominio). Aquí se ve a qué dirección le manda
 * Telegram los mensajes y se puede escribir la nueva y volver a conectar,
 * sin entrar al servidor a correr `npm run telegram:webhook`.
 *
 * Seguridad: antes de conectar se comprueba que la dirección escrita llegue a
 * ESTE backend (se le pide un código que solo este proceso conoce). Así nadie
 * puede mandar las fotos de los reportes a otro servidor desde la pantalla.
 * Solo los roles de BOT_CONFIG_ROLES (por defecto admin y operador) cambian algo.
 */
export const RUTA_WEBHOOK = '/telegram/webhook';

export interface EstadoBot {
  configurado: boolean;
  bot: { usuario: string | null; nombre: string | null } | null;
  conectado: boolean;
  url_webhook: string | null;
  /** Dirección del backend que hoy recibe los mensajes (sin /telegram/webhook). */
  direccion_actual: string | null;
  /** PUBLIC_URL del .env, como sugerencia cuando no hay ninguna conectada. */
  direccion_sugerida: string | null;
  ruta_webhook: string;
  mensajes_pendientes: number;
  ultimo_error: string | null;
  ultimo_error_en: string | null;
  puede_cambiar: boolean;
}

export function limpiarDireccion(texto: string): string {
  return String(texto ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(new RegExp(`${RUTA_WEBHOOK}$`), '');
}

@Injectable()
export class BotConfigService {
  private readonly logger = new Logger(BotConfigService.name);
  // Códigos de un solo uso para comprobar que una dirección llega a este backend.
  private readonly codigos = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  private get token() {
    return this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() || '';
  }

  private get secreto() {
    return this.config.get<string>('TELEGRAM_WEBHOOK_SECRET')?.trim() || '';
  }

  puedeCambiar(rol: string | undefined): boolean {
    const roles = (this.config.get<string>('BOT_CONFIG_ROLES') ?? 'admin,operador')
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
    return roles.includes(String(rol ?? '').toLowerCase());
  }

  private async telegram(metodo: string, cuerpo: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch) {
    if (!this.token) throw new ServiceUnavailableException('Falta TELEGRAM_BOT_TOKEN en el backend.');
    let res: Response;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${this.token}/${metodo}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
    } catch (e) {
      throw new ServiceUnavailableException(`No se pudo conectar con Telegram: ${(e as Error).message}`);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) throw new ServiceUnavailableException(`Telegram respondió: ${json.description ?? res.status}`);
    return json.result;
  }

  async estado(rol: string | undefined, fetchImpl: typeof fetch = fetch): Promise<EstadoBot> {
    const sugerida = this.config.get<string>('PUBLIC_URL');
    const base: EstadoBot = {
      configurado: false,
      bot: null,
      conectado: false,
      url_webhook: null,
      direccion_actual: null,
      direccion_sugerida: sugerida ? limpiarDireccion(sugerida.split('->')[0]) : null,
      ruta_webhook: RUTA_WEBHOOK,
      mensajes_pendientes: 0,
      ultimo_error: null,
      ultimo_error_en: null,
      puede_cambiar: this.puedeCambiar(rol),
    };
    if (!this.token) return base;

    const [yo, info] = await Promise.all([
      this.telegram('getMe', {}, fetchImpl),
      this.telegram('getWebhookInfo', {}, fetchImpl),
    ]);
    const url: string = info.url || '';
    return {
      ...base,
      configurado: true,
      bot: { usuario: yo?.username ? `@${yo.username}` : null, nombre: yo?.first_name ?? null },
      conectado: Boolean(url),
      url_webhook: url || null,
      direccion_actual: url ? limpiarDireccion(url) : null,
      mensajes_pendientes: Number(info.pending_update_count ?? 0),
      ultimo_error: info.last_error_message ?? null,
      ultimo_error_en: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
    };
  }

  /** Responde el eco solo si el código lo generó este mismo proceso hace menos de un minuto. */
  responderEco(codigo: string): boolean {
    const creado = this.codigos.get(codigo);
    return creado !== undefined && Date.now() - creado < 60_000;
  }

  /** ¿La dirección llega a este backend? Se pide por ella un código que solo este proceso conoce. */
  private async llegaAEsteBackend(direccion: string, fetchImpl: typeof fetch): Promise<void> {
    const codigo = randomBytes(16).toString('hex');
    this.codigos.set(codigo, Date.now());
    try {
      let res: Response;
      try {
        res = await fetchImpl(`${direccion}/configuracion/bot/eco/${codigo}`, {
          headers: { 'ngrok-skip-browser-warning': '1' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        throw new ServiceUnavailableException(
          `No se pudo abrir ${direccion} (${(e as Error).message}). Revisa que el túnel o el dominio estén activos. No se cambió nada.`,
        );
      }
      const json: any = await res.json().catch(() => null);
      if (!res.ok || json?.ok !== true) {
        throw new BadRequestException(
          `${direccion} no llega a este backend de SIREP (respondió ${res.status}). Revisa la dirección. No se cambió nada.`,
        );
      }
    } finally {
      this.codigos.delete(codigo);
    }
  }

  async conectar(direccionEscrita: string, rol: string | undefined, actor: string, fetchImpl: typeof fetch = fetch): Promise<EstadoBot> {
    if (!this.puedeCambiar(rol)) throw new ForbiddenException('Tu rol no puede cambiar la conexión del bot.');
    const direccion = limpiarDireccion(direccionEscrita);
    if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(direccion)) {
      throw new BadRequestException('Escribe la dirección pública del backend, que empiece con https:// (Telegram no acepta http).');
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(this.secreto)) {
      throw new ServiceUnavailableException('TELEGRAM_WEBHOOK_SECRET falta o tiene caracteres no permitidos.');
    }

    await this.llegaAEsteBackend(direccion, fetchImpl);
    await this.telegram('setWebhook', {
      url: `${direccion}${RUTA_WEBHOOK}`,
      secret_token: this.secreto,
      allowed_updates: ['message'],
      // Los mensajes que esperaban no se pierden: llegan a la dirección nueva.
      drop_pending_updates: false,
    }, fetchImpl);
    this.logger.log(`${actor} conectó el bot de Telegram a ${direccion}${RUTA_WEBHOOK}.`);
    return this.estado(rol, fetchImpl);
  }

  async desconectar(rol: string | undefined, actor: string, fetchImpl: typeof fetch = fetch): Promise<EstadoBot> {
    if (!this.puedeCambiar(rol)) throw new ForbiddenException('Tu rol no puede cambiar la conexión del bot.');
    // Sin webhook, Telegram guarda los mensajes (hasta 24 h) y los entrega al volver a conectar.
    await this.telegram('deleteWebhook', { drop_pending_updates: false }, fetchImpl);
    this.logger.log(`${actor} desconectó el bot de Telegram.`);
    return this.estado(rol, fetchImpl);
  }
}
