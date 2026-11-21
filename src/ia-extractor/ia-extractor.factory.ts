import {
  AnthropicConfig,
  AnthropicLector,
  resolverPromptConfigurado,
  resolverTemperaturaConfigurada,
} from './anthropic.proveedor';
import { GeminiConfig, GeminiLector } from './gemini.proveedor';
import { OpenAIConfig, OpenAILector } from './openai.proveedor';
import { LectorDeReportes, ProveedorIaError } from './types';
import { claveDeEntorno } from './lectura-comun';

export interface FactoryOptions {
  proveedor?: string;
  modelo?: string;
  temperatura?: number;
  promptPersonalizado?: string;
  geminiConfig?: Partial<GeminiConfig>;
  openaiConfig?: Partial<OpenAIConfig>;
  anthropicConfig?: Partial<AnthropicConfig>;
}

/** Lee un entero positivo de una variable de entorno; si no existe o es inválido devuelve undefined. */
function enteroDeEnv(nombre: string): number | undefined {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n >= 0 && process.env[nombre] !== undefined && process.env[nombre] !== ''
    ? Math.floor(n)
    : undefined;
}

/**
 * SIREP-S3-T16: Fábrica configurable sin tocar código para:
 * - Proveedor (`IA_PROVEEDOR` | `IA_PROVIDER`: 'gemini' | 'openai' | 'anthropic' | 'claude')
 * - Modelo (`IA_MODELO` | `IA_MODEL` o `GEMINI_MODEL` / `OPENAI_MODEL` / `ANTHROPIC_MODEL`)
 * - Temperatura (`IA_TEMPERATURA` | `IA_TEMPERATURE`)
 * - Prompt (`IA_PROMPT` | `IA_PROMPT_ARCHIVO`)
 */
export function crearLectorDeReportes(opciones?: FactoryOptions): LectorDeReportes {
  const proveedorCrudo = (
    opciones?.proveedor ||
    process.env.IA_PROVEEDOR ||
    process.env.IA_PROVIDER ||
    'gemini'
  )
    .trim()
    .toLowerCase();

  const proveedor = proveedorCrudo === 'claude' ? 'anthropic' : proveedorCrudo;
  const modeloGlobal = opciones?.modelo || process.env.IA_MODELO || process.env.IA_MODEL || undefined;
  const temperatura = resolverTemperaturaConfigurada(opciones?.temperatura);
  const promptPersonalizado = resolverPromptConfigurado(opciones?.promptPersonalizado);

  if (proveedor === 'gemini') {
    const apiKey =
      opciones?.geminiConfig?.apiKey || claveDeEntorno(process.env.GEMINI_API_KEY);
    const modelo =
      opciones?.geminiConfig?.modelo || modeloGlobal || process.env.GEMINI_MODEL;
    return new GeminiLector({
      apiKey,
      modelo,
      temperatura: opciones?.geminiConfig?.temperatura ?? temperatura,
      promptPersonalizado: opciones?.geminiConfig?.promptPersonalizado ?? promptPersonalizado,
      fetchFn: opciones?.geminiConfig?.fetchFn,
      intentosMaximos: opciones?.geminiConfig?.intentosMaximos ?? enteroDeEnv('GEMINI_REINTENTOS'),
      esperaBaseMs: opciones?.geminiConfig?.esperaBaseMs ?? enteroDeEnv('GEMINI_ESPERA_MS'),
    });
  }

  if (proveedor === 'openai') {
    const apiKey =
      opciones?.openaiConfig?.apiKey || claveDeEntorno(process.env.OPENAI_API_KEY);
    const modelo =
      opciones?.openaiConfig?.modelo || modeloGlobal || process.env.OPENAI_MODEL;
    return new OpenAILector({
      apiKey,
      modelo,
      temperatura: opciones?.openaiConfig?.temperatura ?? temperatura,
      promptPersonalizado: opciones?.openaiConfig?.promptPersonalizado ?? promptPersonalizado,
      fetchFn: opciones?.openaiConfig?.fetchFn,
      // Mismos reintentos que Gemini salvo que se fijen aparte para OpenAI
      intentosMaximos:
        opciones?.openaiConfig?.intentosMaximos ?? enteroDeEnv('OPENAI_REINTENTOS') ?? enteroDeEnv('GEMINI_REINTENTOS'),
      esperaBaseMs:
        opciones?.openaiConfig?.esperaBaseMs ?? enteroDeEnv('OPENAI_ESPERA_MS') ?? enteroDeEnv('GEMINI_ESPERA_MS'),
    });
  }

  if (proveedor === 'anthropic') {
    const apiKey =
      opciones?.anthropicConfig?.apiKey || process.env.ANTHROPIC_API_KEY || '';
    const modelo =
      opciones?.anthropicConfig?.modelo || modeloGlobal || process.env.ANTHROPIC_MODEL;
    return new AnthropicLector({
      apiKey,
      modelo,
      temperatura: opciones?.anthropicConfig?.temperatura ?? temperatura,
      promptPersonalizado: opciones?.anthropicConfig?.promptPersonalizado ?? promptPersonalizado,
      fetchFn: opciones?.anthropicConfig?.fetchFn,
    });
  }

  throw new ProveedorIaError(
    proveedorCrudo,
    `Proveedor de IA no soportado: "${proveedorCrudo}". Opciones válidas: 'gemini', 'openai', 'anthropic' ('claude').`,
  );
}
