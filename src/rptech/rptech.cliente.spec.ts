import { createHash } from 'crypto';
import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { CampoGuardado, FilaReporte } from '../reportes/reportes.mapper';
import { configDesdeEntorno, enviarReporte, listoParaEnviar } from './rptech.cliente';

const PDF = Buffer.from('%PDF-1.7 escaneo de prueba');
const CFG = { url: 'https://rptech.test/functions/v1/importar-historico', clave: 'clave-sirep' };

function fila(extra: Partial<FilaReporte> = {}): FilaReporte {
  const campos: Record<string, CampoGuardado> = Object.fromEntries(
    IDS_CAMPOS_FORMULARIO.map((id) => [id, { clave: id, valor: null, confianza: 'alta', noLeido: false, dudoso: false }]),
  );
  return {
    id: 'sirep-1', numero_talonario: '004512', origen: 'historico', cliente: null, fecha: null, serie_equipo: null,
    tecnico_asignado: null, campos_extraidos: campos, creado_en: '', actualizado_en: '',
    escaneo: { id: 'esc-1', ruta_original: 'emp/1_orig.pdf', paginas: 1, enviado_por: null, estado: 'completo', creado_en: '' },
    ...extra,
  };
}

/** Supabase simulado: guarda cada update y entrega el PDF de Storage. */
function supabaseFalso(archivo: Buffer | null = PDF) {
  const updates: { tabla: string; datos: any; id: any }[] = [];
  const client: any = {
    storage: {
      from: () => ({
        download: async () => (archivo ? { data: new Blob([new Uint8Array(archivo)]), error: null } : { data: null, error: { message: 'no existe' } }),
      }),
    },
    from: (tabla: string) => ({
      update: (datos: any) => ({
        eq: async (_c: string, id: any) => {
          updates.push({ tabla, datos, id });
          return { error: null };
        },
      }),
    }),
  };
  return { client, updates };
}

const responder = (status: number, cuerpo: unknown) =>
  jest.fn(async () => new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } }));

describe('Envío a RP-TECH', () => {
  it('solo se configura con URL y clave', () => {
    expect(configDesdeEntorno({ RPTECH_URL: 'u', RPTECH_CLAVE: 'c' })).toEqual({ url: 'u', clave: 'c' });
    expect(configDesdeEntorno({ RPTECH_URL: 'u' })).toBeNull();
  });

  it('envía la clave, el escaneo y su SHA-256, sin los ids de SIREP', async () => {
    const { client } = supabaseFalso();
    const fetchFalso = responder(201, { id: 'rt-1', resultado: 'creado' });
    await enviarReporte(client, fila({ cliente_id: 'c-sirep' }), CFG, fetchFalso as any);
    const [url, init] = fetchFalso.mock.calls[0] as any;
    const cuerpo = JSON.parse(init.body);
    expect(url).toBe(CFG.url);
    expect(init.headers['x-sirep-clave']).toBe('clave-sirep');
    expect(cuerpo.escaneo.tipo).toBe('application/pdf');
    expect(cuerpo.escaneo.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(Buffer.from(cuerpo.escaneo.contenido_base64, 'base64').equals(PDF)).toBe(true);
    expect(cuerpo).not.toHaveProperty('cliente_id');
  });

  it('201 o 200: marca aprobado_rptech con el id de RP-TECH', async () => {
    for (const [status, ya] of [[201, false], [200, true]] as const) {
      const { client, updates } = supabaseFalso();
      const r = await enviarReporte(client, fila(), CFG, responder(status, { id: 'rt-1' }) as any);
      expect(r).toEqual({ estado: 'importado', rptechId: 'rt-1', yaExistia: ya });
      const u = updates.find((x) => x.tabla === 'reportes')!;
      expect(u.datos).toMatchObject({ estado_reporte: 'aprobado_rptech', bloqueado: true, rptech_id: 'rt-1', rptech_error: null });
      expect(updates.some((x) => x.tabla === 'escaneos' && x.datos.estado === 'completo')).toBe(true);
    }
  });

  it('409 y 422: queda observado con el motivo, sin marcar importado', async () => {
    const { client, updates } = supabaseFalso();
    const r = await enviarReporte(client, fila(), CFG,
      responder(422, { codigo: 'datos_invalidos', campos: { voltaje_ln: 'debe ser un número' } }) as any);
    expect(r.estado).toBe('observado');
    expect(updates[0].datos).toMatchObject({
      estado_reporte: 'observado',
      rptech_error: { codigo: 'datos_invalidos', detalle: { voltaje_ln: 'debe ser un número' } },
    });
    expect(updates.some((x) => x.datos.estado_reporte === 'aprobado_rptech')).toBe(false);
  });

  it('500 o sin conexión: no cambia el estado, queda para reintentar', async () => {
    const { client, updates } = supabaseFalso();
    const caido = jest.fn(async () => { throw new Error('ECONNRESET'); });
    const r = await enviarReporte(client, fila(), CFG, caido as any);
    expect(r.estado).toBe('reintentar');
    expect(updates[0].datos).not.toHaveProperty('estado_reporte');
    expect(updates[0].datos.rptech_error.codigo).toBe('reintentar');

    const r500 = await enviarReporte(client, fila(), CFG, responder(500, { codigo: 'error_interno' }) as any);
    expect(r500.estado).toBe('reintentar');
  });

  it('401: no toca el reporte (el problema es la clave)', async () => {
    const { client, updates } = supabaseFalso();
    const r = await enviarReporte(client, fila(), CFG, responder(401, { codigo: 'clave_invalida' }) as any);
    expect(r.estado).toBe('clave_invalida');
    expect(updates).toHaveLength(0);
  });

  it('sin escaneo legible: observado, sin llamar a RP-TECH', async () => {
    const { client, updates } = supabaseFalso(null);
    const fetchFalso = responder(201, { id: 'x' });
    const r = await enviarReporte(client, fila(), CFG, fetchFalso as any);
    expect(r.estado).toBe('observado');
    expect(fetchFalso).not.toHaveBeenCalled();
    expect(updates[0].datos.estado_reporte).toBe('observado');
  });

  it('solo se envían históricos revisados que aún no están en RP-TECH', () => {
    expect(listoParaEnviar(fila(), false)).toBe(true);
    expect(listoParaEnviar(fila(), true)).toBe(false);
    expect(listoParaEnviar(fila({ origen: 'sistema' }), false)).toBe(false);
    expect(listoParaEnviar(fila({ estado_reporte: 'aprobado_rptech' }), false)).toBe(false);
  });
});
