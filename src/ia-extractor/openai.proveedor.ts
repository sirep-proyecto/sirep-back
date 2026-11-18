import {
  CampoEsperado,
  ContextoAprendizaje,
  LectorDeReportes,
  ProveedorIaError,
  ResultadoLectura,
} from './types';
import { aplicarCorreccionesAprendidas } from './normalizacion';
import { resolverTemperaturaConfigurada } from './anthropic.proveedor';
import {
  construirPromptLectura,
  enviarConReintentos,
  normalizarCamposLeidos,
  normalizarEtiquetas,
} from './lectura-comun';

export interface OpenAIConfig {
  apiKey: string;
  modelo?: string;
  temperatura?: number;
  promptPersonalizado?: string;
  fetchFn?: typeof fetch;
  /** Intentos totales ante fallos transitorios (429 por límite de uso, 5xx). Por defecto 3. */
  intentosMaximos?: number;
  /** Espera antes del 2.º intento; se duplica en cada reintento (por defecto 2000 ms). */
  esperaBaseMs?: number;
}

export const MODELO_OPENAI_POR_DEFECTO = 'gpt-4o-mini';

/**
 * Los modelos de razonamiento (o1, o3, o4-mini…) y la familia gpt-5 solo aceptan la
 * temperatura por defecto: si se les manda otra responden 400. A esos no se les envía.
 */
export function openaiAceptaTemperatura(modelo: string): boolean {
  return !/^(o\d|gpt-5)/i.test(modelo.trim());
}

/**
 * Lector con ChatGPT (API de OpenAI). Usa el mismo prompt y la misma interpretación que
 * Gemini (lectura-comun.ts), así que devuelve también las cajas de cada campo para el
 * visor. Cada página llega como imagen (EscaneosService convierte los PDF), por eso no
 * se acepta un PDF directo.
 */
export class OpenAILector implements LectorDeReportes {
  readonly nombre = 'openai';
  readonly modelo: string;
  private readonly apiKey: string;
  private readonly temperaturaBase?: number;
  private readonly promptPersonalizado?: string;
  private readonly fetchFn: typeof fetch;
  private readonly intentosMaximos: number;
  private readonly esperaBaseMs: number;

  constructor(config: OpenAIConfig) {
    if (!config.apiKey) {
      throw new ProveedorIaError('openai', 'OPENAI_API_KEY no configurada');
    }
    this.apiKey = config.apiKey;
    this.modelo = config.modelo || MODELO_OPENAI_POR_DEFECTO;
    this.temperaturaBase = config.temperatura;
    this.promptPersonalizado = config.promptPersonalizado;
    this.fetchFn = config.fetchFn || globalThis.fetch.bind(globalThis);
    this.intentosMaximos = Math.max(1, config.intentosMaximos ?? 3);
    this.esperaBaseMs = config.esperaBaseMs ?? 2000;
  }

  async leer(
    imagen: Buffer,
    mimeType: string,
    campos: CampoEsperado[],
    temperatura?: number,
    contexto?: ContextoAprendizaje,
  ): Promise<ResultadoLectura> {
    if (!imagen || imagen.length === 0) {
      throw new ProveedorIaError('openai', 'El buffer de la imagen está vacío');
    }
    if (!campos || campos.length === 0) {
      throw new ProveedorIaError('openai', 'Se requiere al menos un campo esperado');
    }

    if (mimeType === 'application/pdf') {
      throw new ProveedorIaError(
        'openai',
        'El endpoint multimodal de OpenAI solo admite imágenes (JPEG, PNG, WebP) y no soporta application/pdf directo. Convierta la página del PDF a imagen o envíe el reporte en formato imagen para usar este proveedor.',
        400,
      );
    }

    const tempEfectiva = resolverTemperaturaConfigurada(temperatura, this.temperaturaBase);
    const inicio = Date.now();
    const promptSistema = construirPromptLectura(campos, contexto, this.promptPersonalizado);
    const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imagen.toString('base64')}`;

    const payload: Record<string, unknown> = {
      model: this.modelo,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: promptSistema },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extrae los campos del reporte técnico manuscrito adjunto siguiendo estrictamente las reglas. Responde solo con el JSON.',
            },
            // detail "high": la letra a mano es pequeña; con "low" la imagen se reduce a 512 px y no se lee
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
    };
    if (openaiAceptaTemperatura(this.modelo)) payload.temperature = tempEfectiva;

    const res = await enviarConReintentos(
      'openai',
      this.fetchFn,
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
      },
      this.intentosMaximos,
      this.esperaBaseMs,
    );

    const json = await res.json();
    const latenciaMs = Date.now() - inicio;

    const tokensEntrada = json.usage?.prompt_tokens ?? 0;
    const tokensSalida = json.usage?.completion_tokens ?? 0;
    // Estimación con la tarifa de gpt-4o-mini; otros modelos cuestan distinto.
    const costoUsd = Number(
      ((tokensEntrada / 1_000_000) * 0.15 + (tokensSalida / 1_000_000) * 0.6).toFixed(6),
    );

    const rawContent = json.choices?.[0]?.message?.content;
    if (!rawContent) {
      throw new ProveedorIaError('openai', 'OpenAI devolvió una respuesta vacía');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new ProveedorIaError('openai', `JSON inválido retornado por OpenAI: ${rawContent}`);
    }

    const camposLeidos = aplicarCorreccionesAprendidas(
      normalizarCamposLeidos(parsed.campos || {}, campos),
      contexto,
    );

    return {
      numeroReporte: parsed.numero_reporte ? String(parsed.numero_reporte).trim() : null,
      campos: camposLeidos,
      uso: {
        proveedor: this.nombre,
        modelo: this.modelo,
        tokensEntrada,
        tokensSalida,
        costoUsd,
        latenciaMs,
      },
      salidaCruda: rawContent,
      etiquetas: normalizarEtiquetas(parsed.etiquetas),
    };
  }
}
