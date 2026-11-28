import { ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { PERMISOS_POR_ROL } from '../auth/permisos';
import { UsuariosService } from '../auth/usuarios.service';
import { SupabaseService } from '../common/supabase.service';
import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { RptechService } from '../rptech/rptech.service';
import { ReportesController } from './reportes.controller';
import { CampoGuardado, FilaReporte, aReporteContrato } from './reportes.mapper';
import { ReportesService } from './reportes.service';
import {
  EventoRevision,
  TableroService,
  calcularCoincidenciaDobleRevision,
  calcularProyeccionTermino,
  calcularSesionesDesdeEventos,
  detectarAlertasCalidad,
} from './tablero.service';

function filaBase(extra: Partial<FilaReporte> = {}, pendientes: string[] = ['codigo_repuesto']): FilaReporte {
  const campos: Record<string, CampoGuardado> = Object.fromEntries(
    IDS_CAMPOS_FORMULARIO.map((id) => [
      id,
      pendientes.includes(id)
        ? { clave: id, valor: null, confianza: 'baja', noLeido: true, dudoso: true }
        : {
            clave: id,
            valor: id === 'fecha' ? '2026-11-19' : `val-${id}`,
            confianza: 'alta',
            noLeido: false,
            dudoso: false,
          },
    ]),
  );

  return {
    id: 'rep-1111-2222',
    numero_talonario: '000501',
    origen: 'historico',
    estado_reporte: pendientes.length > 0 ? 'pendiente_revision' : 'aprobado',
    cliente: 'val-empresa',
    fecha: '2026-11-19',
    serie_equipo: 'val-equipo',
    tecnico_asignado: 'val-tecnico',
    campos_extraidos: campos,
    creado_en: '2026-11-19T08:00:00-05:00',
    actualizado_en: '2026-11-19T08:00:00-05:00',
    escaneo: {
      id: 'esc-1',
      ruta_original: 'emp/501.pdf',
      paginas: 1,
      enviado_por: 'David',
      telegram_chat_id: null,
      estado: pendientes.length > 0 ? 'procesado' : 'completo',
      creado_en: '2026-11-19T08:00:00-05:00',
      metadatos: { rutas_paginas: ['emp/501.webp'] },
    },
    ...extra,
  };
}

describe('Sprint 4 Entrega 2: Eventos inmutables, Sesiones 20 min, Tablero, Doble revisión y RP-TECH automático', () => {
  describe('SIREP-S4-T06: Sesiones activas con umbral de 20 minutos', () => {
    it('agrupa acciones separadas por < 20 min y corta la sesión cuando pasan >= 20 min', () => {
      const eventos = [
        // Sesión 1: 08:00 -> 10:00 (120 min, saltos de 18-19 min)
        '2026-11-19T08:00:00-05:00',
        '2026-11-19T08:19:00-05:00',
        '2026-11-19T08:38:00-05:00',
        '2026-11-19T08:57:00-05:00',
        '2026-11-19T09:16:00-05:00',
        '2026-11-19T09:35:00-05:00',
        '2026-11-19T09:54:00-05:00',
        '2026-11-19T10:00:00-05:00',
        // Pausa de 4 horas -> NO suma tiempo muerto
        // Sesión 2: 14:00 -> 14:30 (30 min)
        '2026-11-19T14:00:00-05:00',
        '2026-11-19T14:15:00-05:00',
        '2026-11-19T14:30:00-05:00',
      ];

      const res = calcularSesionesDesdeEventos(eventos);
      expect(res.sesiones).toHaveLength(2);
      expect(res.sesiones[0].duracion_minutos).toBe(120);
      expect(res.sesiones[1].duracion_minutos).toBe(30);
      expect(res.minutos_activos).toBe(150);
      expect(res.horas_activas).toBe(2.5);
    });

    it('considera exactamente 20 minutos como corte de sesión y 19 min 59 s como continua', () => {
      const corteExacto = calcularSesionesDesdeEventos([
        '2026-11-19T08:00:00-05:00',
        '2026-11-19T08:20:00-05:00',
      ]);
      expect(corteExacto.sesiones).toHaveLength(2);
      expect(corteExacto.minutos_activos).toBe(0);

      const continua = calcularSesionesDesdeEventos([
        '2026-11-19T08:00:00-05:00',
        '2026-11-19T08:19:59-05:00',
      ]);
      expect(continua.sesiones).toHaveLength(1);
      expect(continua.minutos_activos).toBeGreaterThan(19);
    });
  });

  describe('SIREP-S4-T07: Fecha estimada de término y alertas de calidad', () => {
    it('la fecha estimada de término cambia cuando cambia el ritmo diario de revisión', () => {
      const ref = new Date('2026-11-19T15:00:00-05:00');
      const ritmoLento = calcularProyeccionTermino(100, { '2026-11-19': 10 }, ref);
      const ritmoRapido = calcularProyeccionTermino(100, { '2026-11-19': 25 }, ref);

      expect(ritmoLento.promedio_diario_revisados).toBe(10);
      expect(ritmoLento.dias_restantes_estimados).toBe(10);
      expect(ritmoLento.fecha_estimada_termino).toBe('2026-11-29');

      expect(ritmoRapido.promedio_diario_revisados).toBe(25);
      expect(ritmoRapido.dias_restantes_estimados).toBe(4);
      expect(ritmoRapido.fecha_estimada_termino).toBe('2026-11-23');
      expect(ritmoRapido.fecha_estimada_termino).not.toBe(ritmoLento.fecha_estimada_termino);
    });

    it('detecta alerta de calidad cuando un reporte se cierra en < 2 minutos y con 0 correcciones', () => {
      const fRapido = filaBase({ numero_talonario: '000601' }, []);
      fRapido.campos_extraidos!.codigo_repuesto = {
        clave: 'codigo_repuesto',
        valor: 'ABC',
        confianza: 'baja',
        dudoso: true,
        revision: {
          estado: 'confirmado',
          valor_corregido: null,
          revisado_por: 'Adriana',
          revisado_en: '2026-11-19T10:00:40-05:00',
          corregido_por: null,
          corregido_en: null,
        },
      };

      const fConCorreccion = filaBase({ id: 'rep-2', numero_talonario: '000602' }, []);
      fConCorreccion.campos_extraidos!.codigo_repuesto = {
        clave: 'codigo_repuesto',
        valor: 'XYZ',
        confianza: 'baja',
        dudoso: true,
        revision: {
          estado: 'corregido',
          valor_corregido: 'XYZ-1',
          revisado_por: 'Adriana',
          revisado_en: '2026-11-19T10:05:30-05:00',
          corregido_por: 'Adriana',
          corregido_en: '2026-11-19T10:05:30-05:00',
        },
      };

      const eventos: EventoRevision[] = [
        {
          usuario_id: 'u-adriana',
          usuario: 'Adriana',
          reporte: '000601',
          campo: null,
          tipo_accion: 'tomar',
          detalle: {},
          creado_en: '2026-11-19T10:00:00-05:00',
        },
        {
          usuario_id: 'u-adriana',
          usuario: 'Adriana',
          reporte: '000601',
          campo: null,
          tipo_accion: 'cerrar',
          detalle: {},
          creado_en: '2026-11-19T10:00:45-05:00',
        },
        {
          usuario_id: 'u-adriana',
          usuario: 'Adriana',
          reporte: '000602',
          campo: null,
          tipo_accion: 'tomar',
          detalle: {},
          creado_en: '2026-11-19T10:05:00-05:00',
        },
      ];

      const alertas = detectarAlertasCalidad([fRapido, fConCorreccion], eventos, 2);
      expect(alertas).toHaveLength(1);
      expect(alertas[0]).toMatchObject({
        numero_reporte: '000601',
        revisor: 'Adriana',
        campos_corregidos: 0,
      });
      expect(alertas[0].duracion_minutos).toBeLessThan(2);
    });

    it('el tablero y los eventos solo son accesibles para administrador (403 a ingestor y revisor)', async () => {
      const config = { get: jest.fn((k: string) => (k === 'AUTH_JWT_SECRET' ? 'secreto' : undefined)) } as any;
      const cuentas: Record<string, any> = {
        wilber: { id: 'u-wilber', usuario: 'wilber', nombre: 'Wilber Peralta', rol: 'administrador', permisos: PERMISOS_POR_ROL.administrador, activo: true },
        david: { id: 'u-david', usuario: 'david', nombre: 'David', rol: 'ingestor', permisos: PERMISOS_POR_ROL.ingestor, activo: true },
        adriana: { id: 'u-adriana', usuario: 'adriana', nombre: 'Adriana', rol: 'revisor', permisos: PERMISOS_POR_ROL.revisor, activo: true },
      };
      const usuariosMock = {
        obtenerParaSesion: jest.fn(async (id: string) => Object.values(cuentas).find((c) => c.id === id) ?? null),
      } as unknown as UsuariosService;

      const auth = new AuthService(config, usuariosMock);
      const guard = new AuthGuard(auth, new Reflector());
      const ctxDe = (handler: Function, clave: 'wilber' | 'david' | 'adriana') => {
        const token = auth.emitirToken({ ...cuentas[clave], email: `${clave}@sirep.local` });
        return {
          switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` }, query: {} }) }),
          getHandler: () => handler,
          getClass: () => ReportesController,
        } as unknown as ExecutionContext;
      };

      await expect(guard.canActivate(ctxDe(ReportesController.prototype.obtenerTablero, 'wilber'))).resolves.toBe(true);
      await expect(guard.canActivate(ctxDe(ReportesController.prototype.obtenerTablero, 'david'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(guard.canActivate(ctxDe(ReportesController.prototype.obtenerTablero, 'adriana'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(guard.canActivate(ctxDe(ReportesController.prototype.listarEventos, 'adriana'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('SIREP-S4-T05, T06 y T07: Consolidación real en TableroService', () => {
    it('consolida métricas de revisores, ingestores, reservas y proyección sin salir en cero', async () => {
      const usuarios = [
        { id: 'u-wilber', usuario: 'wilber', nombre: 'Wilber Peralta', rol: 'administrador', permisos: PERMISOS_POR_ROL.administrador, activo: true },
        { id: 'u-david', usuario: 'david', nombre: 'David', rol: 'ingestor', permisos: PERMISOS_POR_ROL.ingestor, activo: true },
        { id: 'u-adriana', usuario: 'adriana', nombre: 'Adriana', rol: 'revisor', permisos: PERMISOS_POR_ROL.revisor, activo: true },
      ];
      const cerrado = filaBase({ id: 'r1', numero_talonario: '000701', estado_reporte: 'aprobado' }, []);
      const enCola = filaBase({ id: 'r2', numero_talonario: '000702' }, ['codigo_repuesto']);
      const ahora = Date.parse('2026-11-19T15:00:00-05:00');
      const reservado = filaBase(
        {
          id: 'r3',
          numero_talonario: '000703',
          reservado_por_id: 'u-adriana',
          reservado_por: 'Adriana',
          reservado_en: '2026-11-19T14:30:00-05:00',
        },
        ['codigo_repuesto'],
      );
      const eventosDb: EventoRevision[] = [
        { usuario_id: 'u-david', usuario: 'David', reporte: '000701', campo: null, tipo_accion: 'subir', detalle: { resultado: 'procesado' }, creado_en: '2026-11-19T08:00:00-05:00' },
        { usuario_id: 'u-david', usuario: 'David', reporte: '000702', campo: null, tipo_accion: 'subir', detalle: { resultado: 'duplicado' }, creado_en: '2026-11-19T08:05:00-05:00' },
        { usuario_id: 'u-david', usuario: 'David', reporte: null, campo: null, tipo_accion: 'subir', detalle: { resultado: 'error' }, creado_en: '2026-11-19T08:10:00-05:00' },
        { usuario_id: 'u-adriana', usuario: 'Adriana', reporte: '000701', campo: null, tipo_accion: 'tomar', detalle: {}, creado_en: '2026-11-19T09:00:00-05:00' },
        { usuario_id: 'u-adriana', usuario: 'Adriana', reporte: '000701', campo: 'codigo_repuesto', tipo_accion: 'corregir', detalle: {}, creado_en: '2026-11-19T09:10:00-05:00' },
        { usuario_id: 'u-adriana', usuario: 'Adriana', reporte: '000701', campo: null, tipo_accion: 'cerrar', detalle: {}, creado_en: '2026-11-19T09:15:00-05:00' },
      ];

      const supabaseMock = {
        getClient: () => ({
          from: (tabla: string) => {
            const chain: any = {
              select: () => chain,
              eq: () => chain,
              order: () => chain,
              limit: () => chain,
              range: () => chain,
              then: (res: any, rej: any) => {
                if (tabla === 'usuarios') return Promise.resolve({ data: usuarios, error: null }).then(res, rej);
                if (tabla === 'reportes') return Promise.resolve({ data: [cerrado, enCola, reservado], error: null }).then(res, rej);
                if (tabla === 'escaneos') return Promise.resolve({ data: [{ id: 'esc-1', numero_reporte: '000701', enviado_por: 'David', creado_en: '2026-11-19T08:00:00-05:00' }], error: null }).then(res, rej);
                if (tabla === 'eventos_revision') return Promise.resolve({ data: eventosDb, error: null }).then(res, rej);
                return Promise.resolve({ data: [], error: null }).then(res, rej);
              },
            };
            return chain;
          },
        }),
      } as unknown as SupabaseService;

      const tablero = new TableroService(supabaseMock);
      const res = await tablero.obtenerTablero(ahora);

      expect(res.resumen).toMatchObject({
        subidos: 3,
        en_cola: 1,
        en_revision: 1,
        revisados: 1,
      });
      expect(res.reservas_activas).toHaveLength(1);
      expect(res.reservas_activas[0].numero_reporte).toBe('000703');
      expect(res.proyeccion.promedio_diario_revisados).toBe(1);
      expect(res.proyeccion.dias_restantes_estimados).toBe(2);

      const adriana = res.revisores.find((r) => r.nombre === 'Adriana')!;
      expect(adriana.reportes_cerrados).toBe(1);
      expect(adriana.campos_corregidos).toBe(1);
      expect(adriana.minutos_activos).toBe(15);
      expect(adriana.horas_activas).toBe(0.25);

      const david = res.ingestores.find((i) => i.nombre === 'David')!;
      expect(david.pdfs_subidos).toBe(1);
      expect(david.duplicados).toBe(1);
      expect(david.errores).toBe(1);
    });
  });

  describe('SIREP-S4-T08 y T10: Doble revisión a ciegas del 5% y envío automático a RP-TECH', () => {
    it('calcula el porcentaje de coincidencia campo por campo entre 1ª y 2ª revisión', () => {
      const base1 = Object.fromEntries(IDS_CAMPOS_FORMULARIO.map((id) => [id, `v-${id}`]));
      const base2 = { ...base1, codigo_repuesto: 'DISTINTO-99' };
      const res = calcularCoincidenciaDobleRevision(base1, base2);

      expect(res.campos_totales).toBe(IDS_CAMPOS_FORMULARIO.length);
      expect(res.campos_coincidentes).toBe(IDS_CAMPOS_FORMULARIO.length - 1);
      expect(res.discrepancias).toEqual([
        { campo: 'codigo_repuesto', valor_primera: 'v-codigo_repuesto', valor_segunda: 'DISTINTO-99' },
      ]);
      expect(res.porcentaje_coincidencia).toBeLessThan(100);
    });

    it('flujo completo de doble revisión a ciegas (5%) ocultando la 1ª revisión y bloqueando al mismo revisor', async () => {
      const filasDb: FilaReporte[] = [filaBase({}, ['codigo_repuesto'])];
      const eventosRegistrados: any[] = [];

      const supabaseMock = {
        getClient: () => ({
          from: (tabla: string) => {
            let updatePayload: any = null;
            let insertPayload: any = null;
            const chain: any = {
              select: () => chain,
              eq: () => chain,
              is: () => chain,
              order: () => chain,
              limit: () => chain,
              range: () => chain,
              update: (p: any) => {
                updatePayload = p;
                return chain;
              },
              insert: (p: any) => {
                insertPayload = p;
                return chain;
              },
              then: (res: any, rej: any) => {
                if (insertPayload) {
                  if (tabla === 'eventos_revision') eventosRegistrados.push(insertPayload);
                  return Promise.resolve({ data: [insertPayload], error: null }).then(res, rej);
                }
                if (updatePayload) {
                  if (tabla === 'reportes') {
                    Object.assign(filasDb[0], updatePayload);
                    return Promise.resolve({ data: [{ id: filasDb[0].id }], error: null }).then(res, rej);
                  }
                  return Promise.resolve({ data: [], error: null }).then(res, rej);
                }
                return Promise.resolve({ data: tabla === 'reportes' ? filasDb : [], error: null }).then(res, rej);
              },
            };
            return chain;
          },
          storage: {
            from: () => ({
              createSignedUrls: async () => ({ data: [], error: null }),
            }),
          },
        }),
      } as unknown as SupabaseService;

      const tablero = new TableroService(supabaseMock);
      const enviar = jest.fn(async () => ({ estado: 'importado', rptechId: 'rt-doble-1', yaExistia: false }));
      const rptech = { configurado: () => true, enviar } as unknown as RptechService;
      const svc = new ReportesService(supabaseMock, undefined, rptech, tablero);

      // Fuerzo el 5% para esta prueba
      svc.configurarSelectorDobleRevision(() => 0.02);

      // 1. Adriana revisa y corrige `codigo_repuesto` -> cae en doble revisión
      const trasPrimera = await svc.revisarCampo(
        '000501',
        'codigo_repuesto',
        { tipo: 'corregir', actor: 'Adriana', valor: 'REP-100' },
        { id: 'u-adriana', nombre: 'Adriana', rol: 'revisor', permisos: ['editar_campos'] },
      );

      // No se envía aún a RP-TECH ni revela el valor de Adriana
      expect(enviar).not.toHaveBeenCalled();
      expect(trasPrimera.doble_revision_pendiente).toBe(true);
      expect(trasPrimera.estado_reporte).toBe('pendiente_revision');
      const campoOculto = trasPrimera.campos.find((c: any) => c.id === 'codigo_repuesto')!;
      expect(campoOculto.estado_revision).toBe('pendiente');
      expect(campoOculto.valor_corregido).toBeNull();
      expect(aReporteContrato(filasDb[0]).doble_revision_coincidencia).toBeNull();

      // 2. Adriana no puede tomar ni volver a revisar ese mismo reporte
      const colaAdriana = await svc.tomarSiguienteReporteDeCola({ id: 'u-adriana', nombre: 'Adriana' });
      expect(colaAdriana.status).toBe('cola_vacia');
      await expect(
        svc.revisarCampo(
          '000501',
          'codigo_repuesto',
          { tipo: 'corregir', actor: 'Adriana', valor: 'REP-100' },
          { id: 'u-adriana', nombre: 'Adriana', rol: 'revisor', permisos: ['editar_campos'] },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // 3. Fabián (2° revisor) sí recibe el reporte y lo completa coincidiendo con REP-100
      const colaFabian = await svc.tomarSiguienteReporteDeCola({ id: 'u-fabian', nombre: 'Fabián' });
      expect(colaFabian.status).toBe('asignado');
      expect(colaFabian.numero_reporte).toBe('000501');

      const trasSegunda = await svc.revisarCampo(
        '000501',
        'codigo_repuesto',
        { tipo: 'corregir', actor: 'Fabián', valor: 'REP-100' },
        { id: 'u-fabian', nombre: 'Fabián', rol: 'revisor', permisos: ['editar_campos'] },
      );

      expect(trasSegunda.doble_revision_pendiente).toBe(false);
      expect(trasSegunda.doble_revision_estado).toBe('completada');
      expect(trasSegunda.doble_revision_coincidencia).toBe(100);
      // Al completar la 2ª revisión queda aprobado y se envía automáticamente a RP-TECH (T10)
      expect(enviar).toHaveBeenCalledTimes(1);
      expect(eventosRegistrados.some((e) => e.tipo_accion === 'cerrar')).toBe(true);
    });

    it('SIREP-S4-T10: si el envío automático a RP-TECH falla, no rompe la revisión y conserva el estado listo para reintento', async () => {
      const filasDb: FilaReporte[] = [filaBase({}, ['codigo_repuesto'])];
      const supabaseMock = {
        getClient: () => ({
          from: () => {
            let updatePayload: any = null;
            const chain: any = {
              select: () => chain,
              eq: () => chain,
              is: () => chain,
              order: () => chain,
              limit: () => chain,
              range: () => chain,
              update: (p: any) => {
                updatePayload = p;
                return chain;
              },
              insert: () => chain,
              then: (res: any, rej: any) => {
                if (updatePayload) Object.assign(filasDb[0], updatePayload);
                return Promise.resolve({ data: updatePayload ? [{ id: filasDb[0].id }] : filasDb, error: null }).then(res, rej);
              },
            };
            return chain;
          },
          storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
        }),
      } as unknown as SupabaseService;

      const enviar = jest.fn(async () => ({ estado: 'clave_invalida' as const }));
      const svc = new ReportesService(
        supabaseMock,
        undefined,
        { configurado: () => true, enviar } as unknown as RptechService,
        new TableroService(supabaseMock),
      );
      svc.configurarSelectorDobleRevision(() => 0.99);

      const res = await svc.revisarCampo('000501', 'codigo_repuesto', {
        tipo: 'corregir',
        actor: 'Adriana',
        valor: 'REP-500',
      });

      expect(enviar).toHaveBeenCalledTimes(1);
      expect(res.estado).toBe('completo');
      expect(res.rptech_error).toEqual({
        codigo: 'clave_invalida',
        detalle: 'RP-TECH rechazó la clave de SIREP. Revisa RPTECH_CLAVE.',
      });
    });
  });
});
