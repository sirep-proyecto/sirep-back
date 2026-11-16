import { Body, Controller, Delete, Get, NotFoundException, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { BotConfigService } from './bot-config.service';

const actorDe = (req: any) => req?.usuario?.nombre || req?.usuario?.email || 'desconocido';

@ApiTags('configuracion')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('configuracion')
export class ConfiguracionController {
  constructor(private readonly bot: BotConfigService) {}

  /** Estado del bot: a qué dirección le manda Telegram los mensajes, cola y último error. */
  @Get('bot')
  estadoBot(@Req() req: any) {
    return this.bot.estado(req?.usuario?.rol);
  }

  /** Conecta el bot a la dirección pública de este backend. Body: { "url": "https://..." } */
  @Put('bot')
  conectarBot(@Body() body: { url?: string }, @Req() req: any) {
    return this.bot.conectar(String(body?.url ?? ''), req?.usuario?.rol, actorDe(req));
  }

  /** Desconecta el bot: Telegram guarda los mensajes hasta que se vuelva a conectar. */
  @Delete('bot')
  desconectarBot(@Req() req: any) {
    return this.bot.desconectar(req?.usuario?.rol, actorDe(req));
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
