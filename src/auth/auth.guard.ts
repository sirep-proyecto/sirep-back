import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { CATALOGO_PERMISOS, type Permiso } from './permisos';
import { CLAVE_PERMISO } from './requiere-permiso.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const headerAuth = req.headers?.authorization as string | undefined;
    const headerToken = req.headers?.['x-auth-token'] as string | undefined;
    const queryToken = req.query?.token as string | undefined;

    const token = headerAuth || headerToken || queryToken;
    if (!token) {
      throw new UnauthorizedException('Sesión requerida. Inicia sesión para acceder a la API de SIREP.');
    }

    const usuario = await this.authService.validarToken(token);
    req.usuario = usuario;

    // Sin decorador (o sin Reflector, como en pruebas unitarias) basta con tener sesión.
    const requerido = this.reflector?.getAllAndOverride<Permiso | undefined>(CLAVE_PERMISO, [
      context.getHandler?.(),
      context.getClass?.(),
    ]);
    if (requerido && !usuario.permisos?.includes(requerido)) {
      const etiqueta = CATALOGO_PERMISOS.find((p) => p.id === requerido)?.etiqueta ?? requerido;
      throw new ForbiddenException(
        `Tu cuenta no tiene permiso para esta acción (${etiqueta}). Pídele acceso a un administrador.`,
      );
    }
    return true;
  }
}
