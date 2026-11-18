import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CifradorClaves, IaConfigService, finalDeClave, limpiarModelo } from './ia-config.service';

/** Supabase en memoria con la única fila de configuracion_ia. */
function supabaseFalso(opciones: { sinTabla?: boolean } = {}) {
  const estado: { fila: any } = { fila: null };
  const cliente = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            opciones.sinTabla
              ? { data: null, error: { message: 'relation "configuracion_ia" does not exist' } }
              : { data: estado.fila ? { ...estado.fila } : null, error: null },
        }),
      }),
      upsert: async (registro: any) => {
        estado.fila = { ...registro };
        return { error: null };
      },
      update: (cambios: any) => ({
        eq: async () => {
          estado.fila = { ...estado.fila, ...cambios };
          return { error: null };
        },
      }),
    }),
  };
  return { estado, servicio: { getClient: () => cliente } as any };
}

function configFalsa(env: Record<string, string>) {
  return { get: (k: string) => env[k] } as any;
}

const CLAVE_GEMINI = 'AIzaSyEjemploDeClaveGemini1234';
const CLAVE_OPENAI = 'sk-proj-ejemploDeClaveOpenAI5678';

describe('IaConfigService', () => {
  const envBase = { AUTH_JWT_SECRET: 'secreto-de-prueba', GEMINI_API_KEY: 'AIzaEntornoGemini0000' };
  // Sin fila guardada se usa la fábrica de siempre, que lee process.env directamente
  const anterior = { ...process.env };
  beforeEach(() => {
    delete process.env.IA_PROVEEDOR;
    delete process.env.IA_PROVIDER;
    process.env.GEMINI_API_KEY = envBase.GEMINI_API_KEY;
  });
  afterAll(() => {
    process.env = anterior;
  });

  it('solo el administrador principal puede verlo y cambiarlo', async () => {
    const { servicio } = supabaseFalso();
    const ia = new IaConfigService(configFalsa(envBase), servicio);
    await expect(ia.estado('supervisor')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ia.estado('operador')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ia.guardar({ proveedor: 'openai' }, 'operador', 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ia.estado('admin')).resolves.toBeDefined();
  });

  it('sin nada guardado usa las variables de entorno, como antes', async () => {
    const { servicio } = supabaseFalso();
    const ia = new IaConfigService(configFalsa(envBase), servicio);
    const e = await ia.estado('admin');
    expect(e.origen).toBe('servidor');
    expect(e.proveedor).toBe('gemini');
    expect(e.claves.gemini).toEqual({ configurada: true, final: '0000', origen: 'servidor' });
    expect(e.claves.openai.configurada).toBe(false);
    const lector = await ia.lectorActual();
    expect(lector.nombre).toBe('gemini');
  });

  it('guarda una clave por proveedor y al cambiar de proveedor la otra se conserva', async () => {
    const { estado, servicio } = supabaseFalso();
    const ia = new IaConfigService(configFalsa(envBase), servicio);

    await ia.guardar({ proveedor: 'openai', clave_openai: CLAVE_OPENAI, modelo_openai: 'gpt-4.1-mini' }, 'admin', 'Ana');
    expect((await ia.lectorActual()).nombre).toBe('openai');
    expect((await ia.lectorActual()).modelo).toBe('gpt-4.1-mini');

    await ia.guardar({ proveedor: 'gemini', clave_gemini: CLAVE_GEMINI }, 'admin', 'Ana');
    expect((await ia.lectorActual()).nombre).toBe('gemini');

    // Vuelve a ChatGPT sin pegar la clave: sigue guardada
    const e = await ia.guardar({ proveedor: 'openai' }, 'admin', 'Ana');
    expect(e.claves.openai).toEqual({ configurada: true, final: '5678', origen: 'pantalla' });
    expect(e.claves.gemini).toEqual({ configurada: true, final: '1234', origen: 'pantalla' });
    expect(e.modelos.openai).toBe('gpt-4.1-mini');
    expect(e.actualizado_por).toBe('Ana');

    // En la base nunca queda la clave en texto plano
    expect(JSON.stringify(estado.fila)).not.toContain(CLAVE_OPENAI);
    expect(JSON.stringify(estado.fila)).not.toContain(CLAVE_GEMINI);
    // Y la respuesta a la pantalla tampoco la trae
    expect(JSON.stringify(e)).not.toContain(CLAVE_OPENAI);
  });

  it('no deja activo un proveedor sin clave', async () => {
    const { servicio } = supabaseFalso();
    const ia = new IaConfigService(configFalsa(envBase), servicio);
    await expect(ia.guardar({ proveedor: 'openai' }, 'admin', 'Ana')).rejects.toThrow('primero pega su API key');
  });

  it('no deja quitar la clave del proveedor en uso', async () => {
    const { servicio } = supabaseFalso();
    const ia = new IaConfigService(configFalsa({ AUTH_JWT_SECRET: 's' }), servicio);
    await ia.guardar({ proveedor: 'openai', clave_openai: CLAVE_OPENAI }, 'admin', 'Ana');
    await expect(ia.quitarClave('openai', 'admin', 'Ana')).rejects.toBeInstanceOf(BadRequestException);
    await ia.guardar({ proveedor: 'openai', clave_gemini: CLAVE_GEMINI }, 'admin', 'Ana');
    const e = await ia.quitarClave('gemini', 'admin', 'Ana');
    expect(e.claves.gemini.configurada).toBe(false);
  });

  it('si falta la tabla (migración sin correr) sigue funcionando con el .env y avisa al guardar', async () => {
    const { servicio } = supabaseFalso({ sinTabla: true });
    const ia = new IaConfigService(configFalsa(envBase), servicio);
    expect((await ia.lectorActual()).nombre).toBe('gemini');
    expect((await ia.estado('admin')).disponible).toBe(false);
    await expect(ia.guardar({ proveedor: 'gemini' }, 'admin', 'Ana')).rejects.toThrow('configuracion_ia');
  });

  it('si cambia el secreto del servidor la clave guardada se marca ilegible en vez de romper', async () => {
    const { estado, servicio } = supabaseFalso();
    const antes = new IaConfigService(configFalsa({ AUTH_JWT_SECRET: 'uno' }), servicio);
    await antes.guardar({ proveedor: 'openai', clave_openai: CLAVE_OPENAI }, 'admin', 'Ana');
    const despues = new IaConfigService(configFalsa({ AUTH_JWT_SECRET: 'dos' }), servicio);
    const e = await despues.estado('admin');
    expect(e.claves.openai).toEqual(expect.objectContaining({ configurada: false, ilegible: true }));
    expect(estado.fila.clave_openai_cifrada).toBeTruthy();
  });

  it('probar conexión consulta el modelo con la clave en la cabecera y traduce los errores', async () => {
    const { servicio } = supabaseFalso();
    const ia = new IaConfigService(configFalsa(envBase), servicio);
    const llamadas: Array<[string, any]> = [];
    ia.fetchFn = (async (url: string, init: any) => {
      llamadas.push([url, init]);
      return { ok: url.includes('gpt-4o-mini'), status: url.includes('no-existe') ? 404 : 401 } as any;
    }) as any;

    const ok = await ia.probar({ proveedor: 'openai', modelo: 'gpt-4o-mini', clave: CLAVE_OPENAI }, 'admin');
    expect(ok.ok).toBe(true);
    expect(llamadas[0][0]).toBe('https://api.openai.com/v1/models/gpt-4o-mini');
    expect(llamadas[0][1].headers.Authorization).toBe(`Bearer ${CLAVE_OPENAI}`);

    const mala = await ia.probar({ proveedor: 'openai', modelo: 'gpt-4.1', clave: CLAVE_OPENAI }, 'admin');
    expect(mala).toEqual({ ok: false, mensaje: 'La API key de ChatGPT no es válida.' });

    const sinModelo = await ia.probar({ proveedor: 'gemini', modelo: 'no-existe', clave: CLAVE_GEMINI }, 'admin');
    expect(sinModelo.mensaje).toContain('no existe');
    expect(llamadas[2][1].headers['x-goog-api-key']).toBe(CLAVE_GEMINI);
  });
});

describe('utilidades de configuración de IA', () => {
  it('cifra y descifra, y cada cifrado es distinto', () => {
    const c = new CifradorClaves('secreto');
    const a = c.cifrar('sk-123456789');
    expect(a).not.toBe(c.cifrar('sk-123456789'));
    expect(c.descifrar(a)).toBe('sk-123456789');
    expect(() => new CifradorClaves('otro').descifrar(a)).toThrow();
  });

  it('muestra solo los 4 últimos caracteres', () => {
    expect(finalDeClave('sk-abcdefgh1234')).toBe('1234');
    expect(finalDeClave('corta')).toBe('••••');
    expect(finalDeClave('')).toBeNull();
  });

  it('rechaza nombres de modelo raros', () => {
    expect(limpiarModelo(' gpt-4.1-mini ')).toBe('gpt-4.1-mini');
    expect(limpiarModelo('')).toBeNull();
    expect(() => limpiarModelo('gpt 4; drop')).toThrow(BadRequestException);
  });
});
