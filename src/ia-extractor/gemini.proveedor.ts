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

export interface GeminiConfig {
  apiKey: string;
  modelo?: string;
  temperatura?: number;
  promptPersonalizado?: string;
  fetchFn?: typeof fetch;
  /** Intentos totales ante fallos transitorios del proveedor (por defecto 3). */
  intentosMaximos?: number;
  /** Espera antes del 2.º intento; se duplica en cada reintento (por defecto 2000 ms). */
  esperaBaseMs?: number;
}

export class GeminiLector implements LectorDeReportes {
  readonly nombre = 'gemini';
  readonly modelo: string;
  private readonly apiKey: string;
  private readonly temperaturaBase?: number;
  private readonly promptPersonalizado?: string;
  private readonly fetchFn: typeof fetch;
  private readonly intentosMaximos: number;
  private readonly esperaBaseMs: number;

  constructor(config: GeminiConfig) {
    if (!config.apiKey) {
      throw new ProveedorIaError('gemini', 'GEMINI_API_KEY no configurada');
    }
    this.apiKey = config.apiKey;
    this.modelo = config.modelo || 'gemini-3.8-flash';
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
      throw new ProveedorIaError('gemini', 'El buffer de la imagen está vacío');
    }
    if (!campos || campos.length === 0) {
      throw new ProveedorIaError('gemini', 'Se requiere al menos un campo esperado');
    }

    const tempEfectiva = resolverTemperaturaConfigurada(temperatura, this.temperaturaBase);
    const inicio = Date.now();
    const promptSistema = construirPromptLectura(campos, contexto, this.promptPersonalizado);
    const base64Imagen = imagen.toString('base64');
    // La clave va en la cabecera y no en la URL: así no queda escrita en registros de proxies ni errores.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelo}:generateContent`;

    const payload = {
      contents: [
        {
          parts: [
            { text: promptSistema },
            {
              inline_data: {
                mime_type: mimeType || 'image/jpeg',
                data: base64Imagen,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: tempEfectiva,
        response_mime_type: 'application/json',
      },
    };

    const res = await enviarConReintentos(
      'gemini',
      this.fetchFn,
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(payload),
      },
      this.intentosMaximos,
      this.esperaBaseMs,
    );

    const json = await res.json();
    const latenciaMs = Date.now() - inicio;

    const tokensEntrada = json.usageMetadata?.promptTokenCount ?? 0;
    const tokensSalida = json.usageMetadata?.candidatesTokenCount ?? 0;
    const costoUsd = this.calcularCosto(tokensEntrada, tokensSalida);

    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new ProveedorIaError('gemini', 'Respuesta del modelo sin texto');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch (err: any) {
      throw new ProveedorIaError('gemini', `JSON inválido retornado por Gemini: ${rawText}`);
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
      salidaCruda: rawText,
      etiquetas: normalizarEtiquetas(parsed.etiquetas),
    };
  }

  private calcularCosto(tokensIn: number, tokensOut: number): number {
    const costoIn = (tokensIn / 1_000_000) * 0.075;
    const costoOut = (tokensOut / 1_000_000) * 0.30;
    return Number((costoIn + costoOut).toFixed(6));
  }
}
