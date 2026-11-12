import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { SupabaseService } from '../common/supabase.service';

export interface UsuarioAutenticado {
  id: string;
  email: string;
  nombre: string;
  rol: string;
}

interface CredencialConfigurada {
  identificador: string;
  email: string;
  password: string;
  nombre: string;
  rol: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
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
   * Lee usuarios configurados por variable de entorno `AUTH_USUARIOS`.
   * Formato: "usuario_o_email:clave:Nombre Visible,otro@empresa.com:clave2:Nombre 2"
   */
  private obtenerUsuariosConfigurados(): CredencialConfigurada[] {
    const crudo =
      this.config.get<string>('AUTH_USUARIOS') ??
      process.env.AUTH_USUARIOS ??
      '';
    if (!crudo.trim()) return [];

    return crudo
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item, idx) => {
        const [identificador = '', password = '', nombre = '', rol = 'revisor'] = item.split(':');
        const idLimpio = identificador.trim();
        const email = idLimpio.includes('@') ? idLimpio : `${idLimpio}@sirep.local`;
        return {
          identificador: idLimpio.toLowerCase(),
          email: email.toLowerCase(),
          password: password.trim(),
          nombre: (nombre || idLimpio || `Usuario ${idx + 1}`).trim(),
          rol: rol.trim() || 'revisor',
        };
      })
      .filter((u) => Boolean(u.identificador && u.password));
  }

  /**
   * Emite un JWT firmado con HMAC-SHA256 sin requerir dependencias externas.
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
        iat: ahora,
        exp: ahora + duracionSegundos,
      }),
    ).toString('base64url');

    const firma = createHmac('sha256', this.jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    return `${header}.${payload}.${firma}`;
  }

  verificarTokenPropio(token: string): UsuarioAutenticado | null {
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
      if (typeof datos.exp === 'number' && datos.exp < ahora) {
        return null;
      }
      if (!datos.sub && !datos.email) return null;

      return {
        id: String(datos.sub || datos.email),
        email: String(datos.email || datos.sub),
        nombre: String(datos.nombre || datos.email || datos.sub),
        rol: String(datos.rol || 'revisor'),
      };
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

    // 1. Verificar contra usuarios configurados en entorno (AUTH_USUARIOS)
    const configurados = this.obtenerUsuariosConfigurados();
    const encontrado = configurados.find(
      (u) =>
        (u.identificador === idNorm || u.email === idNorm) &&
        u.password === passLimpia,
    );

    if (encontrado) {
      const usuario: UsuarioAutenticado = {
        id: `usr-${encontrado.identificador}`,
        email: encontrado.email,
        nombre: encontrado.nombre,
        rol: encontrado.rol,
      };
      return {
        access_token: this.emitirToken(usuario),
        token_type: 'bearer',
        usuario,
      };
    }

    // 2. Autenticar contra Supabase Auth (cuenta oficial de la empresa / RP-TECH)
    try {
      const client = this.supabase.getClient();
      if (client?.auth?.signInWithPassword) {
        const emailLogin = idNorm.includes('@') ? idNorm : `${idNorm}@sirep.local`;
        const { data, error } = await client.auth.signInWithPassword({
          email: emailLogin,
          password: passLimpia,
        });

        if (!error && data?.user) {
          const user = data.user;
          const meta: Record<string, any> = user.user_metadata || {};
          const nombre =
            meta.nombre ||
            meta.full_name ||
            meta.name ||
            user.email?.split('@')[0] ||
            idNorm;
          const usuario: UsuarioAutenticado = {
            id: user.id,
            email: user.email || emailLogin,
            nombre: String(nombre),
            rol: String(meta.rol || 'revisor'),
          };
          return {
            access_token: this.emitirToken(usuario),
            token_type: 'bearer',
            usuario,
          };
        }
      }
    } catch {
      // Si falla la conexión con Supabase Auth, se reporta credencial inválida abajo.
    }

    throw new UnauthorizedException('Credenciales inválidas. Verifica tu correo/usuario y contraseña.');
  }

  async validarToken(token: string | undefined): Promise<UsuarioAutenticado> {
    const limpio = (token || '').replace(/^Bearer\s+/i, '').trim();
    if (!limpio) {
      throw new UnauthorizedException('Sesión requerida. Inicia sesión para acceder a la bandeja de SIREP.');
    }

    // 1. Verificar JWT emitido por SIREP
    const propio = this.verificarTokenPropio(limpio);
    if (propio) {
      return propio;
    }

    // 2. Verificar JWT emitido directamente por Supabase Auth en el frontend
    try {
      const client = this.supabase.getClient();
      if (client?.auth?.getUser) {
        const { data, error } = await client.auth.getUser(limpio);
        if (!error && data?.user) {
          const user = data.user;
          const meta: Record<string, any> = user.user_metadata || {};
          const nombre =
            meta.nombre ||
            meta.full_name ||
            meta.name ||
            user.email?.split('@')[0] ||
            'revisor';
          return {
            id: user.id,
            email: user.email || '',
            nombre: String(nombre),
            rol: String(meta.rol || 'revisor'),
          };
        }
      }
    } catch {
      // Si el token no es válido en Supabase, rechazar abajo
    }

    throw new UnauthorizedException('Sesión expirada o token inválido. Vuelve a iniciar sesión.');
  }
}
