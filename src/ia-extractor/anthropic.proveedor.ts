import * as fs from 'fs';
import {
  CajaCampo,
  CampoEsperado,
  CampoLeido,
  Confianza,
  ContextoAprendizaje,
  LectorDeReportes,
  ProveedorIaError,
  ResultadoLectura,
} from './types';
import {
  OBSERVACION_EN_BLANCO,
  aplicarCorreccionesAprendidas,
  casillaMarcada,
  esCampoEnBlanco,
} from './normalizacion';

export interface AnthropicConfig {
  apiKey: string;
  modelo?: string;
  temperatura?: number;
  promptPersonalizado?: string;
  fetchFn?: typeof fetch;
}

export function resolverPromptConfigurado(promptDirecto?: string): string | undefined {
  const desdeConfig = promptDirecto ?? process.env.IA_PROMPT;
  if (desdeConfig && desdeConfig.trim()) {
    return desdeConfig.trim();
  }
  const rutaArchivo = process.env.IA_PROMPT_ARCHIVO || process.env.IA_PROMPT_FILE;
  if (rutaArchivo && rutaArchivo.trim()) {
    try {
      if (fs.existsSync(rutaArchivo.trim())) {
        const contenido = fs.readFileSync(rutaArchivo.trim(), 'utf-8').trim();
        if (contenido) return contenido;
      }
    } catch {
      // Si el archivo no se puede leer, usa el prompt base
    }
  }
  return undefined;
}

export function resolverTemperaturaConfigurada(
  temperaturaExplicita?: number,
  temperaturaConfig?: number,
): number {
  if (typeof temperaturaExplicita === 'number' && Number.isFinite(temperaturaExplicita)) {
    return temperaturaExplicita;
  }
  if (typeof temperaturaConfig === 'number' && Number.isFinite(temperaturaConfig)) {
    return temperaturaConfig;
  }
  const envRaw = process.env.IA_TEMPERATURA ?? process.env.IA_TEMPERATURE;
  if (envRaw !== undefined && envRaw !== '') {
    const num = Number(envRaw);
    if (Number.isFinite(num) && num >= 0 && num <= 2) {
      return num;
    }
  }
  return 0.1;
}

/**
 * SIREP-S3-T16: Tercer proveedor intercambiable para Claude (Anthropic).
 */
