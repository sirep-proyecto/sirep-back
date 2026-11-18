import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { ActividadInterceptor, RegistrarActividad } from './actividad.interceptor';
import { ActividadService } from './actividad.service';

describe('Bitácora de actividad por cuenta', () => {
  class Ejemplo {
    @RegistrarActividad('campo_revisado', (req) => ({ reporte: req.params.numero, tipo: req.body.tipo }))
    revisar() {}
    sinRegistro() {}
  }

  const contexto = (handler: Function, req: any) =>
    ({
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  it('anota quién hizo la acción, cuál fue y sobre qué reporte, solo si la acción terminó bien', async () => {
    const registrar = jest.fn();
    const interceptor = new ActividadInterceptor(new Reflector(), { registrar } as unknown as ActividadService);
    const req = {
      usuario: { id: 'u1', nombre: 'Ana' },
      params: { numero: '000214' },
      body: { tipo: 'corregir', valor: 'dato-privado' },
    };

    await new Promise<void>((ok) =>
      interceptor.intercept(contexto(Ejemplo.prototype.revisar, req), { handle: () => of({}) }).subscribe({ complete: ok }),
    );

    expect(registrar).toHaveBeenCalledWith(req.usuario, 'campo_revisado', { reporte: '000214', tipo: 'corregir' });
  });

  it('no registra nada en rutas sin anotar', async () => {
    const registrar = jest.fn();
    const interceptor = new ActividadInterceptor(new Reflector(), { registrar } as unknown as ActividadService);
    await new Promise<void>((ok) =>
      interceptor
        .intercept(contexto(Ejemplo.prototype.sinRegistro, { usuario: { nombre: 'Ana' } }), { handle: () => of({}) })
        .subscribe({ complete: ok }),
    );
    expect(registrar).not.toHaveBeenCalled();
  });

  it('registrar no rompe la acción si la tabla no existe o la base falla', async () => {
    const insert = jest.fn().mockResolvedValue({ error: { code: '42P01', message: 'relation does not exist' } });
    const servicio = new ActividadService({ getClient: () => ({ from: () => ({ insert }) }) } as any);
    expect(() => servicio.registrar({ id: 'u1', nombre: 'Ana' }, 'sesion_iniciada')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(insert).toHaveBeenCalledWith({ usuario_id: 'u1', usuario: 'Ana', accion: 'sesion_iniciada', detalle: {} });

    const roto = new ActividadService({ getClient: () => ({ from: () => ({ insert: () => Promise.reject(new Error('caído')) }) }) } as any);
    expect(() => roto.registrar({ nombre: 'Ana' }, 'x')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('sin nombre de cuenta no registra', () => {
    const insert = jest.fn();
    const servicio = new ActividadService({ getClient: () => ({ from: () => ({ insert }) }) } as any);
    servicio.registrar(undefined, 'x');
    expect(insert).not.toHaveBeenCalled();
  });
});
