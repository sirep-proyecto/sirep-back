import { EscaneosService, EscaneoDuplicadoError } from './escaneos.service';
import { SupabaseService } from '../common/supabase.service';
import { LectorDeReportes, ResultadoLectura } from '../ia-extractor/types';
import { calcularHuellaSHA256 } from './escaneos.util';
import { InternalServerErrorException, Logger } from '@nestjs/common';

describe('Backend 2: EscaneosService', () => {
  let service: EscaneosService;
  let mockSupabase: any;
  let mockLectorIA: LectorDeReportes;

  beforeAll(() => {
    // Silencia logs intencionales durante pruebas para mantener la consola limpia
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    const mockClient = {
      from: jest.fn(),
      storage: {
        from: jest.fn().mockReturnValue({
          upload: jest.fn().mockResolvedValue({ data: { path: 'test' }, error: null }),
        }),
      },
    };
    mockSupabase = {
      getClient: jest.fn().mockReturnValue(mockClient),
    };

    mockLectorIA = {
      nombre: 'mock-ia',
      modelo: 'mock-model',
      leer: jest.fn().mockResolvedValue({
        numeroReporte: '000845',
        campos: [
          { clave: 'tecnico', valor: 'Angelo / Fabian', confianza: 'alta', noLeido: false, dudoso: false },
          { clave: 'empresa', valor: 'Minera Los Andes', confianza: 'alta', noLeido: false, dudoso: false },
          { clave: 'fecha', valor: '15-10-26', confianza: 'alta', noLeido: false, dudoso: false },
          { clave: 'procedimiento', valor: 'Cambio de rodamiento', confianza: 'media', noLeido: false, dudoso: false },
          { clave: 'codigo_repuesto', valor: null, confianza: 'baja', noLeido: true, dudoso: true },
        ],
        uso: {
          proveedor: 'mock-ia',
          modelo: 'mock-model',
          tokensEntrada: 1000,
          tokensSalida: 200,
          costoUsd: 0.0001,
          latenciaMs: 150,
        },
        salidaCruda: '{"test": true}',
      } as ResultadoLectura),
    };

    service = new EscaneosService(mockSupabase as SupabaseService);
    service.setLectorIA(mockLectorIA);
  });

  it('rechaza un archivo con la misma huella SHA-256 avisando archivo_duplicado', async () => {
    const buffer = Buffer.from('contenido-del-reporte-845');
    const huella = calcularHuellaSHA256(buffer);

    mockSupabase.getClient().from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'uuid-existente', numero_reporte: '000845' },
        error: null,
      }),
    });

    try {
      await service.procesarEscaneo({ buffer, filename: '000845.pdf' });
      fail('Debió lanzar EscaneoDuplicadoError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(EscaneoDuplicadoError);
      expect(err.tipoDuplicado).toBe('archivo_duplicado');
      expect(err.message).toContain('Este archivo ya fue enviado anteriormente');
    }
  });

  it('rechaza un número de reporte que ya existe para la misma empresa avisando reporte_duplicado', async () => {
    const buffer = Buffer.from('contenido-nuevo-pero-mismo-numero');

    mockSupabase.getClient().from.mockImplementation(() => {
      const eqMock = jest.fn();
      eqMock.mockImplementation((campo: string, valor: any) => {
        if (campo === 'huella') {
          return { maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) };
        }
        if (campo === 'empresa_id') {
          return {
            eq: jest.fn().mockImplementation((c2: string, v2: any) => {
              if (c2 === 'numero_reporte' && (v2 === '000845' || v2 === '0005-A')) {
                return {
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: { id: 'uuid-previo', numero_reporte: v2 },
                    error: null,
                  }),
                };
              }
              return { maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) };
            }),
          };
        }
        return { maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) };
      });

      return {
        select: jest.fn().mockReturnThis(),
        eq: eqMock,
      };
    });

    try {
      await service.procesarEscaneo({
        buffer,
        caption: 'Reporte N° 000845',
        filename: 'scan.pdf',
      });
      fail('Debió lanzar EscaneoDuplicadoError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(EscaneoDuplicadoError);
      expect(err.tipoDuplicado).toBe('reporte_duplicado');
      expect(err.message).toContain('El reporte N° 000845 ya se encuentra registrado');
    }
  });

  it('un reporte nuevo se guarda con su original y queda marcado en_revision si hay campos dudosos', async () => {
    const buffer = Buffer.from('contenido-valido-unico');

    const mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { id: 'nuevo-escaneo-uuid' }, error: null }),
    };
    mockSupabase.getClient().from.mockReturnValue(mockQueryBuilder);

    const resultado = await service.procesarEscaneo({
      buffer,
      filename: '000845.pdf',
      caption: '000845',
      mimetype: 'application/pdf',
      enviadoPor: 'secretaria',
    });

    expect(resultado.escaneoId).toBe('nuevo-escaneo-uuid');
    expect(resultado.numeroReporte).toBe('000845');
    expect(resultado.estado).toBe('en_revision');
    expect(resultado.camposDudosos).toContain('codigo_repuesto');
    expect(resultado.campos.empresa.valor).toBe('Minera Los Andes');
  });

  it('lanza InternalServerErrorException si la subida del original a Storage falla', async () => {
    const buffer = Buffer.from('contenido-para-falla-storage');

    mockSupabase.getClient().from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    });

    mockSupabase.getClient().storage.from.mockReturnValue({
      upload: jest.fn().mockResolvedValue({ data: null, error: new Error('Bucket no accesible') }),
    });

    await expect(
      service.procesarEscaneo({
        buffer,
        filename: '000845.pdf',
        caption: '000845',
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('lanza InternalServerErrorException si falla la inserción en base de datos', async () => {
    const buffer = Buffer.from('contenido-para-falla-bd');

    mockSupabase.getClient().storage.from.mockReturnValue({
      upload: jest.fn().mockResolvedValue({ data: { path: 'ok' }, error: null }),
    });

    mockSupabase.getClient().from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: new Error('Fallo de constraint en BD') }),
    });

    await expect(
      service.procesarEscaneo({
        buffer,
        filename: '000845.pdf',
        caption: '000845',
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
