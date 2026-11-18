import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ActividadInterceptor, RegistrarActividad } from '../auth/actividad.interceptor';
import { AuthGuard } from '../auth/auth.guard';
import { BotConfigService } from './bot-config.service';
import { CambioIa, IaConfigService } from './ia-config.service';

const actorDe = (req: any) => req?.usuario?.nombre || req?.usuario?.email || 'desconocido';

@ApiTags('configuracion')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@UseInterceptors(ActividadInterceptor)
@Controller('configuracion')
export class ConfiguracionController {
  constructor(
    private readonly bot: BotConfigService,
    private readonly ia: IaConfigService,
  ) {}

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

  /** Proveedor y modelo de IA que leen los reportes. Las claves nunca salen: solo si hay y sus 4 últimos caracteres. */
  @Get('ia')
  estadoIa(@Req() req: any) {
    return this.ia.estado(req?.usuario?.rol);
  }

  /**
   * Cambia proveedor/modelo y, si vienen, guarda claves nuevas (cifradas).
   * Body: { proveedor: 'gemini'|'openai', modelo_gemini?, modelo_openai?, clave_gemini?, clave_openai? }
   * Una clave vacía o ausente deja la guardada.
   */
  @RegistrarActividad('ia_configurada', (req) => ({
    proveedor: String(req.body?.proveedor ?? ''),
    // Nunca se registra la clave: solo si se cambió
    clave_nueva: Boolean(req.body?.clave_gemini || req.body?.clave_openai),
  }))
  @Put('ia')
  guardarIa(@Body() body: CambioIa, @Req() req: any) {
    return this.ia.guardar(body ?? {}, req?.usuario?.rol, actorDe(req));
  }

  /** Prueba la clave y el modelo sin gastar (consulta los datos del modelo). Body: { proveedor, modelo?, clave? } */
  @Post('ia/probar')
  probarIa(@Body() body: { proveedor?: unknown; modelo?: unknown; clave?: unknown }, @Req() req: any) {
    return this.ia.probar(body ?? {}, req?.usuario?.rol);
  }

  /** Modelos que puede usar la clave (escrita o guardada), consultados al proveedor. Body: { proveedor, clave? } */
  @Post('ia/modelos')
  modelosIa(@Body() body: { proveedor?: unknown; clave?: unknown }, @Req() req: any) {
    return this.ia.listarModelos(body ?? {}, req?.usuario?.rol);
  }

  @RegistrarActividad('ia_clave_quitada', (req) => ({ proveedor: String(req.params?.proveedor ?? '') }))
  @Delete('ia/clave/:proveedor')
  quitarClaveIa(@Param('proveedor') proveedor: string, @Req() req: any) {
    return this.ia.quitarClave(proveedor, req?.usuario?.rol, actorDe(req));
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
