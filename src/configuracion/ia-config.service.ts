import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { SupabaseService } from '../common/supabase.service';
import { crearLectorDeReportes } from '../ia-extractor/ia-extractor.factory';
import { LectorDeReportes } from '../ia-extractor/types';
import { MODELO_OPENAI_POR_DEFECTO } from '../ia-extractor/openai.proveedor';
import { claveDeEntorno, ocultarClaves } from '../ia-extractor/lectura-comun';

export { claveDeEntorno, ocultarClaves };

/**
 * Proveedor de IA elegido desde la app (Configuración > Lectura con IA).
 *
 * - Se puede leer con Gemini o con ChatGPT (OpenAI). Se guarda UNA CLAVE POR PROVEEDOR:
 *   al cambiar de uno a otro, la del otro queda guardada para volver sin pegarla de nuevo.
 * - Las claves se guardan cifradas (AES-256-GCM). La pantalla nunca recibe una clave: solo
 *   si hay una y sus 4 últimos caracteres.
 * - Si no hay nada guardado (o la tabla aún no existe) se usa lo de las variables de
 *   entorno, como antes. Así desplegar esto antes de correr la migración no rompe nada.
 * - Solo el administrador principal (rol admin) puede verlo y cambiarlo: la clave cobra
 *   a la cuenta de quien la pone.
 */
export type ProveedorIa = 'gemini' | 'openai';
export const PROVEEDORES_IA: readonly ProveedorIa[] = ['gemini', 'openai'];

// Modelo por defecto: liviano, rápido y con cupo gratuito amplio.
export const MODELO_GEMINI_POR_DEFECTO = 'gemini-3.5-flash-lite';

/** Sugerencias para el selector; se puede escribir cualquier otro modelo. */
export const MODELOS_SUGERIDOS: Record<ProveedorIa, string[]> = {
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5-mini'],
};

const ETIQUETA: Record<ProveedorIa, string> = { gemini: 'Gemini', openai: 'ChatGPT' };
const TABLA = 'configuracion_ia';
// Cuánto se reutiliza la fila leída. Al guardar desde la pantalla se borra al instante.
const VIGENCIA_CACHE_MS = 30_000;

interface FilaConfig {
  proveedor: ProveedorIa;
  modelo_gemini: string | null;
  modelo_openai: string | null;
  clave_gemini_cifrada: string | null;
  clave_openai_cifrada: string | null;
  actualizado_por: string | null;
  actualizado_en: string | null;
}

export interface EstadoClave {
  configurada: boolean;
  /** Últimos 4 caracteres, para reconocerla sin mostrarla. */
  final: string | null;
  /** 'pantalla' = guardada desde la app; 'servidor' = variable de entorno; null = no hay. */
  origen: 'pantalla' | 'servidor' | null;
  /** Hay una guardada pero no se puede descifrar (cambió el secreto del servidor). */
  ilegible?: boolean;
}

export interface EstadoIa {
  proveedor: ProveedorIa;
  modelos: Record<ProveedorIa, string>;
  claves: Record<ProveedorIa, EstadoClave>;
  /** 'pantalla' si manda lo guardado en la app; 'servidor' si se usan las variables de entorno. */
  origen: 'pantalla' | 'servidor';
  /** false si la tabla no existe todavía (falta correr la migración). */
  disponible: boolean;
  actualizado_por: string | null;
  actualizado_en: string | null;
  modelos_sugeridos: Record<ProveedorIa, string[]>;
}

export interface CambioIa {
  proveedor?: unknown;
  modelo_gemini?: unknown;
  modelo_openai?: unknown;
  /** Vacío o ausente = se deja la clave guardada. */
  clave_gemini?: unknown;
  clave_openai?: unknown;
}

export function esProveedorIa(v: unknown): v is ProveedorIa {
  return typeof v === 'string' && (PROVEEDORES_IA as readonly string[]).includes(v);
}

export function finalDeClave(clave: string | null | undefined): string | null {
  const c = (clave ?? '').trim();
  return c.length >= 8 ? c.slice(-4) : c ? '••••' : null;
}

