import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { limpiarPermisos, permisosEfectivos } from './permisos';
import { RequierePermiso } from './requiere-permiso.decorator';
import { hashearPassword, UsuariosService, verificarPassword } from './usuarios.service';

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
});
