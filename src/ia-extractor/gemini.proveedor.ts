import {
  CampoEsperado,
  CampoLeido,
  Confianza,
  LectorDeReportes,
  ProveedorIaError,
  ResultadoLectura,
} from './types';

export interface GeminiConfig {
  apiKey: string;
  modelo?: string;
  fetchFn?: typeof fetch;
}

export class GeminiLector implements LectorDeReportes {
  readonly nombre = 'gemini';
  readonly modelo: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: GeminiConfig) {
    if (!config.apiKey) {
      throw new ProveedorIaError('gemini', 'GEMINI_API_KEY no configurada');
    }
    this.apiKey = config.apiKey;
    this.modelo = config.modelo || 'gemini-2.5-flash';
    this.fetchFn = config.fetchFn || globalThis.fetch.bind(globalThis);
  }

  async leer(
    imagen: Buffer,
    mimeType: string,
    campos: CampoEsperado[],
    temperatura = 0.1,
  ): Promise<ResultadoLectura> {
    if (!imagen || imagen.length === 0) {
      throw new ProveedorIaError('gemini', 'El buffer de la imagen está vacío');
    }
    if (!campos || campos.length === 0) {
      throw new ProveedorIaError('gemini', 'Se requiere al menos un campo esperado');
    }

    const inicio = Date.now();
    const promptSistema = this.construirPrompt(campos);
    const base64Imagen = imagen.toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelo}:generateContent?key=${this.apiKey}`;

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
        temperature: temperatura,
        response_mime_type: 'application/json',
      },
    };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      throw new ProveedorIaError('gemini', `Error de conexión: ${err?.message ?? err}`);
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new ProveedorIaError('gemini', `HTTP ${res.status}: ${errorBody}`, res.status);
    }

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

    const camposLeidos = this.normalizarCampos(parsed.campos || {}, campos);

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
        };
      }

      const conf: string = String(extraido.confianza || 'media').toLowerCase();
      const confianza: Confianza =
        conf === 'alta' ? 'alta' : conf === 'baja' ? 'baja' : 'media';
      const dudoso = Boolean(extraido.dudoso ?? (confianza === 'baja'));

      let valor = extraido.valor;
      if (esperado.tipo === 'casilla') {
        if (typeof valor === 'string') {
          const valMin = valor.toLowerCase().trim();
          valor = valMin === 'true' || valMin === 'marcado' || valMin === 'x' || valMin === 'si';
        }
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
      };
    });
  }

  private calcularCosto(tokensIn: number, tokensOut: number): number {
    const costoIn = (tokensIn / 1_000_000) * 0.075;
    const costoOut = (tokensOut / 1_000_000) * 0.30;
    return Number((costoIn + costoOut).toFixed(6));
  }

  private construirPrompt(campos: CampoEsperado[]): string {
    return `Eres un sistema especializado en extracción y lectura de reportes técnicos de servicio industrial manuscritos (escritos a mano).

Tu única tarea es transcribir fielmente los campos visibles en el reporte físico escaneado.

REGLAS OBLIGATORIAS (Guía SIREP):
1. NUNCA inventes, completes ni supongas datos que no estén escritos.
2. Si un campo no se lee claramente o está vacío, devuelve valor: null y noLeido: true.
3. Evalúa tu confianza rigurosamente por campo:
   - "alta": La letra es legible sin ninguna ambigüedad.
   - "media": Se entiende por contexto pero algún carácter o número es dudoso.
   - "baja": Muy difícil de descifrar o incompleto. Marca dudoso: true.
4. Para casillas de verificación: Una casilla sin marca es valor: null (noLeido: true), no false. Si hay marca ambigua, confianza "baja".
5. Los textos largos (procedimiento, conclusión, recomendaciones) se transcriben fielmente sin corregir ortografía ni vocabulario técnico.
6. El número de reporte impreso (sello rojo en la cabecera) debe leerse en "numero_reporte".

CAMPOS SOLICITADOS:
${JSON.stringify(campos)}

Responde ESTRICTAMENTE con un objeto JSON:
{
  "numero_reporte": "000845" o null,
  "campos": {
    "nombre_clave": {
      "valor": string | boolean | null,
      "confianza": "alta" | "media" | "baja",
      "noLeido": boolean,
      "dudoso": boolean,
      "observacion": string
    }
  }
}`;
  }
}