/** Nombre de modelo razonable: letras, números, puntos, guiones, dos puntos y barra. */
export function limpiarModelo(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  const m = String(valor).trim();
  if (!m) return null;
  if (m.length > 80 || !/^[A-Za-z0-9._:\/-]+$/.test(m)) {
    throw new BadRequestException(`Nombre de modelo inválido: "${m.slice(0, 80)}"`);
  }
  return m;
}

function limpiarClave(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  const c = String(valor).trim();
  if (!c) return null;
  if (c.length < 10 || c.length > 300 || !/^[\x21-\x7e]+$/.test(c)) {
    throw new BadRequestException('La clave no tiene un formato válido. Cópiala completa, sin espacios ni saltos de línea.');
  }
  return c;
}


/** Cifrado simétrico con una llave derivada del secreto del servidor. Formato v1:iv:tag:datos (base64). */
export class CifradorClaves {
  private readonly llave: Buffer;

  constructor(secreto: string) {
    if (!secreto) throw new Error('Falta IA_CLAVES_SECRETO o AUTH_JWT_SECRET para cifrar las claves de IA');
    // Etiqueta propia: aunque el secreto sea el mismo que el de las sesiones, la llave es otra.
    this.llave = createHash('sha256').update(`sirep:claves-ia:${secreto}`).digest();
  }

  cifrar(texto: string): string {
    const iv = randomBytes(12);
    const cifra = createCipheriv('aes-256-gcm', this.llave, iv);
    const datos = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
    return ['v1', iv.toString('base64'), cifra.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
  }

  descifrar(guardado: string): string {
    const [version, iv, tag, datos] = guardado.split(':');
    if (version !== 'v1' || !iv || !tag || !datos) throw new Error('formato de clave cifrada desconocido');
    const descifra = createDecipheriv('aes-256-gcm', this.llave, Buffer.from(iv, 'base64'));
    descifra.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([descifra.update(Buffer.from(datos, 'base64')), descifra.final()]).toString('utf8');
  }
}

@Injectable()
export class IaConfigService {
  private readonly logger = new Logger(IaConfigService.name);
  private cache: { fila: FilaConfig | null; disponible: boolean; leidoEn: number } | null = null;
  private lector: { firma: string; lector: LectorDeReportes } | null = null;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly supabase?: SupabaseService,
  ) {}

  /** Se reemplaza en las pruebas para no llamar a Google ni a OpenAI. */
  fetchFn: typeof fetch = (...args) => globalThis.fetch(...args);

  puedeCambiar(rol: string | undefined): boolean {
    const r = String(rol ?? '').trim().toLowerCase();
    return r === 'admin' || r === 'administrador';
  }

  private exigirAdmin(rol: string | undefined) {
    if (!this.puedeCambiar(rol)) {
      throw new ForbiddenException('Solo el administrador principal puede ver y cambiar el proveedor de IA.');
    }
  }

  /** Público: las claves personales (claves_ia_usuario) se cifran con la misma llave. */
  cifrador(): CifradorClaves {
    const secreto =
      this.config.get<string>('IA_CLAVES_SECRETO')?.trim() || this.config.get<string>('AUTH_JWT_SECRET')?.trim() || '';
    return new CifradorClaves(secreto);
  }

  private env(nombre: string): string {
    return this.config.get<string>(nombre)?.trim() || '';
  }

  private proveedorDeEntorno(): ProveedorIa {
    const p = (this.env('IA_PROVEEDOR') || this.env('IA_PROVIDER') || 'gemini').toLowerCase();
    return p === 'openai' ? 'openai' : 'gemini';
  }

  private claveEntorno(p: ProveedorIa): string {
    const nombre = p === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
    const crudo = this.env(nombre);
    const clave = claveDeEntorno(crudo);
    if (crudo && clave !== crudo) {
      this.logger.warn(`${nombre} trae más de un valor (¿se pegó otra línea del .env?); se usa solo la primera palabra.`);
    }
    return clave;
  }

