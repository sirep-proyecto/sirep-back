import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ActividadService } from './actividad.service';

export const CLAVE_ACTIVIDAD = 'sirep:actividad';

export interface MetaActividad {
  accion: string;
  detalle?: (req: any) => Record<string, unknown>;
}

/** Anota una ruta para que, si termina bien, quede en la bitácora de actividad de la cuenta. */
export const RegistrarActividad = (accion: string, detalle?: (req: any) => Record<string, unknown>) =>
  SetMetadata(CLAVE_ACTIVIDAD, { accion, detalle } satisfies MetaActividad);

@Injectable()
export class ActividadInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly actividad: ActividadService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<MetaActividad | undefined>(CLAVE_ACTIVIDAD, context.getHandler());
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(
      tap({
        complete: () => {
          let detalle: Record<string, unknown> = {};
          try {
            detalle = meta.detalle?.(req) ?? {};
          } catch {
            detalle = {};
          }
          this.actividad.registrar(req?.usuario, meta.accion, detalle);
        },
      }),
    );
  }
}
