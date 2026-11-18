import { Body, Controller, Delete, Get, NotFoundException, Param, Put, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ActividadInterceptor, RegistrarActividad } from '../auth/actividad.interceptor';
import { AuthGuard } from '../auth/auth.guard';
import { BotConfigService } from './bot-config.service';

const actorDe = (req: any) => req?.usuario?.nombre || req?.usuario?.email || 'desconocido';

@ApiTags('configuracion')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@UseInterceptors(ActividadInterceptor)
@Controller('configuracion')
export class ConfiguracionController {
  constructor(private readonly bot: BotConfigService) {}

  /** Estado del bot: a qué dirección le manda Telegram los mensajes, cola y último error. */
  @Get('bot')
  estadoBot(@Req() req: any) {
    return this.bot.estado(req?.usuario?.rol, undefined, req?.usuario?.permisos);
  }

  /** Conecta el bot a la dirección pública de este backend. Body: { "url": "https://..." } */
  @RegistrarActividad('bot_conectado', (req) => ({ url: String(req.body?.url ?? '') }))
  @Put('bot')
  conectarBot(@Body() body: { url?: string }, @Req() req: any) {
    return this.bot.conectar(String(body?.url ?? ''), req?.usuario?.rol, actorDe(req), undefined, req?.usuario?.permisos);
  }

  /** Desconecta el bot: Telegram guarda los mensajes hasta que se vuelva a conectar. */
  @RegistrarActividad('bot_desconectado')
  @Delete('bot')
  desconectarBot(@Req() req: any) {
    return this.bot.desconectar(req?.usuario?.rol, actorDe(req), undefined, req?.usuario?.permisos);
  }
}

/**
 * Sin sesión a propósito: lo llama este mismo backend, a través de la dirección
 * pública escrita, para comprobar que llega aquí. Solo responde a un código de
 * un solo uso que este proceso acaba de generar; no expone datos.
 */
@ApiTags('configuracion')
@Controller('configuracion/bot/eco')
export class EcoBotController {
  constructor(private readonly bot: BotConfigService) {}

  @Get(':codigo')
  eco(@Param('codigo') codigo: string) {
    if (!this.bot.responderEco(codigo)) throw new NotFoundException();
    return { ok: true };
  }
}
