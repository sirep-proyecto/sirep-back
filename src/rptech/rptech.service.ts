import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';
import { FilaReporte } from '../reportes/reportes.mapper';
import { ConfigRptech, ResultadoEnvio, enviarReporte } from './rptech.cliente';

/** Envío del histórico a RP-TECH desde la API de SIREP (bandeja y lote). */
@Injectable()
export class RptechService {
  private readonly logger = new Logger(RptechService.name);
  private readonly cfg: ConfigRptech | null;

  constructor(
    private readonly supabase: SupabaseService,
    config: ConfigService,
  ) {
    const url = config.get<string>('RPTECH_URL')?.trim();
    const clave = config.get<string>('RPTECH_CLAVE')?.trim();
    this.cfg = url && clave ? { url, clave } : null;
    if (!this.cfg) this.logger.warn('Sin RPTECH_URL o RPTECH_CLAVE: los reportes no se envían a RP-TECH.');
  }

  configurado(): boolean {
    return this.cfg !== null;
  }

  async enviar(fila: FilaReporte): Promise<ResultadoEnvio> {
    if (!this.cfg) throw new Error('Falta configurar RPTECH_URL y RPTECH_CLAVE');
    const r = await enviarReporte(this.supabase.getClient(), fila, this.cfg);
    if (r.estado === 'clave_invalida') this.logger.error('RP-TECH rechazó la clave de SIREP (RPTECH_CLAVE).');
    else if (r.estado !== 'importado') this.logger.warn(`Reporte ${fila.numero_talonario ?? fila.id}: ${r.estado}`);
    return r;
  }
}