  private modeloEntorno(p: ProveedorIa): string {
    const global = this.env('IA_MODELO') || this.env('IA_MODEL');
    // IA_MODELO es del proveedor del .env; para el otro no sirve
    const delProveedor = p === this.proveedorDeEntorno() ? global : '';
    return (
      delProveedor ||
      this.env(p === 'gemini' ? 'GEMINI_MODEL' : 'OPENAI_MODEL') ||
      (p === 'gemini' ? MODELO_GEMINI_POR_DEFECTO : MODELO_OPENAI_POR_DEFECTO)
    );
  }

  private async leerFila(forzar = false): Promise<{ fila: FilaConfig | null; disponible: boolean }> {
    if (!forzar && this.cache && Date.now() - this.cache.leidoEn < VIGENCIA_CACHE_MS) return this.cache;
    if (!this.supabase) return { fila: null, disponible: false };
    try {
      const { data, error } = await this.supabase.getClient().from(TABLA).select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      this.cache = { fila: (data as FilaConfig) ?? null, disponible: true, leidoEn: Date.now() };
    } catch (err: any) {
      // Tabla sin crear (migración pendiente) o base caída: se sigue con el .env
      this.logger.warn(`No se pudo leer ${TABLA}; se usan las variables de entorno: ${err?.message ?? err}`);
      this.cache = { fila: null, disponible: false, leidoEn: Date.now() };
    }
    return this.cache;
  }

  private claveGuardada(fila: FilaConfig | null, p: ProveedorIa): { clave: string | null; ilegible: boolean } {
    const cifrada = p === 'gemini' ? fila?.clave_gemini_cifrada : fila?.clave_openai_cifrada;
    if (!cifrada) return { clave: null, ilegible: false };
    try {
      return { clave: this.cifrador().descifrar(cifrada), ilegible: false };
    } catch (err: any) {
      this.logger.error(`La clave de ${ETIQUETA[p]} guardada no se puede descifrar (¿cambió el secreto?): ${err?.message}`);
      return { clave: null, ilegible: true };
    }
  }

  /** Proveedor, modelo y clave que se usan ahora mismo para leer. */
  private async resolverActual() {
    const { fila } = await this.leerFila();
    const proveedor: ProveedorIa = fila?.proveedor ?? this.proveedorDeEntorno();
    const modeloGuardado = proveedor === 'gemini' ? fila?.modelo_gemini : fila?.modelo_openai;
    const { clave } = this.claveGuardada(fila, proveedor);
    return {
      proveedor,
      modelo: modeloGuardado || this.modeloEntorno(proveedor),
      clave: clave || this.claveEntorno(proveedor),
    };
  }

  /**
   * Lector para la próxima lectura. Se reutiliza mientras no cambie la configuración;
   * si alguien guarda otro proveedor, el siguiente reporte ya sale con el nuevo.
   */
  async lectorActual(): Promise<LectorDeReportes> {
    const { fila } = await this.leerFila();
    if (!fila) {
      // Sin nada guardado: exactamente lo de antes (factory con el .env)
      if (this.lector?.firma !== 'entorno') this.lector = { firma: 'entorno', lector: crearLectorDeReportes() };
      return this.lector.lector;
    }
    const actual = await this.resolverActual();
    const firma = createHash('sha256').update(`${actual.proveedor}|${actual.modelo}|${actual.clave}`).digest('hex');
    if (this.lector?.firma === firma) return this.lector.lector;
    const lector = crearLectorDeReportes({
      proveedor: actual.proveedor,
      geminiConfig: actual.proveedor === 'gemini' ? { apiKey: actual.clave, modelo: actual.modelo } : undefined,
      openaiConfig: actual.proveedor === 'openai' ? { apiKey: actual.clave, modelo: actual.modelo } : undefined,
    });
    this.lector = { firma, lector };
    this.logger.log(`Lector de IA: ${lector.nombre} (${lector.modelo})`);
    return lector;
  }

