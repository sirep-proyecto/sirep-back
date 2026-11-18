import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { BotConfigService } from './bot-config.service';
import { ConfiguracionController, EcoBotController } from './configuracion.controller';
import { IaConfigService } from './ia-config.service';

@Module({
  imports: [CommonModule],
  controllers: [ConfiguracionController, EcoBotController],
  providers: [BotConfigService, IaConfigService],
  // EscaneosService pide aquí el lector de IA elegido en la pantalla
  exports: [IaConfigService],
})
export class ConfiguracionModule {}
