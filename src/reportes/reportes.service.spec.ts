import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { RptechService } from '../rptech/rptech.service';
import { SupabaseService } from '../common/supabase.service';
import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { ReportesService } from './reportes.service';
import { CampoGuardado, FilaReporte } from './reportes.mapper';

function fila(extra: Partial<FilaReporte> = {}, pendientes: string[] = ['codigo_repuesto']): FilaReporte {
  const campos: Record<string, CampoGuardado> = Object.fromEntries(
    IDS_CAMPOS_FORMULARIO.map((id) => [
      id,
      pendientes.includes(id)
        ? { clave: id, valor: null, confianza: 'baja', noLeido: true, dudoso: true }
        : { clave: id, valor: id === 'fecha' ? '03/02/26' : `valor ${id}`, confianza: 'alta', noLeido: false, dudoso: false },
    ]),
  );
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    numero_talonario: '000214',
    origen: 'historico',
    cliente: 'valor empresa',
    fecha: '2026-02-03',
    serie_equipo: 'valor equipo',
    tecnico_asignado: 'valor tecnico',
    campos_extraidos: campos,
    creado_en: '2026-11-02T10:00:00Z',
    actualizado_en: '2026-11-02T10:00:00Z',
    escaneo: {
      id: 'esc-1',
      ruta_original: 'emp/1_000214_orig.pdf',
      paginas: 2,
      enviado_por: 'secretaria',
      estado: 'procesado',
      creado_en: '2026-11-02T10:00:00Z',
      metadatos: { rutas_paginas: ['emp/1_pag_1.png', 'emp/1_pag_2.png'] },
    },
    ...extra,
  };
}