export class AnthropicLector implements LectorDeReportes {
  readonly nombre = 'anthropic';
  readonly modelo: string;
  private readonly apiKey: string;
  private readonly temperaturaBase?: number;
  private readonly promptPersonalizado?: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: AnthropicConfig) {
    if (!config.apiKey) {
      throw new ProveedorIaError('anthropic', 'ANTHROPIC_API_KEY no configurada');
    }
    this.apiKey = config.apiKey;
    this.modelo = config.modelo || 'claude-3-5-sonnet-latest';
    this.temperaturaBase = config.temperatura;
    this.promptPersonalizado = config.promptPersonalizado;
    this.fetchFn = config.fetchFn || globalThis.fetch.bind(globalThis);
  }

  async leer(
    imagen: Buffer,
    mimeType: string,
    campos: CampoEsperado[],
    temperatura?: number,
    contexto?: ContextoAprendizaje,
  ): Promise<ResultadoLectura> {
    if (!imagen || imagen.length === 0) {
      throw new ProveedorIaError('anthropic', 'El buffer de la imagen está vacío');
    }
    if (!campos || campos.length === 0) {
      throw new ProveedorIaError('anthropic', 'Se requiere al menos un campo esperado');
    }

    const tempEfectiva = resolverTemperaturaConfigurada(temperatura, this.temperaturaBase);
    const inicio = Date.now();
    const promptSistema = this.construirPrompt(campos, contexto);
    const base64 = imagen.toString('base64');

    const esPdf = mimeType === 'application/pdf';
    const bloqueDocumento = esPdf
      ? {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64,
          },
        }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType || 'image/jpeg',
            data: base64,
          },
        };

    const payload = {
      model: this.modelo,
      max_tokens: 4096,
      temperature: tempEfectiva,
      system: promptSistema,
      messages: [
        {
          role: 'user',
          content: [
            bloqueDocumento,
            {
              type: 'text',
              text: 'Extrae todos los campos del reporte técnico manuscrito adjunto y devuelve únicamente el objeto JSON.',
            },
          ],
        },
      ],
    };

    let res: Response;
    try {
      res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      throw new ProveedorIaError('anthropic', `Error de conexión: ${err?.message ?? err}`);
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new ProveedorIaError('anthropic', `HTTP ${res.status}: ${errorBody}`, res.status);
    }

    const json = await res.json();
    const latenciaMs = Date.now() - inicio;

    const tokensEntrada = json.usage?.input_tokens ?? 0;
    const tokensSalida = json.usage?.output_tokens ?? 0;
    // Tarifa de referencia Claude Sonnet ($3 / 1M entrada, $15 / 1M salida)
    const costoUsd = Number(
      ((tokensEntrada / 1_000_000) * 3.0 + (tokensSalida / 1_000_000) * 15.0).toFixed(6),
    );

    const rawText = json.content?.find((b: any) => b?.type === 'text')?.text ?? json.content?.[0]?.text;
    if (!rawText) {
      throw new ProveedorIaError('anthropic', 'Anthropic devolvió una respuesta sin texto');
    }

    const limpio = String(rawText)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(limpio);
    } catch {
      throw new ProveedorIaError('anthropic', `JSON inválido retornado por Anthropic: ${rawText}`);
    }

    const camposLeidos = aplicarCorreccionesAprendidas(
      this.normalizarCampos(parsed.campos || {}, campos),
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
    };
  }

  private normalizarCampos(
    camposRespuesta: Record<string, any>,
    camposEsperados: CampoEsperado[],
  ): CampoLeido[] {
    return camposEsperados.map((esperado) => {
      const extraido = camposRespuesta[esperado.clave];

      if (esCampoEnBlanco(esperado, extraido)) {
        return {
          clave: esperado.clave,
          valor: null,
          confianza: 'alta' as Confianza,
          noLeido: false,
          dudoso: false,
          observacion: OBSERVACION_EN_BLANCO,
          caja: this.normalizarCaja(extraido?.caja_2d),
        };
      }

      if (
        !extraido ||
        extraido.valor === undefined ||
        extraido.valor === null ||
        extraido.valor === ''
      ) {
        return {
          clave: esperado.clave,
          valor: null,
          confianza: 'baja' as Confianza,
          noLeido: true,
          dudoso: false,
          observacion: extraido?.observacion || 'No detectado en el documento',
          caja: this.normalizarCaja(extraido?.caja_2d),
        };
      }

      const conf: string = String(extraido.confianza || 'media').toLowerCase();
      const confianza: Confianza =
        conf === 'alta' ? 'alta' : conf === 'baja' ? 'baja' : 'media';
      const dudoso = Boolean(extraido.dudoso ?? (confianza === 'baja'));

      let valor = extraido.valor;
      if (esperado.tipo === 'casilla') {
        valor = casillaMarcada(valor);
      } else {
        valor = String(valor).trim();
      }

      return {
        clave: esperado.clave,
        valor,
        confianza,
        noLeido: false,
        dudoso,
        observacion: extraido.observacion,
        caja: this.normalizarCaja(extraido.caja_2d),
      };
    });
  }

  private normalizarCaja(bruta: unknown): CajaCampo | null {
    if (!Array.isArray(bruta) || bruta.length !== 4) return null;
    const n = bruta.map(Number);
    if (n.some((v) => !Number.isFinite(v))) return null;
    const [ymin, xmin, ymax, xmax] = n.map((v) => Math.min(1000, Math.max(0, v)));
    if (ymax <= ymin || xmax <= xmin) return null;
    if ((ymax - ymin) * (xmax - xmin) > 600_000) return null;

    const r = (v: number) => Number((v / 1000).toFixed(4));
    return {
      x: r(xmin),
      y: r(ymin),
      ancho: r(xmax - xmin),
      alto: r(ymax - ymin),
    };
  }

  private construirPrompt(campos: CampoEsperado[], contexto?: ContextoAprendizaje): string {
    const custom = resolverPromptConfigurado(this.promptPersonalizado);
    const clientesConocidos =
      contexto?.clientes?.map((c) => c.nombre).filter(Boolean) ??
      contexto?.valoresConocidos?.empresa ??
      [];
    const bloqueClientes =
      clientesConocidos.length > 0
        ? `\nCLIENTES CONOCIDOS DE RP-TECH: ${clientesConocidos.join(', ')}`
        : '';

    const instruccionBase =
      custom ||
      `Eres un sistema especializado en extracción de reportes técnicos industriales manuscritos.
No inventes valores. Si un campo opcional está en blanco en el papel, devuelve valor: null y vacio: true.
Si un campo tiene letra manuscrita ilegible, devuelve valor: null, vacio: false, noLeido: true y dudoso: true.
Para casillas (tipo casilla) devuelve true si está marcada o null si no. Para tipo opcion devuelve el texto de la opción marcada.`;

    return `${instruccionBase}${bloqueClientes}

CAMPOS SOLICITADOS:
${JSON.stringify(campos)}

Responde ESTRICTAMENTE con un objeto JSON válido sin bloques Markdown:
{
  "numero_reporte": "000845" | null,
  "campos": {
    "clave": {
      "valor": string | boolean | null,
      "confianza": "alta" | "media" | "baja",
      "noLeido": boolean,
      "dudoso": boolean,
      "observacion": string,
      "vacio": boolean,
      "caja_2d": [ymin, xmin, ymax, xmax] | null
    }
  }
}`;
  }
}
