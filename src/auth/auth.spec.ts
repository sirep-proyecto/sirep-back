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
  let mockUsuarios: any;

  const cuentaValentino = {
    id: '22222222-2222-4222-8222-222222222222',
    usuario: 'valentino',
    nombre: 'Valentino',
    rol: 'supervisor',
    permisos: ['ver_reportes', 'editar_campos'],
    activo: true,
  };

  beforeEach(() => {
    mockConfig = {
      get: jest.fn((key: string) => (key === 'AUTH_JWT_SECRET' ? 'test-secret-sprint3-sirep' : undefined)),
    };
    mockUsuarios = {
      verificarCredenciales: jest.fn(async (id: string, pass: string) =>
        id === 'valentino' && pass === 'claveVal123' ? cuentaValentino : null,
      ),
      obtenerParaSesion: jest.fn(async (id: string) => (id === cuentaValentino.id ? cuentaValentino : null)),
    };

    authService = new AuthService(mockConfig, mockUsuarios);
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

  it('rechaza con 401 credenciales incorrectas', async () => {
    await expect(authController.login({ usuario: 'valentino', password: 'incorrecta' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
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
      rol: 'supervisor',
      permisos: ['ver_reportes', 'editar_campos'],
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

  it('rechaza un token firmado que no sea de una cuenta de SIREP (por ejemplo, de antes de este cambio)', async () => {
    const viejo = authService.emitirToken({ ...cuentaValentino, email: 'v@sirep.local', permisos: [] });
    const [h, p, firma] = viejo.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'));
    delete payload.org;
    const sinOrigen = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), firma].join('.');
    const { ctx } = crearContextoHttp({ authorization: `Bearer ${sinOrigen}` });
    await expect(authGuard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('registra cada corrección con el usuario autenticado de la sesión sin permitir suplantación', async () => {
    const revisarCampoSpy = jest.fn().mockResolvedValue({ ok: true });
    const controller = new ReportesController({ revisarCampo: revisarCampoSpy } as any);

    const usuarioSesion = { id: 'usr-valentino', email: 'valentino@sirep.local', nombre: 'Valentino' };
    await controller.revisarCampo(
      '000214',
      'codigo_repuesto',
      { tipo: 'corregir', valor: 'REP-900', actor: 'ActorFalsoDelBody' },
      { usuario: usuarioSesion },
    );

    expect(revisarCampoSpy).toHaveBeenCalledWith(
      '000214',
      'codigo_repuesto',
      {
        tipo: 'corregir',
        valor: 'REP-900',
        actor: 'Valentino',
      },
      usuarioSesion,
    );
  });

  it('rechaza con 401 un token enviado en la dirección de la página (?token=...) (SIREP-S4-T02)', async () => {
    const loginRes = await authController.login({
      usuario: 'valentino',
      password: 'claveVal123',
    });

    const { ctx } = crearContextoHttp({}, { token: loginRes.access_token });
    await expect(authGuard.canActivate(ctx)).rejects.toThrow(
      'El token de sesión no se acepta en la dirección de la página',
    );
  });
});