  async estado(rol: string | undefined): Promise<EstadoIa> {
    this.exigirAdmin(rol);
    const { fila, disponible } = await this.leerFila(true);
    const claves = {} as Record<ProveedorIa, EstadoClave>;
    const modelos = {} as Record<ProveedorIa, string>;
    for (const p of PROVEEDORES_IA) {
      const guardada = this.claveGuardada(fila, p);
      const entorno = this.claveEntorno(p);
      claves[p] = guardada.clave
        ? { configurada: true, final: finalDeClave(guardada.clave), origen: 'pantalla' }
        : entorno
          ? { configurada: true, final: finalDeClave(entorno), origen: 'servidor', ilegible: guardada.ilegible || undefined }
          : { configurada: false, final: null, origen: null, ilegible: guardada.ilegible || undefined };
      modelos[p] = (p === 'gemini' ? fila?.modelo_gemini : fila?.modelo_openai) || this.modeloEntorno(p);
    }
    return {
      proveedor: fila?.proveedor ?? this.proveedorDeEntorno(),
      modelos,
      claves,
      origen: fila ? 'pantalla' : 'servidor',
      disponible,
      actualizado_por: fila?.actualizado_por ?? null,
      actualizado_en: fila?.actualizado_en ?? null,
      modelos_sugeridos: MODELOS_SUGERIDOS,
    };
  }

  async guardar(cambio: CambioIa, rol: string | undefined, actor: string): Promise<EstadoIa> {
    this.exigirAdmin(rol);
    if (!this.supabase) throw new BadRequestException('Base de datos no disponible');
    const { fila, disponible } = await this.leerFila(true);
    if (!disponible) {
      throw new BadRequestException(
        'Falta crear la tabla configuracion_ia: corre la migración 20261119000000_configuracion_ia.sql en Supabase.',
      );
    }

    const proveedor = cambio.proveedor === undefined ? (fila?.proveedor ?? this.proveedorDeEntorno()) : cambio.proveedor;
    if (!esProveedorIa(proveedor)) throw new BadRequestException('Proveedor inválido: elige gemini u openai.');

    const cifrador = this.cifrador();
    const nuevaGemini = limpiarClave(cambio.clave_gemini);
    const nuevaOpenai = limpiarClave(cambio.clave_openai);
    const registro: FilaConfig & { id: number } = {
      id: 1,
      proveedor,
      modelo_gemini:
        cambio.modelo_gemini === undefined ? (fila?.modelo_gemini ?? null) : limpiarModelo(cambio.modelo_gemini),
      modelo_openai:
        cambio.modelo_openai === undefined ? (fila?.modelo_openai ?? null) : limpiarModelo(cambio.modelo_openai),
      // Sin clave nueva se conserva la guardada: cambiar de proveedor no borra ninguna
      clave_gemini_cifrada: nuevaGemini ? cifrador.cifrar(nuevaGemini) : (fila?.clave_gemini_cifrada ?? null),
      clave_openai_cifrada: nuevaOpenai ? cifrador.cifrar(nuevaOpenai) : (fila?.clave_openai_cifrada ?? null),
      actualizado_por: actor,
      actualizado_en: new Date().toISOString(),
    };

    // No se deja activo un proveedor sin clave: los reportes fallarían todos
    const claveActiva = this.claveGuardada(registro, proveedor).clave || this.claveEntorno(proveedor);
    if (!claveActiva) {
      throw new BadRequestException(`Para usar ${ETIQUETA[proveedor]} primero pega su API key.`);
    }

    const { error } = await this.supabase.getClient().from(TABLA).upsert(registro, { onConflict: 'id' });
    if (error) throw new BadRequestException(`No se pudo guardar: ${error.message}`);
    this.cache = null;
    this.lector = null;
    return this.estado(rol);
  }

