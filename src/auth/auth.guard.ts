import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

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
    return true;
  }
}
