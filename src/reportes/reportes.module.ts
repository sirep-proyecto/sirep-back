import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { RptechModule } from '../rptech/rptech.module';
import { ReportesController } from './reportes.controller';
import { ReportesService } from './reportes.service';
import { TableroService } from './tablero.service';

@Module({
  imports: [CommonModule, RptechModule],
  controllers: [ReportesController],
  providers: [ReportesService, TableroService],
  exports: [TableroService],
})
export class ReportesModule {}
