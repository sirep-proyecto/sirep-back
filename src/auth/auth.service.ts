import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { UsuariosService } from './usuarios.service';

export interface UsuarioAutenticado {
  id: string;
  email: string;
  nombre: string;
  rol: string;
  /** Lista de roles asignados a la persona (SIREP-S4-T01: una persona puede tener más de un rol). */
  roles?: string[];
  /** Acciones que esta cuenta puede hacer, leídas de la base de datos en cada petición. */
  permisos: string[];
}

/**
 * Las cuentas viven en la tabla `usuarios` y se administran desde la app
 * (Configuración > Usuarios y accesos). No hay cuentas en variables de entorno.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly usuarios: UsuariosService,
  ) {}

  private get jwtSecret(): string {
    return (
      this.config.get<string>('AUTH_JWT_SECRET') ||
      this.config.get<string>('SUPABASE_KEY') ||
      process.env.AUTH_JWT_SECRET ||
      process.env.SUPABASE_KEY ||
      'sirep-dev-jwt-secret-change-in-prod'
    );
  }

  /**
   * Emite un JWT firmado con HMAC-SHA256 sin requerir dependencias externas.
   * Solo identifica a la cuenta: rol y permisos se leen de la base en cada petición.
   */
  emitirToken(usuario: UsuarioAutenticado, duracionSegundos = 60 * 60 * 12): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const ahora = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        sub: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: usuario.rol,
        org: 'cuenta',
        iat: ahora,
        exp: ahora + duracionSegundos,
      }),
    ).toString('base64url');

    const firma = createHmac('sha256', this.jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    return `${header}.${payload}.${firma}`;
  }

  /** Devuelve el id de la cuenta si el token es de SIREP, está firmado y no venció. */
  verificarTokenPropio(token: string): { id: string } | null {
    const partes = token.split('.');
    if (partes.length !== 3) return null;

    const [header, payload, firmaRecibida] = partes;
    const firmaEsperada = createHmac('sha256', this.jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const bufA = Buffer.from(firmaRecibida);
    const bufB = Buffer.from(firmaEsperada);
    if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
      return null;
    }

    try {
      const datos = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      const ahora = Math.floor(Date.now() / 1000);
      if (typeof datos.exp === 'number' && datos.exp < ahora) return null;
      // Solo valen tokens de cuentas de la base de datos (los de antes de este cambio piden volver a entrar).
      if (datos.org !== 'cuenta' || !datos.sub) return null;
      return { id: String(datos.sub) };
    } catch {
      return null;
    }
  }

  async iniciarSesion(identificador: string, password: string): Promise<{
    access_token: string;
    token_type: 'bearer';
    usuario: UsuarioAutenticado;
  }> {
    const idNorm = (identificador || '').trim().toLowerCase();
    const passLimpia = (password || '').trim();

    if (!idNorm || !passLimpia) {
      throw new UnauthorizedException('Debes ingresar usuario/correo y contraseña.');
    }

    const cuenta = await this.usuarios.verificarCredenciales(idNorm, passLimpia);
    if (!cuenta) {
      throw new UnauthorizedException('Credenciales inválidas. Verifica tu correo/usuario y contraseña.');
    }

    const usuario: UsuarioAutenticado = {
      id: cuenta.id,
      email: cuenta.usuario.includes('@') ? cuenta.usuario : `${cuenta.usuario}@sirep.local`,
      nombre: cuenta.nombre,
      rol: cuenta.rol,
      roles: cuenta.roles ?? [cuenta.rol],
      permisos: cuenta.permisos,
    };
    return {
      access_token: this.emitirToken(usuario),
      token_type: 'bearer',
      usuario,
    };
  }

  async validarToken(token: string | undefined): Promise<UsuarioAutenticado> {
    const limpio = (token || '').replace(/^Bearer\s+/i, '').trim();
    if (!limpio) {
      throw new UnauthorizedException('Sesión requerida. Inicia sesión para acceder a la bandeja de SIREP.');
    }

    const propio = this.verificarTokenPropio(limpio);
    if (!propio) {
      throw new UnauthorizedException('Sesión expirada o token inválido. Vuelve a iniciar sesión.');
    }

    // Se vuelve a leer la cuenta para que un cambio de rol o de permisos, o una cuenta
    // desactivada, se note enseguida sin esperar a que venza el token.
    const cuenta = await this.usuarios.obtenerParaSesion(propio.id);
    if (!cuenta || !cuenta.activo) {
      throw new UnauthorizedException(
        'Tu cuenta ya no tiene acceso. Vuelve a iniciar sesión o pide acceso a un administrador.',
      );
    }
    return {
      id: cuenta.id,
      email: cuenta.usuario.includes('@') ? cuenta.usuario : `${cuenta.usuario}@sirep.local`,
      nombre: cuenta.nombre,
      rol: cuenta.rol,
      roles: cuenta.roles ?? [cuenta.rol],
      permisos: cuenta.permisos,
    };
  }
}
