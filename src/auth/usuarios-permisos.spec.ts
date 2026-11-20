import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import {
  limpiarPermisos,
  normalizarRol,
  PERMISOS_POR_ROL,
  permisosEfectivos,
  permisosPorDefectoDeRoles,
} from './permisos';
import { RequierePermiso } from './requiere-permiso.decorator';
import { hashearPassword, UsuariosService, verificarPassword } from './usuarios.service';
import { ReportesController } from '../reportes/reportes.controller';
import { EscaneosController } from '../escaneos/escaneos.controller';
import { UsuariosController } from './usuarios.controller';

describe('Roles y permisos por cuenta', () => {
  const config = { get: jest.fn((k: string) => (k === 'AUTH_JWT_SECRET' ? 'secreto-prueba' : undefined)) } as any;

  const cuentaBase = {
    id: '11111111-1111-4111-8111-111111111111',
    usuario: 'maria',
    nombre: 'María',
    rol: 'operador',
    permisos: ['ver_reportes', 'exportar'],
    activo: true,
    creado_por: null,
    creado_en: '2026-11-17T00:00:00Z',
    ultimo_acceso: null,
  };

  describe('catálogo de permisos', () => {
    it('el administrador siempre tiene todos los permisos', () => {
      expect(permisosEfectivos('admin', [])).toContain('gestionar_usuarios');
      expect(permisosEfectivos('admin', [])).toContain('editar_campos');
    });

    it('gestionar_usuarios no se puede conceder a otros roles', () => {
      expect(limpiarPermisos(['ver_reportes', 'gestionar_usuarios', 'inventado', 'ver_reportes'])).toEqual([
        'ver_reportes',
      ]);
      expect(permisosEfectivos('supervisor', ['gestionar_usuarios', 'editar_campos'])).toEqual(['editar_campos']);
    });
  });

  describe('contraseñas', () => {
    it('se guardan con scrypt y se verifican sin guardarlas en claro', () => {
      const guardado = hashearPassword('Clave-Segura-1');
      expect(guardado.startsWith('scrypt$')).toBe(true);
      expect(guardado).not.toContain('Clave-Segura-1');
      expect(verificarPassword('Clave-Segura-1', guardado)).toBe(true);
      expect(verificarPassword('otra-clave', guardado)).toBe(false);
      expect(verificarPassword('x', 'texto-invalido')).toBe(false);
    });
  });

  describe('sesión de una cuenta de la app', () => {
    it('entra con sus permisos, se actualizan sin volver a entrar y pierde el acceso al desactivarse', async () => {
      let actual: any = cuentaBase;
      const usuarios = {
        verificarCredenciales: jest.fn(async (id: string, pass: string) =>
          id === 'maria' && pass === 'claveMaria1' ? cuentaBase : null,
        ),
        obtenerParaSesion: jest.fn(async () => actual),
      } as unknown as UsuariosService;

      const auth = new AuthService(config, usuarios);
      const login = await auth.iniciarSesion('maria', 'claveMaria1');
      expect(login.usuario.permisos).toEqual(['ver_reportes', 'exportar']);

      // El administrador le cambia los permisos: se nota con el mismo token.
      actual = { ...cuentaBase, permisos: ['ver_reportes', 'exportar', 'editar_campos'] };
      expect((await auth.validarToken(login.access_token)).permisos).toContain('editar_campos');

      // La desactiva: el mismo token deja de servir.
      actual = { ...cuentaBase, activo: false };
      await expect(auth.validarToken(login.access_token)).rejects.toBeInstanceOf(UnauthorizedException);

      // La elimina: tampoco.
      actual = null;
      await expect(auth.validarToken(login.access_token)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('AuthGuard con @RequierePermiso', () => {
    class Ejemplo {
      @RequierePermiso('editar_campos')
      editar() {}
      abrir() {}
    }

    const contexto = (handler: Function, token: string) => {
      const req: any = { headers: { authorization: `Bearer ${token}` }, query: {} };
      return {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => handler,
        getClass: () => Ejemplo,
      } as unknown as ExecutionContext;
    };

    it('deja pasar a quien tiene el permiso y rechaza con 403 a quien no', async () => {
      const usuarios = {
        obtenerParaSesion: jest.fn(async (id: string) =>
          id === 'c-editor'
            ? { ...cuentaBase, id, rol: 'supervisor', permisos: ['ver_reportes', 'editar_campos'] }
            : { ...cuentaBase, id },
        ),
      } as unknown as UsuariosService;
      const auth = new AuthService(config, usuarios);
      const guard = new AuthGuard(auth, new Reflector());
      const token = (id: string) =>
        auth.emitirToken({ id, email: `${id}@sirep.local`, nombre: id, rol: 'x', permisos: [] });

      await expect(guard.canActivate(contexto(Ejemplo.prototype.editar, token('c-editor')))).resolves.toBe(true);
      await expect(guard.canActivate(contexto(Ejemplo.prototype.editar, token('c-lector')))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Una ruta sin permiso exigido solo pide sesión.
      await expect(guard.canActivate(contexto(Ejemplo.prototype.abrir, token('c-lector')))).resolves.toBe(true);
    });
  });

  describe('SIREP-S4-T01, T02 y T04: Roles oficiales, permisos por endpoint y 7 usuarios reales', () => {
    it('homologa los 3 roles oficiales (administrador, ingestor, revisor) y soporta múltiples roles por persona', () => {
      expect(normalizarRol('administrador')).toBe('administrador');
      expect(normalizarRol('admin')).toBe('administrador');
      expect(normalizarRol('ingestor')).toBe('ingestor');
      expect(normalizarRol('operador')).toBe('ingestor');
      expect(normalizarRol('revisor')).toBe('revisor');
      expect(normalizarRol('supervisor')).toBe('revisor');

      // Permisos de cada rol
      expect(PERMISOS_POR_ROL.ingestor).toEqual(['ver_reportes', 'subir_escaneos']);
      expect(PERMISOS_POR_ROL.revisor).toEqual(['ver_reportes', 'usar_cola', 'editar_campos', 'cerrar_reportes']);
      expect(PERMISOS_POR_ROL.administrador).toContain('gestionar_usuarios');
      expect(PERMISOS_POR_ROL.administrador).toContain('exportar');

      // Una persona con más de un rol (ingestor + revisor) une los permisos de ambos
      const combinados = permisosPorDefectoDeRoles(['ingestor', 'revisor']);
      expect(combinados).toContain('subir_escaneos');
      expect(combinados).toContain('usar_cola');
      expect(combinados).toContain('editar_campos');
      expect(combinados).not.toContain('gestionar_usuarios');
    });

    it('cada rol recibe un rechazo (403 Forbidden) en los endpoints que no le corresponden (T02)', async () => {
      const cuentas: Record<string, any> = {
        wilber: {
          id: 'u-wilber',
          usuario: 'wilber',
          nombre: 'Wilber Peralta',
          rol: 'administrador',
          roles: ['administrador'],
          permisos: PERMISOS_POR_ROL.administrador,
          activo: true,
        },
        david: {
          id: 'u-david',
          usuario: 'david',
          nombre: 'David',
          rol: 'ingestor',
          roles: ['ingestor'],
          permisos: PERMISOS_POR_ROL.ingestor,
          activo: true,
        },
        adriana: {
          id: 'u-adriana',
          usuario: 'adriana',
          nombre: 'Adriana',
          rol: 'revisor',
          roles: ['revisor'],
          permisos: PERMISOS_POR_ROL.revisor,
          activo: true,
        },
      };

      const usuariosMock = {
        obtenerParaSesion: jest.fn(async (id: string) =>
          Object.values(cuentas).find((c) => c.id === id) ?? null,
        ),
      } as unknown as UsuariosService;

      const auth = new AuthService(config, usuariosMock);
      const guard = new AuthGuard(auth, new Reflector());
      const tokenDe = (clave: 'wilber' | 'david' | 'adriana') =>
        auth.emitirToken({ ...cuentas[clave], email: `${clave}@sirep.local` });

      const ctxEndpoint = (clase: any, handler: Function, token: string) =>
        ({
          switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` }, query: {} }) }),
          getHandler: () => handler,
          getClass: () => clase,
        }) as unknown as ExecutionContext;

      // 1. Ingestor (David): puede subir PDF, pero NO puede usar cola, corregir campos, exportar ni gestionar usuarios
      await expect(
        guard.canActivate(ctxEndpoint(EscaneosController, EscaneosController.prototype.subirEscaneo, tokenDe('david'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.tomarSiguiente, tokenDe('david'))),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.revisarCampo, tokenDe('david'))),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.exportarExcel, tokenDe('david'))),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(ctxEndpoint(UsuariosController, UsuariosController.prototype.listar, tokenDe('david'))),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // 2. Revisor (Adriana): puede usar cola y corregir campos, pero NO puede subir PDF, exportar Excel, importar lote ni gestionar usuarios
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.tomarSiguiente, tokenDe('adriana'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.revisarCampo, tokenDe('adriana'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(ctxEndpoint(EscaneosController, EscaneosController.prototype.subirEscaneo, tokenDe('adriana'))),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.exportarExcel, tokenDe('adriana'))),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.importarLote, tokenDe('adriana'))),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(ctxEndpoint(UsuariosController, UsuariosController.prototype.listar, tokenDe('adriana'))),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // 3. Administrador (Wilber): accede a todo
      await expect(
        guard.canActivate(ctxEndpoint(UsuariosController, UsuariosController.prototype.listar, tokenDe('wilber'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.exportarExcel, tokenDe('wilber'))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(ctxEndpoint(ReportesController, ReportesController.prototype.importarLote, tokenDe('wilber'))),
      ).resolves.toBe(true);
    });

    it('un usuario no puede cambiar su propio rol ni sus propios permisos (T01)', async () => {
      const supabaseMock = {
        getClient: () => ({
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'u-adriana',
                    usuario: 'adriana',
                    nombre: 'Adriana',
                    rol: 'revisor',
                    permisos: ['ver_reportes', 'usar_cola', 'editar_campos'],
                    activo: true,
                    creado_en: '2026-11-18T10:00:00Z',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      } as any;

      const svc = new UsuariosService(supabaseMock);
      await expect(
        svc.actualizar('u-adriana', { rol: 'ingestor' }, 'u-adriana', 'Adriana'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('permite crear usuarios (ingestor, revisor y administrador) y hace fallback si falta la columna roles o check antiguo', async () => {
      const intentos: any[] = [];
      const supabaseMock = {
        getClient: () => ({
          from: () => ({
            insert: (payload: any) => {
              intentos.push(payload);
              return {
                select: () => ({
                  single: async () => {
                    if ('roles' in payload) {
                      return {
                        data: null,
                        error: {
                          code: 'PGRST204',
                          message: "Could not find the 'roles' column of 'usuarios' in the schema cache",
                        },
                      };
                    }
                    if (payload.rol === 'admin') {
                      return {
                        data: null,
                        error: {
                          code: '23505',
                          message: 'duplicate key value violates unique constraint "idx_usuarios_un_solo_admin"',
                        },
                      };
                    }
                    return {
                      data: {
                        id: `u-${payload.usuario}`,
                        usuario: payload.usuario,
                        nombre: payload.nombre,
                        rol: payload.rol,
                        permisos: payload.permisos,
                        activo: true,
                        creado_por: payload.creado_por,
                        creado_en: '2026-11-20T09:00:00Z',
                        ultimo_acceso: null,
                      },
                      error: null,
                    };
                  },
                }),
              };
            },
          }),
        }),
      } as any;

      const svc = new UsuariosService(supabaseMock);

      // 1. Crear ingestor con esquema antiguo (sin columna `roles` -> guarda 'operador' y devuelve 'ingestor')
      const ingestor = await svc.crear(
        { usuario: 'nuevo.ing', nombre: 'Nuevo Ingestor', password: 'ClaveSegura1', rol: 'ingestor' },
        'Wilber Peralta',
      );
      expect(intentos[0]).toMatchObject({ rol: 'ingestor', roles: ['ingestor'] });
      expect(intentos[1]).toMatchObject({ rol: 'operador' });
      expect(intentos[1]).not.toHaveProperty('roles');
      expect(ingestor.rol).toBe('ingestor');

      // 2. Crear segundo administrador aun con idx_usuarios_un_solo_admin activo
      intentos.length = 0;
      const admin2 = await svc.crear(
        { usuario: 'admin2', nombre: 'Segundo Admin', password: 'ClaveSegura1', rol: 'administrador' },
        'Wilber Peralta',
      );
      expect(intentos[0]).toMatchObject({ rol: 'administrador', roles: ['administrador'] });
      expect(intentos[1]).toMatchObject({ rol: 'admin' });
      expect(intentos[2]).toMatchObject({ rol: 'supervisor' });
      expect(intentos[2].permisos).toContain('gestionar_usuarios');
      expect(admin2.rol).toBe('administrador');
      expect(admin2.permisos).toContain('gestionar_usuarios');
    });

    it('permite cambiar el rol de otra cuenta incluso a administrador con fallback de esquema', async () => {
      const parches: any[] = [];
      const supabaseMock = {
        getClient: () => ({
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'u-otro',
                    usuario: 'darwin',
                    nombre: 'Darwin',
                    rol: 'supervisor',
                    permisos: ['ver_reportes', 'usar_cola', 'editar_campos'],
                    activo: true,
                    creado_en: '2026-11-18T10:00:00Z',
                  },
                  error: null,
                }),
              }),
            }),
            update: (parche: any) => {
              parches.push(parche);
              return {
                eq: () => ({
                  select: () => ({
                    single: async () => {
                      if ('roles' in parche) {
                        return {
                          data: null,
                          error: { code: 'PGRST204', message: "Could not find the 'roles' column" },
                        };
                      }
                      return {
                        data: {
                          id: 'u-otro',
                          usuario: 'darwin',
                          nombre: 'Darwin',
                          rol: parche.rol,
                          permisos: parche.permisos,
                          activo: true,
                          creado_en: '2026-11-18T10:00:00Z',
                        },
                        error: null,
                      };
                    },
                  }),
                }),
              };
            },
          }),
        }),
      } as any;

      const svc = new UsuariosService(supabaseMock);
      const actualizado = await svc.actualizar('u-otro', { rol: 'administrador' }, 'u-wilber', 'Wilber Peralta');
      expect(parches[0]).toMatchObject({ rol: 'administrador', roles: ['administrador'] });
      expect(parches[1]).toMatchObject({ rol: 'admin' });
      expect(actualizado.rol).toBe('administrador');
      expect(actualizado.permisos).toContain('gestionar_usuarios');
    });
  });
});
