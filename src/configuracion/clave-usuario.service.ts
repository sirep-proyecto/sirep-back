import { BadRequestException, ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { SupabaseService } from '../common/supabase.service';
import { crearLectorDeReportes } from '../ia-extractor/ia-extractor.factory';
import { ocultarClaves } from '../ia-extractor/lectura-comun';
import { LectorDeReportes } from '../ia-extractor/types';
import { enParalelo } from '../escaneos/paralelo';
import { IaConfigService, MODELO_GEMINI_POR_DEFECTO, finalDeClave, limpiarModelo } from './ia-config.service';

/**
 * Clave de Gemini propia de cada cuenta (Configuración > Mi clave de Gemini).
 *
 * Por qué existe: Gemini limita las lecturas por minuto POR PROYECTO de Google. Con una
 * sola clave para todos, varias personas subiendo reportes a la vez se frenan entre sí.
 * Si cada una lee con su propia clave (creada en su propia cuenta) tiene su propio cupo.
 *
 * Reglas:
 * - Cualquier rol puede guardar su clave; solo la ve y la cambia su dueño. El administrador
 *   ve quién tiene clave y su estado, nunca la clave.
 * - Antes de guardar, la clave se prueba contra Gemini: si no sirve, no se guarda.
 * - Se guarda cifrada con la misma llave que la clave de la empresa (configuracion_ia).
 * - Al subir un reporte: clave personal → clave de la empresa → variable de entorno.
 *   Si la personal falla, EscaneosService reintenta con la de la empresa y aquí se anota
 *   el error para que la persona lo vea.
 */
const TABLA = 'claves_ia_usuario';

interface FilaClave {
  usuario_id: string;
  proveedor: 'gemini';
  clave_cifrada: string;
  clave_final: string | null;
  modelo: string | null;
  activa: boolean;
  lecturas: number;
  ultimo_uso_en: string | null;
  ultimo_error: string | null;
  ultimo_error_en: string | null;
  actualizado_en: string | null;
}

export interface EstadoMiClave {
  /** false si la tabla no existe todavía (falta correr la migración). */
  disponible: boolean;
  configurada: boolean;
  final: string | null;
  modelo: string;
  activa: boolean;
  lecturas: number;
  ultimo_uso_en: string | null;
  ultimo_error: string | null;
  ultimo_error_en: string | null;
  /** La clave guardada no se puede descifrar (cambió el secreto del servidor): hay que pegarla de nuevo. */
  ilegible: boolean;
  modelo_por_defecto: string;
}

export interface CambioMiClave {
  /** Vacío o ausente = se deja la guardada. */
  clave?: unknown;
  modelo?: unknown;
  activa?: unknown;
}

/** Disponibilidad de un modelo para ESTA clave. */
export type CupoModelo = 'gratuito' | 'sin_cupo_gratuito' | 'limite_alcanzado' | 'no_disponible' | 'sin_probar';

export interface ModeloConCupo {
  id: string;
  cupo: CupoModelo;
  por_defecto: boolean;
}

/** Lector personal listo para leer, con lo necesario para anotar el resultado. */
export interface LectorPersonal {
  lector: LectorDeReportes;
  usuarioId: string;
  final: string | null;
}

/** Errores de Gemini que significan "esta clave no sirve ahora": se pasa a la de la empresa. */
export function esFalloDeClave(err: unknown): boolean {
  const codigo = (err as any)?.codigoHttp ?? (err as any)?.status;
  if ([400, 401, 403, 429].includes(Number(codigo))) return true;
  const texto = String((err as any)?.message ?? '');
  return /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|RESOURCE_EXHAUSTED|quota|HTTP (400|401|403|429)/i.test(texto);
}

/**
 * Clasifica la respuesta de una prueba mínima de generación:
 * - 200: el modelo responde con esta clave → gratuito (o con saldo).
 * - 429 con "limit: 0": el plan gratuito de esta cuenta no incluye ese modelo → de pago.
 * - 429 sin "limit: 0": hay cupo pero se acabó por ahora (por minuto o por día).
 * - 403/404: la cuenta no tiene acceso.
 */
export function clasificarCupo(status: number, cuerpo: string): CupoModelo {
  if (status >= 200 && status < 300) return 'gratuito';
  if (status === 429) return /limit:\s*0\b/i.test(cuerpo) ? 'sin_cupo_gratuito' : 'limite_alcanzado';
  if (status === 403 || status === 404) return 'no_disponible';
  return 'sin_probar';
}

const ORDEN_CUPO: Record<CupoModelo, number> = {
  gratuito: 0,
  limite_alcanzado: 1,
  sin_probar: 2,
  sin_cupo_gratuito: 3,
  no_disponible: 4,
};

/** El modelo por defecto primero; luego los gratuitos; dentro de cada grupo, el orden de Gemini. */
export function ordenarModelos(modelos: ModeloConCupo[]): ModeloConCupo[] {
  return [...modelos].sort(
    (a, b) => Number(b.por_defecto) - Number(a.por_defecto) || ORDEN_CUPO[a.cupo] - ORDEN_CUPO[b.cupo],
  );
}

/** Orden en que se prueban los modelos (cada prueba usa una lectura del cupo por minuto). */
export function prioridadParaProbar(modelos: string[]): string[] {
  const peso = (id: string) => {
    if (id === MODELO_GEMINI_POR_DEFECTO) return 0;
    const inestable = /(preview|exp|latest)/i.test(id) ? 10 : 0;
    const familia = /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 2 : /pro/.test(id) ? 3 : 5;
    return familia + inestable;
  };
  // Dentro de cada grupo, la versión más nueva primero
  return [...new Set(modelos)].sort(
    (a, b) => peso(a) - peso(b) || b.localeCompare(a, undefined, { numeric: true }),
  );
}

// Máximo de modelos que se prueban: cada prueba usa una lectura del cupo por minuto.
const MAX_MODELOS_A_PROBAR = 10;

@Injectable()
export class ClaveIaUsuarioService {
  private readonly logger = new Logger(ClaveIaUsuarioService.name);
  /** Un lector por persona, reutilizado mientras no cambie su clave o su modelo. */
  private readonly lectores = new Map<string, { firma: string; lector: LectorDeReportes }>();

  constructor(
    private readonly ia: IaConfigService,
    @Optional() private readonly supabase?: SupabaseService,
  ) {}

  private cliente() {
    if (!this.supabase) throw new BadRequestException('Base de datos no disponible');
    return this.supabase.getClient();
  }

  private exigirUsuario(usuarioId: string | undefined): string {
    if (!usuarioId) throw new ForbiddenException('Inicia sesión para configurar tu clave de Gemini.');
    return usuarioId;
  }

  private async leer(usuarioId: string): Promise<{ fila: FilaClave | null; disponible: boolean }> {
    if (!this.supabase) return { fila: null, disponible: false };
    try {
      const { data, error } = await this.cliente().from(TABLA).select('*').eq('usuario_id', usuarioId).maybeSingle();
      if (error) throw error;
      return { fila: (data as FilaClave) ?? null, disponible: true };
    } catch (err: any) {
      // Tabla sin crear (migración pendiente) o base caída: se sigue con la clave de la empresa
      this.logger.warn(`No se pudo leer ${TABLA}: ${err?.message ?? err}`);
      return { fila: null, disponible: false };
    }
  }

  private descifrar(fila: FilaClave): string | null {
    try {
      return this.ia.cifrador().descifrar(fila.clave_cifrada);
    } catch (err: any) {
      this.logger.error(`Clave personal de ${fila.usuario_id} ilegible (¿cambió el secreto?): ${err?.message}`);
      return null;
    }
  }

  private limpiarClave(valor: unknown): string | null {
    if (valor === undefined || valor === null) return null;
    const c = String(valor).trim();
    if (!c) return null;
    if (c.length < 10 || c.length > 300 || !/^[\x21-\x7e]+$/.test(c)) {
      throw new BadRequestException('La clave no tiene un formato válido. Cópiala completa, sin espacios ni saltos de línea.');
    }
    return c;
  }

  async estado(usuarioId: string | undefined): Promise<EstadoMiClave> {
    const id = this.exigirUsuario(usuarioId);
    const { fila, disponible } = await this.leer(id);
    const ilegible = fila ? this.descifrar(fila) === null : false;
    return {
      disponible,
      configurada: Boolean(fila),
      final: fila?.clave_final ?? null,
      modelo: fila?.modelo || MODELO_GEMINI_POR_DEFECTO,
      activa: fila?.activa ?? false,
      lecturas: fila?.lecturas ?? 0,
      ultimo_uso_en: fila?.ultimo_uso_en ?? null,
      ultimo_error: fila?.ultimo_error ?? null,
      ultimo_error_en: fila?.ultimo_error_en ?? null,
      ilegible,
      modelo_por_defecto: MODELO_GEMINI_POR_DEFECTO,
    };
  }

  /** Guarda (o actualiza) la clave personal. Una clave nueva se prueba antes contra Gemini. */
  async guardar(usuarioId: string | undefined, cambio: CambioMiClave): Promise<EstadoMiClave> {
    const id = this.exigirUsuario(usuarioId);
    const { fila, disponible } = await this.leer(id);
    if (!disponible) {
      throw new BadRequestException(
        'Falta crear la tabla claves_ia_usuario: corre la migración 20261124000000_claves_ia_usuario.sql en Supabase.',
      );
    }
    const nueva = this.limpiarClave(cambio.clave);
    const modelo = cambio.modelo === undefined ? (fila?.modelo ?? null) : limpiarModelo(cambio.modelo);
    const clave = nueva ?? (fila ? this.descifrar(fila) : null);
    if (!clave) throw new BadRequestException('Pega tu API key de Gemini.');

    // Con clave o modelo nuevo se prueba la combinación: no se guarda algo que no lee
    if (nueva || cambio.modelo !== undefined) {
      const prueba = await this.ia.probarConClave('gemini', clave, modelo || MODELO_GEMINI_POR_DEFECTO);
      if (!prueba.ok) throw new BadRequestException(prueba.mensaje);
    }

    const ahora = new Date().toISOString();
    const registro = {
      usuario_id: id,
      proveedor: 'gemini' as const,
      clave_cifrada: nueva ? this.ia.cifrador().cifrar(nueva) : fila!.clave_cifrada,
      clave_final: nueva ? finalDeClave(nueva) : (fila?.clave_final ?? null),
      modelo,
      activa: cambio.activa === undefined ? (fila?.activa ?? true) : Boolean(cambio.activa),
      // Una clave nueva empieza sin errores
      ...(nueva ? { ultimo_error: null, ultimo_error_en: null } : {}),
      actualizado_en: ahora,
    };
    const { error } = await this.cliente().from(TABLA).upsert(registro, { onConflict: 'usuario_id' });
    if (error) throw new BadRequestException(`No se pudo guardar: ${error.message}`);
    this.lectores.delete(id);
    return this.estado(id);
  }

  async quitar(usuarioId: string | undefined): Promise<EstadoMiClave> {
    const id = this.exigirUsuario(usuarioId);
    const { error } = await this.cliente().from(TABLA).delete().eq('usuario_id', id);
    if (error) throw new BadRequestException(`No se pudo quitar la clave: ${error.message}`);
    this.lectores.delete(id);
    return this.estado(id);
  }

  /** Prueba la clave escrita (o la guardada) con el modelo elegido, sin guardar nada. */
  async probar(usuarioId: string | undefined, datos: { clave?: unknown; modelo?: unknown }) {
    const id = this.exigirUsuario(usuarioId);
    const clave = this.limpiarClave(datos.clave) ?? (await this.claveGuardada(id));
    if (!clave) return { ok: false, mensaje: 'Pega primero tu API key de Gemini.' };
    const modelo = limpiarModelo(datos.modelo) || MODELO_GEMINI_POR_DEFECTO;
    return this.ia.probarConClave('gemini', clave, modelo);
  }

  /**
   * Modelos de Gemini que puede usar la clave y si tienen cupo gratuito.
   * La API de Google no dice qué es gratuito: se hace una lectura mínima (1 token de
   * respuesta) por modelo. Si el plan gratuito de la cuenta no incluye el modelo, Google
   * responde 429 con "limit: 0". Se prueban como máximo MAX_MODELOS_A_PROBAR modelos,
   * de a 2 a la vez, para no gastar el cupo por minuto de la persona.
   */
  async modelos(
    usuarioId: string | undefined,
    datos: { clave?: unknown },
  ): Promise<{ ok: boolean; modelos: ModeloConCupo[]; mensaje: string }> {
    const id = this.exigirUsuario(usuarioId);
    const clave = this.limpiarClave(datos.clave) ?? (await this.claveGuardada(id));
    if (!clave) return { ok: false, modelos: [], mensaje: 'Pega primero tu API key de Gemini.' };

    const lista = await this.ia.modelosConClave('gemini', clave);
    if (!lista.ok) return { ok: false, modelos: [], mensaje: lista.mensaje };

    // Se prueban primero los que sirven para leer reportes: el de por defecto, luego los
    // estables flash-lite, flash y pro; al final los alias "latest" y las versiones preview.
    const ids = prioridadParaProbar(lista.modelos);
    const aProbar = ids.slice(0, MAX_MODELOS_A_PROBAR);
    const probados = await enParalelo(aProbar, 2, async (modelo) => ({
      id: modelo,
      cupo: await this.probarCupo(clave, modelo),
      por_defecto: modelo === MODELO_GEMINI_POR_DEFECTO,
    }));
    const resto = ids.slice(MAX_MODELOS_A_PROBAR).map((m) => ({ id: m, cupo: 'sin_probar' as const, por_defecto: false }));
    const modelos = ordenarModelos([...probados, ...resto]);
    const gratuitos = modelos.filter((m) => m.cupo === 'gratuito').length;
    return {
      ok: true,
      modelos,
      mensaje: `${modelos.length} modelos con esta clave; ${gratuitos} responden con tu cupo gratuito.`,
    };
  }

  private async probarCupo(clave: string, modelo: string): Promise<CupoModelo> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
    try {
      const res = await this.ia.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ok' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return clasificarCupo(res.status, await res.text().catch(() => ''));
    } catch (err: any) {
      this.logger.warn(ocultarClaves(`No se pudo probar ${modelo}: ${err?.message ?? err}`, clave));
      return 'sin_probar';
    }
  }

  private async claveGuardada(usuarioId: string): Promise<string | null> {
    const { fila } = await this.leer(usuarioId);
    return fila ? this.descifrar(fila) : null;
  }

  /**
   * Lector con la clave personal de quien sube el reporte, o null si no tiene una activa
   * (entonces se usa la de la empresa). Nunca lanza: ante cualquier problema, null.
   */
  async lectorPara(usuarioId: string | undefined): Promise<LectorPersonal | null> {
    if (!usuarioId) return null;
    const { fila } = await this.leer(usuarioId);
    if (!fila || !fila.activa) return null;
    const clave = this.descifrar(fila);
    if (!clave) return null;
    const modelo = fila.modelo || MODELO_GEMINI_POR_DEFECTO;
    const firma = createHash('sha256').update(`${modelo}|${clave}`).digest('hex');
    const guardado = this.lectores.get(usuarioId);
    if (guardado?.firma === firma) return { lector: guardado.lector, usuarioId, final: fila.clave_final };
    try {
      const lector = crearLectorDeReportes({ proveedor: 'gemini', geminiConfig: { apiKey: clave, modelo } });
      this.lectores.set(usuarioId, { firma, lector });
      return { lector, usuarioId, final: fila.clave_final };
    } catch (err: any) {
      this.logger.warn(`No se pudo crear el lector personal de ${usuarioId}: ${err?.message}`);
      return null;
    }
  }

  /** Anota una lectura correcta con la clave personal. No interrumpe la lectura si falla. */
  async registrarUso(usuarioId: string): Promise<void> {
    if (!this.supabase) return;
    try {
      const { fila } = await this.leer(usuarioId);
      if (!fila) return;
      await this.cliente()
        .from(TABLA)
        .update({ lecturas: (fila.lecturas ?? 0) + 1, ultimo_uso_en: new Date().toISOString() })
        .eq('usuario_id', usuarioId);
    } catch (err: any) {
      this.logger.warn(`No se pudo anotar el uso de la clave de ${usuarioId}: ${err?.message}`);
    }
  }

  /** Anota que la clave personal falló (el reporte se leyó con la de la empresa). */
  async registrarError(usuarioId: string, mensaje: string): Promise<void> {
    if (!this.supabase) return;
    try {
      await this.cliente()
        .from(TABLA)
        .update({ ultimo_error: mensaje.slice(0, 500), ultimo_error_en: new Date().toISOString() })
        .eq('usuario_id', usuarioId);
    } catch (err: any) {
      this.logger.warn(`No se pudo anotar el error de la clave de ${usuarioId}: ${err?.message}`);
    }
  }

  /** Para el administrador: quién tiene clave propia y su estado. Nunca incluye la clave. */
  async listarParaAdmin(rol: string | undefined) {
    if (!this.ia.puedeCambiar(rol)) {
      throw new ForbiddenException('Solo el administrador ve las claves de todas las cuentas.');
    }
    const { data, error } = await this.cliente()
      .from(TABLA)
      .select('usuario_id, clave_final, modelo, activa, lecturas, ultimo_uso_en, ultimo_error, ultimo_error_en, usuario:usuarios(nombre, usuario, rol)')
      .order('ultimo_uso_en', { ascending: false, nullsFirst: false });
    if (error) throw new BadRequestException(`No se pudieron leer las claves: ${error.message}`);
    return (data ?? []).map((f: any) => ({
      usuario_id: f.usuario_id,
      nombre: f.usuario?.nombre ?? null,
      usuario: f.usuario?.usuario ?? null,
      rol: f.usuario?.rol ?? null,
      final: f.clave_final,
      modelo: f.modelo || MODELO_GEMINI_POR_DEFECTO,
      activa: f.activa,
      lecturas: f.lecturas,
      ultimo_uso_en: f.ultimo_uso_en,
      ultimo_error: f.ultimo_error,
      ultimo_error_en: f.ultimo_error_en,
    }));
  }
}
