import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ClaveIaUsuarioService,
  clasificarCupo,
  esFalloDeClave,
  ordenarModelos,
  prioridadParaProbar,
} from './clave-usuario.service';
import { IaConfigService, MODELO_GEMINI_POR_DEFECTO } from './ia-config.service';

/** Supabase en memoria con la tabla claves_ia_usuario (una fila por usuario). */
function supabaseFalso() {
  const filas = new Map<string, any>();
  const cliente = {
    from: () => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => ({ data: filas.has(id) ? { ...filas.get(id) } : null, error: null }),
        }),
        order: async () => ({
          data: [...filas.values()].map((f) => ({ ...f, usuario: { nombre: 'Ana', usuario: 'ana', rol: 'operador' } })),
          error: null,
        }),
      }),
      upsert: async (registro: any) => {
        filas.set(registro.usuario_id, { lecturas: 0, ...filas.get(registro.usuario_id), ...registro });
        return { error: null };
      },
      update: (cambios: any) => ({
        eq: async (_c: string, id: string) => {
          if (filas.has(id)) filas.set(id, { ...filas.get(id), ...cambios });
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (_c: string, id: string) => {
          filas.delete(id);
          return { error: null };
        },
      }),
    }),
  };
  return { filas, servicio: { getClient: () => cliente } as any };
}

const CLAVE = 'AIzaSyClavePersonalDeAna1234';
const respuesta = (status: number, cuerpo: unknown = {}) =>
  new Response(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), { status });

function crear(fetchImpl?: (url: string, init?: any) => Promise<Response>) {
  const db = supabaseFalso();
  const ia = new IaConfigService({ get: (k: string) => ({ AUTH_JWT_SECRET: 'secreto-de-prueba' })[k] } as any, db.servicio);
  ia.fetchFn = (fetchImpl ?? (async () => respuesta(200, {}))) as any;
  return { db, ia, claves: new ClaveIaUsuarioService(ia, db.servicio) };
}

