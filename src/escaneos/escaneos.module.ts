import { Module } from '@nestjs/common';
import { EscaneosController } from './escaneos.controller';
import { EscaneosService } from './escaneos.service';
import { CommonModule } from '../common/common.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ReportesModule } from '../reportes/reportes.module';

@Module({
  imports: [CommonModule, ConfiguracionModule, ReportesModule],
  controllers: [EscaneosController],
  providers: [EscaneosService],
  exports: [EscaneosService],
})
export class EscaneosModule {}

