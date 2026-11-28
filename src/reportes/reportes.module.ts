import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { SupabaseService } from '../common/supabase.service';
import { EMPRESA_POR_DEFECTO } from '../escaneos/escaneos.service';
import { RptechModule } from '../rptech/rptech.module';
import { CacheReportes } from './cache-reportes';
import { ReportesController } from './reportes.controller';
import { ReportesService } from './reportes.service';
import { TableroService } from './tablero.service';

@Module({
  imports: [CommonModule, RptechModule],
  controllers: [ReportesController],
  providers: [
    ReportesService,
    TableroService,
    {
      provide: CacheReportes,
      useFactory: (supabase: SupabaseService) => new CacheReportes(supabase, EMPRESA_POR_DEFECTO),
      inject: [SupabaseService],
    },
  ],
  exports: [TableroService],
})
export class ReportesModule {}
