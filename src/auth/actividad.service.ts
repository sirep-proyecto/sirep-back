import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export interface RegistroActividad {
  id: number;
  usuario_id: string | null;
  usuario: string;
  accion: string;
  detalle: Record<string, unknown>;
  creado_en: string;
}

export interface QuienActua {
  id?: string | null;
  nombre?: string | null;
  email?: string | null;
}

export interface FiltroActividad {
  limite?: number;
  usuarioId?: string;
  accion?: string;
}

/**
 * Bitácora de lo que hace cada cuenta: quién revisó, cerró, subió, exportó o cambió accesos.
 * Registrar nunca debe romper la acción original: los errores solo se avisan en el log.
 */
@Injectable()
export class ActividadService {
  private readonly logger = new Logger(ActividadService.name);
  private avisoTablaFaltante = false;

  constructor(private readonly supabase: SupabaseService) {}

  private get db() {
    return this.supabase.getClient();
  }

  registrar(quien: QuienActua | undefined | null, accion: string, detalle: Record<string, unknown> = {}): void {
    const nombre = quien?.nombre || quien?.email;
    if (!nombre) return;

    void Promise.resolve(
      this.db.from('actividad_usuarios').insert({
        usuario_id: quien?.id ?? null,
        usuario: nombre,
        accion,
        detalle,
      }),
    )
      .then((res: any) => {
        const error = res?.error;
        if (!error) return;
        const texto = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
        if (texto.includes('42p01') || texto.includes('pgrst205') || texto.includes('does not exist')) {
          if (!this.avisoTablaFaltante) {
            this.avisoTablaFaltante = true;
            this.logger.warn('Falta la tabla actividad_usuarios: aplica la migración 20261118000000.');
          }
          return;
        }
        this.logger.warn(`No se pudo registrar la actividad "${accion}": ${error.message}`);
      })
      .catch((e: unknown) => this.logger.warn(`No se pudo registrar la actividad "${accion}": ${String(e)}`));
  }

  async listar(filtro: FiltroActividad = {}): Promise<RegistroActividad[]> {
    const limite = Math.min(Math.max(Number(filtro.limite) || 200, 1), 500);
    let consulta = this.db
      .from('actividad_usuarios')
      .select('id, usuario_id, usuario, accion, detalle, creado_en')
      .order('creado_en', { ascending: false })
      .limit(limite);
    if (filtro.usuarioId) consulta = consulta.eq('usuario_id', filtro.usuarioId);
    if (filtro.accion) consulta = consulta.eq('accion', filtro.accion);

    const { data, error } = await consulta;
    if (error) {
      const texto = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
      if (texto.includes('42p01') || texto.includes('pgrst205') || texto.includes('does not exist')) {
        throw new ServiceUnavailableException(
          'Falta aplicar la migración de actividad (20261118000000_actividad_usuarios.sql) en Supabase.',
        );
      }
      throw new ServiceUnavailableException('No se pudo leer la actividad.');
    }
    return (data ?? []) as RegistroActividad[];
  }
}