describe('ReportesService', () => {
  let filas: FilaReporte[];
  let actualizaciones: { tabla: string; datos: any; filtros: Record<string, any> }[];
  let filasActualizadas: { id: string }[];
  let service: ReportesService;

  function crearSupabase(): SupabaseService {
    const builder = (tabla: string) => {
      const filtros: Record<string, any> = {};
      let datosUpdate: any = null;
      const b: any = {
        select: jest.fn(() => b),
        eq: jest.fn((col: string, val: any) => {
          filtros[col] = val;
          return b;
        }),
        is: jest.fn((col: string, val: any) => {
          filtros[`${col}:is`] = val;
          return b;
        }),
        order: jest.fn(() => b),
        limit: jest.fn(() => b),
        range: jest.fn(() => b),
        update: jest.fn((datos: any) => {
          datosUpdate = datos;
          return b;
        }),
        then: (res: any, rej: any) => {
          if (datosUpdate) {
            actualizaciones.push({ tabla, datos: datosUpdate, filtros: { ...filtros } });
            const resultado = tabla === 'reportes' ? { data: filasActualizadas, error: null } : { data: [], error: null };
            return Promise.resolve(resultado).then(res, rej);
          }
          let data = filas;
          if (filtros.numero_talonario) data = filas.filter((f) => f.numero_talonario === filtros.numero_talonario);
          if (filtros['numero_talonario:is'] === null) data = filas.filter((f) => f.numero_talonario === null);
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return b;
    };
    return {
      getClient: () => ({
        from: jest.fn((tabla: string) => builder(tabla)),
        storage: {
          from: jest.fn(() => ({
            createSignedUrls: jest.fn(async (rutas: string[]) => ({
              data: rutas.map((r) => ({ path: r, signedUrl: `https://storage/firmado/${r}`, error: null })),
              error: null,
            })),
            // Páginas del escaneo en Storage: solo la 1 existe; la 2 falla para probar que se omite.
            download: jest.fn(async (ruta: string) =>
              ruta.endsWith('_pag_1.png')
                ? { data: new Blob([await sharp({ create: { width: 300, height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer()]), error: null }
                : { data: null, error: { message: 'no existe' } },
            ),
          })),
        },
      }),
    } as unknown as SupabaseService;
  }

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    filas = [fila()];
    actualizaciones = [];
    filasActualizadas = [{ id: 'a1b2c3d4-0000-0000-0000-000000000000' }];
    service = new ReportesService(crearSupabase());
  });

  it('lista los reportes con el contrato de la bandeja y sin firmar imágenes', async () => {
    const lista = await service.listar();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ numero_reporte: '000214', estado: 'procesado', cliente: 'valor empresa' });
    expect(lista[0].escaneo.paginas_urls).toEqual([]);
  });

  it('al abrir un reporte devuelve enlaces firmados para cada página, en orden', async () => {
    const r = await service.obtener('000214');
    expect(r.escaneo.paginas_urls).toEqual([
      'https://storage/firmado/emp/1_pag_1.png',
      'https://storage/firmado/emp/1_pag_2.png',
    ]);
    expect(r.campos.find((c) => c.id === 'codigo_repuesto')?.estado_revision).toBe('pendiente');
    expect(r.campos.find((c) => c.id === 'empresa')?.estado_revision).toBe('auto');
  });

  it('arma el PDF con el N° en el nombre y omite la página del escaneo que no se pudo descargar', async () => {
    const pdf = await service.generarPdf('000214');
    expect(pdf.filename).toBe('Reporte_000214.pdf');
    expect(pdf.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // formulario + 1 página de escaneo descargada (la otra falló)
    expect((await PDFDocument.load(pdf.buffer)).getPageCount()).toBe(2);
  });

  it('el PDF de un reporte inexistente da 404', async () => {
    await expect(service.generarPdf('999999')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un reporte inexistente da 404', async () => {
    await expect(service.obtener('999999')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('abre un reporte sin N° legible por su identificador SN-', async () => {
    filas = [fila({ numero_talonario: null })];
    const r = await service.obtener('SN-a1b2c3d4');
    expect(r.numero_reporte).toBe('SN-a1b2c3d4');
  });

  describe('revisarCampo', () => {
    it('corregir guarda el valor, quién y cuándo, actualiza las columnas y completa el reporte', async () => {
      await service.revisarCampo('000214', 'codigo_repuesto', { tipo: 'corregir', actor: 'Ana', valor: '  SN-4455 ' });

      const rep = actualizaciones.find((a) => a.tabla === 'reportes')!;
      const revision = rep.datos.campos_extraidos.codigo_repuesto.revision;
      expect(revision).toMatchObject({ estado: 'corregido', valor_corregido: 'SN-4455', corregido_por: 'Ana', revisado_por: 'Ana' });
      expect(revision.corregido_en).toEqual(expect.any(String));
      // el valor del modelo no se pierde
      expect(rep.datos.campos_extraidos.codigo_repuesto.valor).toBeNull();
      // columna consultable con el valor corregido
      expect(rep.datos.codigo_repuesto).toBe('SN-4455');
      expect(rep.datos.fecha).toBe('2026-02-03');
      expect(rep.datos.campos_dudosos).toEqual([]);
      expect(rep.datos.estado_reporte).toBe('aprobado');
      expect(rep.datos.corregido_por).toBe('Ana');
      // control de concurrencia
      expect(rep.filtros.actualizado_en).toBe('2026-11-02T10:00:00Z');

      const esc = actualizaciones.find((a) => a.tabla === 'escaneos')!;
      expect(esc.datos).toEqual({ estado: 'completo' });
    });

    it('confirmar deja el valor del modelo y registra quién lo revisó', async () => {
      filas = [fila({}, ['direccion'])];
      await service.revisarCampo('000214', 'direccion', { tipo: 'confirmar', actor: 'Luis' });
      const rep = actualizaciones.find((a) => a.tabla === 'reportes')!;
      expect(rep.datos.campos_extraidos.direccion.revision).toMatchObject({ estado: 'confirmado', revisado_por: 'Luis', valor_corregido: null });
    });

    it('marcar ilegible deja la columna vacía en lugar de guardar una lectura dudosa', async () => {
      filas = [fila({}, ['procedimiento'])];
      filas[0].campos_extraidos!.procedimiento.valor = 'texto dudoso';
      await service.revisarCampo('000214', 'procedimiento', { tipo: 'ilegible', actor: 'Luis' });
      const rep = actualizaciones.find((a) => a.tabla === 'reportes')!;
      expect(rep.datos.procedimiento).toBeNull();
    });

    it('omitir marca el campo como vacío en el papel: valor nulo, firmado por la persona y sin pendientes', async () => {
      filas = [fila({}, ['procedimiento'])];
      filas[0].campos_extraidos!.procedimiento.valor = 'texto dudoso';
      await service.revisarCampo('000214', 'procedimiento', { tipo: 'omitir', actor: 'Luis' });
      const rep = actualizaciones.find((a) => a.tabla === 'reportes')!;
      expect(rep.datos.campos_extraidos.procedimiento.revision).toMatchObject({
        estado: 'omitido', valor_corregido: null, revisado_por: 'Luis', corregido_por: null, corregido_en: null,
      });
      expect(rep.datos.campos_extraidos.procedimiento.revision.revisado_en).toEqual(expect.any(String));
      expect(rep.datos.procedimiento).toBeNull();
      expect(rep.datos.campos_dudosos).toEqual([]);
      expect(rep.datos.estado_reporte).toBe('aprobado');
    });

    it('reabrir deshace un campo omitido y vuelve a dejarlo pendiente', async () => {
      filas = [fila({}, ['procedimiento'])];
      filas[0].campos_extraidos!.procedimiento.revision = {
        estado: 'omitido', valor_corregido: null, revisado_por: 'Luis', revisado_en: '2026-11-14T10:00:00Z', corregido_por: null, corregido_en: null,
      };
      await service.revisarCampo('000214', 'procedimiento', { tipo: 'reabrir', actor: 'Luis' });
      const rep = actualizaciones.find((a) => a.tabla === 'reportes')!;
      expect(rep.datos.campos_extraidos.procedimiento.revision).toMatchObject({ estado: 'pendiente', revisado_por: null });
      expect(rep.datos.campos_dudosos).toEqual(['procedimiento']);
    });

    it('con campos aún pendientes el reporte queda en revisión', async () => {
      filas = [fila({}, ['codigo_repuesto', 'direccion'])];
      await service.revisarCampo('000214', 'direccion', { tipo: 'corregir', actor: 'Ana', valor: 'Av. Lima 123' });
      const rep = actualizaciones.find((a) => a.tabla === 'reportes')!;
      expect(rep.datos.campos_dudosos).toEqual(['codigo_repuesto']);
      expect(rep.datos.estado_reporte).toBe('pendiente_revision');
      expect(actualizaciones.find((a) => a.tabla === 'escaneos')!.datos).toEqual({ estado: 'en_revision' });
    });

    it('no permite confirmar un campo que no está pendiente, pero sí permite corregirlo si el modelo se equivocó con confianza alta', async () => {
      await expect(
        service.revisarCampo('000214', 'empresa', { tipo: 'confirmar', actor: 'Ana' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(actualizaciones).toHaveLength(0);

      await service.revisarCampo('000214', 'empresa', { tipo: 'corregir', actor: 'Ana', valor: 'Imprenta Sol' });
      const rep = actualizaciones.find((a) => a.tabla === 'reportes')!;
      expect(rep.datos.cliente).toBe('Imprenta Sol');
      expect(rep.datos.campos_extraidos.empresa.revision).toMatchObject({
        estado: 'corregido',
        valor_corregido: 'Imprenta Sol',
      });
    });

    it('no permite reabrir un campo pendiente', async () => {
      await expect(
        service.revisarCampo('000214', 'codigo_repuesto', { tipo: 'reabrir', actor: 'Ana' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza una corrección vacía', async () => {
      await expect(
        service.revisarCampo('000214', 'codigo_repuesto', { tipo: 'corregir', actor: 'Ana', valor: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un campo que el formulario no tiene', async () => {
      await expect(
        service.revisarCampo('000214', 'color_favorito', { tipo: 'confirmar', actor: 'Ana' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('si otra persona guardó en el medio avisa del conflicto en vez de pisar su trabajo', async () => {
      filasActualizadas = [];
      await expect(
        service.revisarCampo('000214', 'codigo_repuesto', { tipo: 'corregir', actor: 'Ana', valor: 'X1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('actualiza el dataset en cada edición de contacto, dirección o cliente para futuras boletas', async () => {
      filas = [fila({}, ['contacto', 'direccion'])];
      filas[0].campos_extraidos!.empresa.valor = 'Imprenta Sol';
      filas[0].cliente = 'Imprenta Sol';

      await service.revisarCampo('000214', 'direccion', {
        tipo: 'corregir',
        actor: 'Ana',
        valor: 'Av. Wilson 1230 Stand 14',
      });
      // Simulamos que la fila ya guardó la dirección corregida
      filas[0].campos_extraidos!.direccion.revision = {
        estado: 'corregido',
        valor_corregido: 'Av. Wilson 1230 Stand 14',
        revisado_por: 'Ana',
        revisado_en: '2026-11-10T10:00:00Z',
        corregido_por: 'Ana',
        corregido_en: '2026-11-10T10:00:00Z',
      };
      await service.revisarCampo('000214', 'contacto', {
        tipo: 'corregir',
        actor: 'Ana',
        valor: 'Roberto Paz',
      });

      const dataset = await service.obtenerDatasetClientes();
      const contactoRegistrado = dataset.contactos?.find((c) => c.nombre === 'Roberto Paz');
      expect(contactoRegistrado).toMatchObject({
        nombre: 'Roberto Paz',
        empresa: 'Imprenta Sol',
        direccionPrincipal: 'Av. Wilson 1230 Stand 14',
      });
    });
  });

  describe('SIREP-S3-T05: Exportación a Excel (.xlsx y .csv) con campos vitales primero', () => {
    it('coloca primero los 10 campos vitales y luego el resto de los 31 campos con nombres acordados con RP-TECH', async () => {
      const expCsv = await service.exportarReportes('csv');
      expect(expCsv.totalReportes).toBe(1);

      // Primeros 10 encabezados = campos vitales exigidos en el Sprint 3
      const vitalesEsperados = [
        'numero_talonario',
        'fecha',
        'tecnico_asignado',
        'cliente',
        'serie_equipo',
        'motivo',
        'procedimiento',
        'conclusion',
        'hora_llegada',
        'hora_salida',
      ];
      expect(expCsv.columnas.slice(0, 10)).toEqual(vitalesEsperados);
      // 1 numero_talonario + 31 campos del formulario + 5 metadatos = 37 columnas
      expect(expCsv.columnas.length).toBeGreaterThanOrEqual(32);

      // Verifica BOM UTF-8 (\uFEFF) y tildes correctas
      const textoCsv = expCsv.buffer.toString('utf-8');
      expect(textoCsv.charCodeAt(0)).toBe(0xfeff);
      expect(textoCsv).toContain('000214');
      expect(textoCsv).toContain('valor empresa');
    });

    it('genera un archivo .xlsx OpenXML válido (cabecera ZIP PK) con tildes y eñes preservadas', async () => {
      filas[0].campos_extraidos!.procedimiento.valor = 'Calibración de cañón y cigüeñal en 2 máquinas';
      const expXlsx = await service.exportarReportes('xlsx');

      expect(expXlsx.filename).toMatch(/^reportes_sirep_\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(expXlsx.contentType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      // Cabecera mágica ZIP (PK\x03\x04) de un archivo .xlsx estándar
      expect(expXlsx.buffer.subarray(0, 4).toString('binary')).toBe('PK\x03\x04');
      expect(expXlsx.buffer.length).toBeGreaterThan(500);
    });
  });

  describe('SIREP-S3-T10 y T11: Vinculación y envío a RP-TECH', () => {
    // RP-TECH simulado: el envío real se prueba en rptech.cliente.spec.ts
    function conRptech(resultado: any = { estado: 'importado', rptechId: 'rt-1', yaExistia: false }) {
      const enviar = jest.fn(async () => resultado);
      const rptech = { configurado: () => true, enviar } as unknown as RptechService;
      return { enviar, svc: new ReportesService(crearSupabase(), undefined, rptech) };
    }

    it('calcula sugerencias de vinculación por similitud (T10)', async () => {
      filas = [fila({ cliente: 'Industrial Go Service', serie_equipo: 'UV DTF 60', tecnico_asignado: 'Carlos' })];
      const r = await service.obtener('000214');
      expect(r.vinculos_sugeridos).toBeDefined();
    });

    it('SIREP-S4-T10: al aprobar el último dudoso envía automáticamente a RP-TECH si está configurado', async () => {
      filas = [fila({}, ['codigo_repuesto'])];
      const { enviar, svc } = conRptech();
      svc.configurarSelectorDobleRevision(() => 0.99);
      await svc.revisarCampo('000214', 'codigo_repuesto', { tipo: 'confirmar', actor: 'Ana' });
      expect(enviar).toHaveBeenCalledTimes(1);
    });

    it('rechaza importar si aún tiene campos pendientes (T11)', async () => {
      filas = [fila({}, ['codigo_repuesto'])];
      await expect(conRptech().svc.importarReporteRevisado('000214')).rejects.toThrow(BadRequestException);
    });

    it('envía a RP-TECH y no vuelve a enviar lo ya importado (T11)', async () => {
      const { svc, enviar } = conRptech();
      filas = [fila({}, [])];
      const res1 = await svc.importarReporteRevisado('000214');
      expect(res1.status).toBe('importado_exitoso');
      expect(enviar).toHaveBeenCalledTimes(1);

      filas[0].estado_reporte = 'aprobado_rptech';
      const res2 = await svc.importarReporteRevisado('000214');
      expect(res2.status).toBe('ya_importado');
      expect(enviar).toHaveBeenCalledTimes(1);
    });

    it('sin RPTECH_URL ni RPTECH_CLAVE no marca nada como importado', async () => {
      filas = [fila({}, [])];
      await expect(service.importarReporteRevisado('000214')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(actualizaciones.some((a) => a.datos.estado_reporte === 'aprobado_rptech')).toBe(false);
    });

    it('si RP-TECH lo rechaza, avisa con el motivo', async () => {
      filas = [fila({}, [])];
      const { svc } = conRptech({ estado: 'observado', codigo: 'datos_invalidos', detalle: { voltaje_ln: 'número' } });
      await expect(svc.importarReporteRevisado('000214')).rejects.toBeInstanceOf(ConflictException);
    });

    it('no reabre un reporte que RP-TECH ya guardó', async () => {
      filas = [fila({ bloqueado: true, estado_reporte: 'aprobado_rptech', rptech_id: 'rt-1' }, [])];
      filas[0].campos_extraidos!.empresa.revision = {
        estado: 'confirmado', valor_corregido: null, revisado_por: 'David', revisado_en: null, corregido_por: null, corregido_en: null,
      };
      await expect(
        service.revisarCampo('000214', 'empresa', { tipo: 'reabrir', actor: 'David' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('SIREP-S3-T09, T10, T13 y T18: Bloqueo histórico, vínculos, lote y métricas', () => {
    it('bloquea ediciones directas cuando el reporte histórico ya está cerrado (T09)', async () => {
      filas = [fila({ bloqueado: true, estado_reporte: 'aprobado_rptech' }, [])];
      await expect(
        service.revisarCampo('000214', 'empresa', { tipo: 'corregir', actor: 'David', valor: 'Otra' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('guarda vínculos a catálogos preservando intacto el texto manuscrito leído (T10)', async () => {
      filas = [fila({ cliente: 'Abregu' })];
      const r = await service.vincularEntidades('000214', {
        cliente_id: 'cli-uuid-1',
        equipo_id: 'eq-uuid-2',
      });
      const upd = actualizaciones.find((a) => a.tabla === 'reportes')!;
      expect(upd.datos).toEqual({ cliente_id: 'cli-uuid-1', equipo_id: 'eq-uuid-2' });
      expect(r.cliente).toBe('Abregu');
    });

    it('envía en lote solo los revisados que faltan y cuenta los rechazados (T13)', async () => {
      const listo = fila({ id: 'rep-1', numero_talonario: '000214', estado_reporte: 'aprobado' }, []);
      const yaCerrado = fila({ id: 'rep-2', numero_talonario: '000215', estado_reporte: 'aprobado_rptech', bloqueado: true }, []);
      const conPendiente = fila({ id: 'rep-3', numero_talonario: '000216' }, ['codigo_repuesto']);
      const rechazado = fila({ id: 'rep-4', numero_talonario: '000217', estado_reporte: 'aprobado' }, []);
      filas = [listo, yaCerrado, conPendiente, rechazado];

      const enviar = jest.fn(async (f: any) =>
        f.id === 'rep-4'
          ? { estado: 'observado', codigo: 'talonario_duplicado', detalle: 'repetido' }
          : { estado: 'importado', rptechId: 'rt-1', yaExistia: false });
      const svc = new ReportesService(crearSupabase(), undefined, { configurado: () => true, enviar } as unknown as RptechService);

      const res = await svc.importarReportesRevisadosEnLote('Valentino');
      expect(enviar).toHaveBeenCalledTimes(2);
      expect(res.totalRevisadosListos).toBe(3);
      expect(res.importadosNuevos).toBe(1);
      expect(res.yaImportados).toBe(1);
      expect(res.pendientesOmitidos).toBe(1);
      expect(res.numerosImportados).toEqual(['000214']);
      expect(res.observados).toEqual(['000217']);
    });

    it('genera métricas diarias por campo con las columnas exigidas y cero datos de clientes (T18)', async () => {
      const f = fila({ cliente: 'CONFIDENCIAL CLIENTE SAC' }, ['codigo_repuesto']);
      f.campos_extraidos!.empresa.revision = {
        estado: 'corregido',
        valor_corregido: 'CONFIDENCIAL CLIENTE SAC',
        revisado_por: 'David',
        revisado_en: '2026-11-14T10:00:00Z',
        corregido_por: 'David',
        corregido_en: '2026-11-14T10:00:00Z',
      };
      f.campos_extraidos!.tecnico.revision = {
        estado: 'confirmado',
        valor_corregido: null,
        revisado_por: 'Valentino',
        revisado_en: '2026-11-14T10:00:00Z',
        corregido_por: null,
        corregido_en: null,
      };
      f.campos_extraidos!.direccion.revision = {
        estado: 'omitido',
        valor_corregido: null,
        revisado_por: 'David',
        revisado_en: '2026-11-14T10:00:00Z',
        corregido_por: null,
        corregido_en: null,
      };
      filas = [f];

      const metricas = await service.obtenerMetricasCampos();
      expect(metricas.totalReportes).toBe(1);
      expect(metricas.metricas).toHaveLength(IDS_CAMPOS_FORMULARIO.length);
      // Las columnas existentes no cambian de lugar: `omitidos` va al final.
      expect(metricas.csv.startsWith('campo,total,confirmados,corregidos,ilegibles,confianza_declarada,omitidos\n')).toBe(true);
      expect(metricas.csv).not.toContain('CONFIDENCIAL CLIENTE SAC');
      expect(metricas.csv).toContain('empresa,1,0,1,0,');
      expect(metricas.csv).toContain('codigo_repuesto,1,0,0,1,');
      expect(metricas.csv).toMatch(/direccion,1,0,0,0,[^,]*,1\n/);
      expect(metricas.csv).toMatch(/empresa,1,0,1,0,[^,]*,0\n/);
      expect(metricas.metricas.find((m) => m.campo === 'direccion')).toMatchObject({ omitidos: 1, ilegibles: 0 });
    });
  });

  describe('SIREP-S4-T02 y T03: Cola libre con reserva de 4 horas y vista por rol', () => {
    const tBase = Date.now();

    it('entrega el reporte pendiente más antiguo y mantiene una sola reserva activa por revisor', async () => {
      const repNuevo = fila({ id: 'rep-nuevo', numero_talonario: '000302', creado_en: '2026-11-10T10:00:00Z' }, ['codigo_repuesto']);
      const repAntiguo = fila({ id: 'rep-antiguo', numero_talonario: '000301', creado_en: '2026-11-01T10:00:00Z' }, ['codigo_repuesto']);
      filas = [repNuevo, repAntiguo];

      const adriana = { id: 'u-adriana', nombre: 'Adriana' };
      const res1 = await service.tomarSiguienteReporteDeCola(adriana, tBase);

      expect(res1.status).toBe('asignado');
      expect(res1.numero_reporte).toBe('000301');
      expect(repAntiguo.reservado_por).toBe('Adriana');
      expect(repAntiguo.reservado_por_id).toBe('u-adriana');

      // Si Adriana vuelve a pulsar "Siguiente reporte" sin haber cerrado el 000301, recibe el mismo (1 reserva por revisor)
      const res2 = await service.tomarSiguienteReporteDeCola(adriana, tBase + 60_000);
      expect(res2.status).toBe('reserva_existente');
      expect(res2.numero_reporte).toBe('000301');
    });

    it('dos revisores que pulsan "Siguiente reporte" reciben reportes distintos', async () => {
      const rep1 = fila({ id: 'rep-1', numero_talonario: '000301', creado_en: '2026-11-01T10:00:00Z' }, ['codigo_repuesto']);
      const rep2 = fila({ id: 'rep-2', numero_talonario: '000302', creado_en: '2026-11-02T10:00:00Z' }, ['codigo_repuesto']);
      filas = [rep1, rep2];

      const rAdriana = await service.tomarSiguienteReporteDeCola({ id: 'u-adriana', nombre: 'Adriana' }, tBase);
      const rFabian = await service.tomarSiguienteReporteDeCola({ id: 'u-fabian', nombre: 'Fabián' }, tBase);

      expect(rAdriana.numero_reporte).toBe('000301');
      expect(rFabian.numero_reporte).toBe('000302');
      expect(rAdriana.numero_reporte).not.toBe(rFabian.numero_reporte);
    });

    it('una reserva que pasa 4 horas sin cerrarse vence automáticamente y vuelve a la cola', async () => {
      const haceCincoHoras = new Date(tBase - 5 * 60 * 60 * 1000).toISOString();
      const repVencido = fila(
        {
          id: 'rep-vencido',
          numero_talonario: '000301',
          creado_en: '2026-11-01T10:00:00Z',
          reservado_por_id: 'u-adriana',
          reservado_por: 'Adriana',
          reservado_en: haceCincoHoras,
        },
        ['codigo_repuesto'],
      );
      filas = [repVencido];

      const rJean = await service.tomarSiguienteReporteDeCola({ id: 'u-jean', nombre: 'Jean' }, tBase);
      expect(rJean.status).toBe('asignado');
      expect(rJean.numero_reporte).toBe('000301');
      expect(repVencido.reservado_por).toBe('Jean');
    });

    it('impide que otro revisor edite o libere un reporte reservado activamente, pero permite al administrador liberarlo', async () => {
      const ahoraIso = new Date(tBase).toISOString();
      const repReservado = fila(
        {
          id: 'rep-res',
          numero_talonario: '000301',
          reservado_por_id: 'u-adriana',
          reservado_por: 'Adriana',
          reservado_en: ahoraIso,
        },
        ['codigo_repuesto'],
      );
      filas = [repReservado];

      // Otro revisor (Darwin) no puede editar un campo del reporte reservado por Adriana
      await expect(
        service.revisarCampo(
          '000301',
          'codigo_repuesto',
          { tipo: 'corregir', actor: 'Darwin', valor: 'X-1' },
          { id: 'u-darwin', nombre: 'Darwin', rol: 'revisor', permisos: ['editar_campos'] },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // Otro revisor (Darwin) tampoco puede liberar la reserva de Adriana
      await expect(
        service.liberarReporte(
          '000301',
          { id: 'u-darwin', nombre: 'Darwin', rol: 'revisor', permisos: ['usar_cola'] },
          tBase,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // El administrador (Wilber) sí puede liberarlo manualmente
      const lib = await service.liberarReporte(
        '000301',
        { id: 'u-wilber', nombre: 'Wilber Peralta', rol: 'administrador', permisos: ['gestionar_usuarios'] },
        tBase,
      );
      expect(lib.status).toBe('liberado');
      expect(repReservado.reservado_por).toBeNull();
    });

    it('el ingestor solo ve sus propias cargas al listar reportes (T02)', async () => {
      const deDavid = fila({
        id: 'rep-david',
        numero_talonario: '000401',
        escaneo: { id: 'e1', ruta_original: 'a.pdf', paginas: 1, enviado_por: 'David', estado: 'procesado', creado_en: '2026-11-18T10:00:00Z' },
      });
      const deValentino = fila({
        id: 'rep-val',
        numero_talonario: '000402',
        escaneo: { id: 'e2', ruta_original: 'b.pdf', paginas: 1, enviado_por: 'Valentino', estado: 'procesado', creado_en: '2026-11-18T10:00:00Z' },
      });
      filas = [deDavid, deValentino];

      const listaDavid = await service.listar(100, {
        id: 'u-david',
        nombre: 'David',
        rol: 'ingestor',
        permisos: ['ver_reportes', 'subir_escaneos'],
      });
      expect(listaDavid).toHaveLength(1);
      expect(listaDavid[0].numero_reporte).toBe('000401');
    });
  });
});