  /** Borra la clave guardada de un proveedor (si es el activo y no hay otra en el servidor, se rechaza). */
  async quitarClave(proveedor: unknown, rol: string | undefined, actor: string): Promise<EstadoIa> {
    this.exigirAdmin(rol);
    if (!esProveedorIa(proveedor)) throw new BadRequestException('Proveedor inválido');
    const { fila } = await this.leerFila(true);
    if (!fila || !this.supabase) return this.estado(rol);
    if (fila.proveedor === proveedor && !this.claveEntorno(proveedor)) {
      throw new BadRequestException(
        `${ETIQUETA[proveedor]} es el proveedor en uso. Cambia a otro antes de quitar su clave.`,
      );
    }
    const columna = proveedor === 'gemini' ? 'clave_gemini_cifrada' : 'clave_openai_cifrada';
    const { error } = await this.supabase
      .getClient()
      .from(TABLA)
      .update({ [columna]: null, actualizado_por: actor, actualizado_en: new Date().toISOString() })
      .eq('id', 1);
    if (error) throw new BadRequestException(`No se pudo quitar la clave: ${error.message}`);
    this.cache = null;
    this.lector = null;
    return this.estado(rol);
  }

  /**
   * Comprueba clave y modelo sin gastar: pide los datos del modelo (no genera texto).
   * Usa la clave escrita en el formulario o, si viene vacía, la guardada.
   */
  async probar(
    datos: { proveedor?: unknown; modelo?: unknown; clave?: unknown },
    rol: string | undefined,
  ): Promise<{ ok: boolean; mensaje: string }> {
    this.exigirAdmin(rol);
    if (!esProveedorIa(datos.proveedor)) throw new BadRequestException('Proveedor inválido');
    const p = datos.proveedor;
    const modelo = limpiarModelo(datos.modelo) || this.modeloEntorno(p);
    const { fila } = await this.leerFila(true);
    const clave = limpiarClave(datos.clave) || this.claveGuardada(fila, p).clave || this.claveEntorno(p);
    if (!clave) return { ok: false, mensaje: `No hay API key de ${ETIQUETA[p]} para probar.` };

    return this.probarConClave(p, clave, modelo);
  }

  /**
   * Comprueba una clave concreta sin gastar (pide los datos del modelo). Sin control de
   * rol: lo usan la pantalla del administrador y la de "Mi clave de Gemini".
   */
  async probarConClave(p: ProveedorIa, clave: string, modelo: string): Promise<{ ok: boolean; mensaje: string }> {
    const url =
      p === 'gemini'
        ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}`
        : `https://api.openai.com/v1/models/${encodeURIComponent(modelo)}`;
    const headers: Record<string, string> =
      p === 'gemini' ? { 'x-goog-api-key': clave } : { Authorization: `Bearer ${clave}` };

