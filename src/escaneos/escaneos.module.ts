import { Module } from '@nestjs/common';
import { EscaneosController } from './escaneos.controller';
import { EscaneosService } from './escaneos.service';
import { CommonModule } from '../common/common.module';
import { RptechModule } from '../rptech/rptech.module';

@Module({
  imports: [CommonModule, RptechModule],
  controllers: [EscaneosController],
  providers: [EscaneosService],
  exports: [EscaneosService],
})
export class EscaneosModule {}

