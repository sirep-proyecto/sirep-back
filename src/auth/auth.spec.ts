import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { ReportesController } from '../reportes/reportes.controller';

describe('SIREP-S3-T04: Login en la bandeja y API protegida', () => {
  let authService: AuthService;
  let authGuard: AuthGuard;
  let authController: AuthController;
  let mockConfig: any;
  let mockSupabase: any;

  beforeEach(() => {
    mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'AUTH_JWT_SECRET') return 'test-secret-sprint3-sirep';
        if (key === 'AUTH_USUARIOS') {
          return 'david:claveDavid123:David Operador:operador,valentino:claveVal123:Valentino:revisor';
        }
        return undefined;
      }),
    };

    mockSupabase = {
      getClient: jest.fn(() => ({
        auth: {
          signInWithPassword: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'Invalid' } }),
          getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'Invalid token' } }),
        },
      })),
    };

    authService = new AuthService(mockConfig, mockSupabase);
    authGuard = new AuthGuard(authService);
    authController = new AuthController(authService);
  });

  function crearContextoHttp(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
    const req: any = { headers, query };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
    return { ctx, req };
  }

  it('rechaza con 401 cualquier petición sin sesión activa (sin token)', async () => {
    const { ctx } = crearContextoHttp();
    await expect(authGuard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza con 401 un token alterado o inválido', async () => {
    const { ctx } = crearContextoHttp({ authorization: 'Bearer token.falso.invalido' });
    await expect(authGuard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('permite iniciar sesión con credenciales válidas y acceder a rutas protegidas con el token', async () => {
    const loginRes = await authController.login({
      usuario: 'valentino',
      password: 'claveVal123',
    });

    expect(loginRes.token_type).toBe('bearer');
    expect(loginRes.usuario).toMatchObject({
      email: 'valentino@sirep.local',
      nombre: 'Valentino',
      rol: 'revisor',
    });

    const { ctx, req } = crearContextoHttp({
      authorization: `Bearer ${loginRes.access_token}`,
    });
    const permitido = await authGuard.canActivate(ctx);
    expect(permitido).toBe(true);
    expect(req.usuario).toMatchObject({
      nombre: 'Valentino',
      email: 'valentino@sirep.local',
    });
  });

  it('acepta también tokens emitidos directamente por Supabase Auth', async () => {
    mockSupabase.getClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'supa-uuid-1',
              email: 'tecnico@rptech.pe',
              user_metadata: { nombre: 'Carlos Técnico' },
            },
          },
          error: null,
        }),
      },
    });

    const { ctx, req } = crearContextoHttp({
      authorization: 'Bearer token-supabase-real',
    });
    const permitido = await authGuard.canActivate(ctx);
    expect(permitido).toBe(true);
    expect(req.usuario).toMatchObject({
      id: 'supa-uuid-1',
      email: 'tecnico@rptech.pe',
      nombre: 'Carlos Técnico',
    });
  });

  it('registra cada corrección con el usuario autenticado de la sesión sin permitir suplantación', async () => {
    const revisarCampoSpy = jest.fn().mockResolvedValue({ ok: true });
    const controller = new ReportesController({ revisarCampo: revisarCampoSpy } as any);

    await controller.revisarCampo(
      '000214',
      'codigo_repuesto',
      { tipo: 'corregir', valor: 'REP-900', actor: 'ActorFalsoDelBody' },
      { usuario: { id: 'usr-valentino', email: 'valentino@sirep.local', nombre: 'Valentino' } },
    );

    expect(revisarCampoSpy).toHaveBeenCalledWith('000214', 'codigo_repuesto', {
      tipo: 'corregir',
      valor: 'REP-900',
      actor: 'Valentino',
    });
  });
});