    let res: Response;
    try {
      res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err: any) {
      return {
        ok: false,
        mensaje: ocultarClaves(`No se pudo conectar con ${ETIQUETA[p]}: ${err?.message ?? err}`, clave),
      };
    }
    if (res.ok) return { ok: true, mensaje: `Conexión correcta con ${ETIQUETA[p]} (${modelo}).` };
    if (res.status === 401 || (p === 'gemini' && res.status === 400)) {
      return { ok: false, mensaje: `La API key de ${ETIQUETA[p]} no es válida.` };
    }
    if (res.status === 403) return { ok: false, mensaje: `La clave no tiene acceso a ${modelo}.` };
    if (res.status === 404) return { ok: false, mensaje: `El modelo "${modelo}" no existe o la cuenta no tiene acceso.` };
    if (res.status === 429) {
      return { ok: false, mensaje: `${ETIQUETA[p]} rechazó por límite de uso o falta de saldo (429).` };
    }
    return { ok: false, mensaje: `${ETIQUETA[p]} respondió HTTP ${res.status}.` };
  }

  /**
   * Modelos que la clave puede usar, consultados al proveedor (no gasta saldo).
   * Solo se devuelven los que sirven para leer una imagen y responder texto:
   * se quitan los de audio, voz, imágenes, embeddings, moderación, etc.
   */
  async listarModelos(
    datos: { proveedor?: unknown; clave?: unknown },
    rol: string | undefined,
  ): Promise<{ ok: boolean; modelos: string[]; mensaje: string }> {
    this.exigirAdmin(rol);
    if (!esProveedorIa(datos.proveedor)) throw new BadRequestException('Proveedor inválido');
    const p = datos.proveedor;
    const { fila } = await this.leerFila(true);
    const clave = limpiarClave(datos.clave) || this.claveGuardada(fila, p).clave || this.claveEntorno(p);
    if (!clave) return { ok: false, modelos: [], mensaje: `Pega primero la API key de ${ETIQUETA[p]}.` };

    return this.modelosConClave(p, clave);
  }

  /** Modelos de una clave concreta (sin control de rol; ver listarModelos). */
  async modelosConClave(p: ProveedorIa, clave: string): Promise<{ ok: boolean; modelos: string[]; mensaje: string }> {
    const url =
      p === 'gemini'
        ? 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
        : 'https://api.openai.com/v1/models';
    const headers: Record<string, string> =
      p === 'gemini' ? { 'x-goog-api-key': clave } : { Authorization: `Bearer ${clave}` };

    let res: Response;
    try {
      res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err: any) {
      return {
        ok: false,
        modelos: [],
        mensaje: ocultarClaves(`No se pudo conectar con ${ETIQUETA[p]}: ${err?.message ?? err}`, clave),
      };
    }
    if (!res.ok) {
      const mensaje =
        res.status === 401 || (p === 'gemini' && (res.status === 400 || res.status === 403))
          ? `La API key de ${ETIQUETA[p]} no es válida.`
          : res.status === 429
            ? `${ETIQUETA[p]} rechazó por límite de uso o falta de saldo (429).`
            : `${ETIQUETA[p]} respondió HTTP ${res.status}.`;
      return { ok: false, modelos: [], mensaje };
    }
    const json: any = await res.json().catch(() => ({}));
    const modelos = p === 'gemini' ? filtrarModelosGemini(json?.models) : filtrarModelosOpenai(json?.data);
    return {
      ok: true,
      modelos,
      mensaje: modelos.length
        ? `${modelos.length} modelos disponibles con esta clave.`
        : `La clave funciona pero no tiene modelos que lean imágenes.`,
    };
  }
}

// Lo que no sirve para leer el talonario (no ve imágenes o no responde texto)
const OPENAI_EXCLUIR =
  /(audio|realtime|transcribe|tts|whisper|dall-e|image|embedding|moderation|search|instruct|codex|computer-use|babbage|davinci|deep-research)/i;
const OPENAI_INCLUIR = /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1|o3|o4|chatgpt-4o)/i;

export function filtrarModelosOpenai(datos: unknown): string[] {
  if (!Array.isArray(datos)) return [];
  const ids = datos
    .map((m: any) => String(m?.id ?? ''))
    .filter((id) => id && OPENAI_INCLUIR.test(id) && !OPENAI_EXCLUIR.test(id) && !/^o1-mini/.test(id));
  // Primero los alias sin fecha (gpt-4o-mini) y después las versiones fechadas
  const fechado = (id: string) => /-\d{4}-\d{2}-\d{2}$/.test(id);
  return [...new Set(ids)].sort((a, b) => Number(fechado(a)) - Number(fechado(b)) || a.localeCompare(b));
}

// No sirven para leer el talonario: voz, imágenes, robótica, transcripción, uso del computador, etc.
const GEMINI_EXCLUIR =
  /(embedding|tts|image-generation|-image|live|native-audio|aqa|imagen|veo|learnlm|gemma|robotics|transcribe|computer-use|customtools|nano-banana|omni)/i;

export function filtrarModelosGemini(datos: unknown): string[] {
  if (!Array.isArray(datos)) return [];
  const ids = datos
    .filter((m: any) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m: any) => String(m?.name ?? '').replace(/^models\//, ''))
    .filter((id) => id.startsWith('gemini') && !GEMINI_EXCLUIR.test(id));
  return [...new Set(ids)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}
