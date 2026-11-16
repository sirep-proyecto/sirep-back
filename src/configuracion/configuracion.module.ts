import { Module } from '@nestjs/common';
import { BotConfigService } from './bot-config.service';
import { ConfiguracionController, EcoBotController } from './configuracion.controller';

@Module({
  controllers: [ConfiguracionController, EcoBotController],
  providers: [BotConfigService],
})
export class ConfiguracionModule {}
