import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { RptechService } from './rptech.service';

@Module({
  imports: [CommonModule],
  providers: [RptechService],
  exports: [RptechService],
})
export class RptechModule {}