describe('Clave de Gemini por usuario', () => {
  it('guarda la clave cifrada, la prueba antes y nunca la devuelve', async () => {
    const llamadas: string[] = [];
    const { db, claves } = crear(async (url) => {
      llamadas.push(url);
      return respuesta(200, {});
    });
    const estado = await claves.guardar('u-ana', { clave: CLAVE });

    expect(llamadas[0]).toContain(`/models/${MODELO_GEMINI_POR_DEFECTO}`); // se probó antes de guardar
    const fila = db.filas.get('u-ana');
    expect(fila.clave_cifrada).not.toContain(CLAVE);
    expect(fila.clave_cifrada.startsWith('v1:')).toBe(true);
    expect(JSON.stringify(estado)).not.toContain(CLAVE);
    expect(estado).toMatchObject({ configurada: true, final: '1234', activa: true, modelo: MODELO_GEMINI_POR_DEFECTO });
  });

  it('no guarda una clave que Gemini rechaza', async () => {
    const { db, claves } = crear(async () => respuesta(400, { error: { message: 'API key not valid' } }));
    await expect(claves.guardar('u-ana', { clave: CLAVE })).rejects.toThrow(BadRequestException);
    expect(db.filas.has('u-ana')).toBe(false);
  });

  it('el modelo por defecto es gemini-3.5-flash-lite', async () => {
    expect(MODELO_GEMINI_POR_DEFECTO).toBe('gemini-3.5-flash-lite');
    const { claves } = crear();
    expect((await claves.estado('u-sin-clave')).modelo).toBe('gemini-3.5-flash-lite');
  });

  it('lectorPara: devuelve el lector personal solo si hay clave activa', async () => {
    const { claves } = crear();
    expect(await claves.lectorPara('u-ana')).toBeNull();
    await claves.guardar('u-ana', { clave: CLAVE });
    const personal = await claves.lectorPara('u-ana');
    expect(personal?.usuarioId).toBe('u-ana');
    expect(personal?.lector.modelo).toBe(MODELO_GEMINI_POR_DEFECTO);
    // Mismo lector mientras no cambie la clave ni el modelo
    expect((await claves.lectorPara('u-ana'))?.lector).toBe(personal?.lector);

    await claves.guardar('u-ana', { activa: false });
    expect(await claves.lectorPara('u-ana')).toBeNull();
    expect(await claves.lectorPara(undefined)).toBeNull();
  });

  it('cada persona tiene su propio lector (no se mezclan las claves)', async () => {
    const { claves } = crear();
    await claves.guardar('u-ana', { clave: CLAVE });
    await claves.guardar('u-luis', { clave: 'AIzaSyClavePersonalDeLuis5678' });
    const ana = await claves.lectorPara('u-ana');
    const luis = await claves.lectorPara('u-luis');
    expect(ana?.lector).not.toBe(luis?.lector);
    expect(luis?.final).toBe('5678');
  });

  it('anota lecturas y errores, y quitar la clave la borra', async () => {
    const { db, claves } = crear();
    await claves.guardar('u-ana', { clave: CLAVE });
    await claves.registrarUso('u-ana');
    await claves.registrarError('u-ana', 'HTTP 429: cuota agotada');
    const estado = await claves.estado('u-ana');
    expect(estado.lecturas).toBe(1);
    expect(estado.ultimo_error).toContain('429');
    await claves.quitar('u-ana');
    expect(db.filas.has('u-ana')).toBe(false);
  });

  it('solo el administrador ve la lista de claves, y sin las claves', async () => {
    const { claves } = crear();
    await claves.guardar('u-ana', { clave: CLAVE });
    await expect(claves.listarParaAdmin('operador')).rejects.toThrow(ForbiddenException);
    const lista = await claves.listarParaAdmin('admin');
    expect(lista[0]).toMatchObject({ usuario_id: 'u-ana', nombre: 'Ana', final: '1234' });
    expect(JSON.stringify(lista)).not.toContain(CLAVE);
    expect(JSON.stringify(lista)).not.toContain('clave_cifrada');
  });

  it('sin sesión no se puede ver ni guardar una clave', async () => {
    const { claves } = crear();
    await expect(claves.estado(undefined)).rejects.toThrow(ForbiddenException);
    await expect(claves.guardar(undefined, { clave: CLAVE })).rejects.toThrow(ForbiddenException);
  });

  it('modelos: marca cuáles tienen cupo gratuito y pone primero el de por defecto', async () => {
    const { claves } = crear(async (url) => {
      if (url.includes('/models?')) {
        return respuesta(200, {
          models: ['gemini-2.5-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'].map((m) => ({
            name: `models/${m}`,
            supportedGenerationMethods: ['generateContent'],
          })),
        });
      }
      if (url.includes('gemini-2.5-pro')) return respuesta(429, 'Quota exceeded ... limit: 0, model: gemini-2.5-pro');
      return respuesta(200, { candidates: [] });
    });
    const r = await claves.modelos('u-ana', { clave: CLAVE });
    expect(r.ok).toBe(true);
    expect(r.modelos[0]).toMatchObject({ id: 'gemini-3.5-flash-lite', cupo: 'gratuito', por_defecto: true });
    expect(r.modelos.find((m) => m.id === 'gemini-2.5-pro')?.cupo).toBe('sin_cupo_gratuito');
    expect(r.modelos[r.modelos.length - 1]?.id).toBe('gemini-2.5-pro');
  });
});

describe('Reglas puras', () => {
  it('clasificarCupo', () => {
    expect(clasificarCupo(200, '')).toBe('gratuito');
    expect(clasificarCupo(429, 'Quota exceeded for metric ... limit: 0')).toBe('sin_cupo_gratuito');
    expect(clasificarCupo(429, 'Quota exceeded for metric ... limit: 15')).toBe('limite_alcanzado');
    expect(clasificarCupo(404, '')).toBe('no_disponible');
    expect(clasificarCupo(500, '')).toBe('sin_probar');
  });

  it('esFalloDeClave: inválida, sin permiso o sin cupo pasan a la clave de la empresa; un 503 no', () => {
    expect(esFalloDeClave({ codigoHttp: 429 })).toBe(true);
    expect(esFalloDeClave({ codigoHttp: 400, message: 'API key not valid' })).toBe(true);
    expect(esFalloDeClave({ codigoHttp: 403 })).toBe(true);
    expect(esFalloDeClave({ codigoHttp: 503, message: 'high demand' })).toBe(false);
    expect(esFalloDeClave(new Error('red caída'))).toBe(false);
  });

  it('prioridadParaProbar: por defecto, luego estables flash-lite, flash y pro; preview y latest al final', () => {
    expect(
      prioridadParaProbar(['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite']),
    ).toEqual(['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-3.1-pro-preview']);
  });

  it('ordenarModelos: por defecto, luego gratuitos, al final los de pago', () => {
    const r = ordenarModelos([
      { id: 'pro', cupo: 'sin_cupo_gratuito', por_defecto: false },
      { id: 'flash', cupo: 'gratuito', por_defecto: false },
      { id: 'lite', cupo: 'gratuito', por_defecto: true },
    ]);
    expect(r.map((m) => m.id)).toEqual(['lite', 'flash', 'pro']);
  });
});
