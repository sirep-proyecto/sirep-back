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

export interface GeminiConfig {
  apiKey: string;
  modelo?: string;
  fetchFn?: typeof fetch;
  /** Intentos totales ante fallos transitorios del proveedor (por defecto 3). */
  intentosMaximos?: number;
  /** Espera antes del 2.º intento; se duplica en cada reintento (por defecto 2000 ms). */
  esperaBaseMs?: number;
}

// Sobrecarga o límite de tasa del lado de Google: suelen resolverse en segundos.
// Un 400/401/403/404 (clave o modelo mal puestos) NO se reintenta porque fallaría igual.
const ESTADOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);

export class GeminiLector implements LectorDeReportes {
  readonly nombre = 'gemini';
  readonly modelo: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly intentosMaximos: number;
  private readonly esperaBaseMs: number;

  constructor(config: GeminiConfig) {
    if (!config.apiKey) {
      throw new ProveedorIaError('gemini', 'GEMINI_API_KEY no configurada');
    }
    this.apiKey = config.apiKey;
    this.modelo = config.modelo || 'gemini-3.8-flash';
    this.fetchFn = config.fetchFn || globalThis.fetch.bind(globalThis);
    this.intentosMaximos = Math.max(1, config.intentosMaximos ?? 3);
    this.esperaBaseMs = config.esperaBaseMs ?? 2000;
  }

  async leer(
    imagen: Buffer,
    mimeType: string,
    campos: CampoEsperado[],
    temperatura = 0.1,
    contexto?: ContextoAprendizaje,
  ): Promise<ResultadoLectura> {
    if (!imagen || imagen.length === 0) {
      throw new ProveedorIaError('gemini', 'El buffer de la imagen está vacío');
    }
    if (!campos || campos.length === 0) {
      throw new ProveedorIaError('gemini', 'Se requiere al menos un campo esperado');
    }

    const inicio = Date.now();
    const promptSistema = this.construirPrompt(campos, contexto);
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

    const res = await this.enviarConReintentos(url, payload);

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

  /**
   * Envía la petición y reintenta con espera creciente ante errores transitorios
   * (503 "high demand", 429, 5xx o caída de red). Al agotar los intentos lanza el último error.
   */
  private async enviarConReintentos(url: string, payload: unknown): Promise<Response> {
    let ultimoError: ProveedorIaError | null = null;

    for (let intento = 1; intento <= this.intentosMaximos; intento++) {
      let res: Response | undefined;
      try {
        res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err: any) {
        ultimoError = new ProveedorIaError('gemini', `Error de conexión: ${err?.message ?? err}`);
      }

      if (res) {
        if (res.ok) return res;
        const errorBody = await res.text().catch(() => '');
        ultimoError = new ProveedorIaError('gemini', `HTTP ${res.status}: ${errorBody}`, res.status);
        if (!ESTADOS_REINTENTABLES.has(res.status)) throw ultimoError;
      }

      if (intento < this.intentosMaximos && this.esperaBaseMs > 0) {
        const espera = this.esperaBaseMs * 2 ** (intento - 1);
        // Sin esto un 503 se ve igual con o sin reintentos y no hay forma de saber si están funcionando
        console.warn(
          `[gemini] intento ${intento}/${this.intentosMaximos} falló (${ultimoError?.codigoHttp ?? 'sin respuesta'}); reintentando en ${espera} ms`,
        );
        await new Promise((r) => setTimeout(r, espera));
      }
    }

    throw ultimoError as ProveedorIaError;
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

  /**
   * Convierte la caja del modelo [ymin, xmin, ymax, xmax] (escala 0–1000) a coordenadas 0–1.
   * Se ensancha un poco porque el modelo suele ajustar la caja a la tinta y la letra manuscrita
   * se sale de la línea. Una caja inválida se descarga (null): el frontend usa entonces el mapa fijo.
   */
  private normalizarCaja(bruta: unknown): CajaCampo | null {
    if (!Array.isArray(bruta) || bruta.length !== 4) return null;
    const n = bruta.map(Number);
    if (n.some((v) => !Number.isFinite(v))) return null;
    const [ymin, xmin, ymax, xmax] = n.map((v) => Math.min(1000, Math.max(0, v)));
    if (ymax <= ymin || xmax <= xmin) return null;
    // Una caja que cubre casi toda la hoja es una respuesta vacía del modelo, no un campo
    if ((ymax - ymin) * (xmax - xmin) > 600_000) return null;

    const margenX = 6;
    const margenY = 5;
    const r = (v: number) => Number((v / 1000).toFixed(4));
    const x0 = Math.max(0, xmin - margenX);
    const y0 = Math.max(0, ymin - margenY);
    const x1 = Math.min(1000, xmax + margenX);
    const y1 = Math.min(1000, ymax + margenY);
    return { x: r(x0), y: r(y0), ancho: r(x1 - x0), alto: r(y1 - y0) };
  }

  private calcularCosto(tokensIn: number, tokensOut: number): number {
    const costoIn = (tokensIn / 1_000_000) * 0.075;
    const costoOut = (tokensOut / 1_000_000) * 0.30;
    return Number((costoIn + costoOut).toFixed(6));
  }

  private construirPrompt(campos: CampoEsperado[], contexto?: ContextoAprendizaje): string {
    const lineasContexto: string[] = [];
    if (contexto?.correcciones && contexto.correcciones.length > 0) {
      const lista = contexto.correcciones
        .map((c) => `  * En "${c.campo}": no confundir "${c.valorErroneo}" -> lo correcto es "${c.valorCorregido}"`)
        .join('\n');
      lineasContexto.push(`CORRECCIONES APRENDIDAS DE REPORTES ANTERIORES:\n${lista}`);
    }
    if (contexto?.contactos && contexto.contactos.length > 0) {
      const listaContactos = contexto.contactos
        .filter((c) => c.nombre && (c.direccionPrincipal || (c.direcciones && c.direcciones.length > 0)))
        .map((c) => {
          const dirs = c.direcciones?.length ? c.direcciones.join(' / ') : c.direccionPrincipal;
          const emp = c.empresa ? ` (Cliente: ${c.empresa})` : '';
          return `  * Contacto "${c.nombre}"${emp} -> concurre al local en: ${dirs}`;
        })
        .join('\n');
      if (listaContactos) {
        lineasContexto.push(
          `USUARIOS REGISTRADOS EN CONTACTO Y DIRECCIÓN DE SU LOCAL (si en el papel no se ve bien la dirección pero identificas este nombre en la casilla CONTACTO, úsalo para reconocer la dirección almacenada de su local):\n${listaContactos}`,
        );
      }
    }
    if (contexto?.clientes && contexto.clientes.length > 0) {
      const listaClientes = contexto.clientes
        .filter((cli) => cli.nombre && cli.direcciones && cli.direcciones.length > 0)
        .map((cli) => {
          const conts = cli.contactos?.length ? ` | Contactos: ${cli.contactos.join(', ')}` : '';
          return `  * Cliente "${cli.nombre}" -> Locales: ${cli.direcciones.join(' | ')}${conts}`;
        })
        .join('\n');
      if (listaClientes) {
        lineasContexto.push(`DIRECTORIO DE CLIENTES Y LOCALES REGISTRADOS:\n${listaClientes}`);
      }
    }
    if (contexto?.valoresConocidos && Object.keys(contexto.valoresConocidos).length > 0) {
      const lista = Object.entries(contexto.valoresConocidos)
        .filter(([, vals]) => vals && vals.length > 0)
        .map(([campo, vals]) => `  * ${campo}: ${vals.join(', ')}`)
        .join('\n');
      if (lista) {
        lineasContexto.push(
          `VOCABULARIO REAL DEL TALLER (úsalo SOLO para desempatar letras manuscritas dudosas cuando SÍ haya tinta escrita en el campo; NUNCA para rellenar campos en blanco):\n${lista}`,
        );
      }
    }
    const bloqueContexto = lineasContexto.length > 0 ? `\n\n${lineasContexto.join('\n\n')}` : '';

    return `Eres un sistema especializado en extracción y lectura de reportes técnicos de servicio industrial manuscritos (escritos a mano).

Tu única tarea es inspeccionar visualmente TODOS los campos del formulario físico escaneado y transcribir fielmente todo lo que tenga tinta manuscrita (azul o negra).

REGLAS OBLIGATORIAS (Guía SIREP):
1. ESCANEO COMPLETO DE TINTA (AZUL O NEGRA):
   - Revisa visualmente CADA UNO de los campos solicitados (incluyendo teléfono, contacto, equipo, revisión inicial, repuestos, horas y firmas).
   - SIEMPRE que un campo tenga tinta escrita o marcada (letras, números, checks ✓/X o firmas en lapicero azul o negro), DEBES incluirlo y transcribirlo en "campos".
   - NUNCA inventes, completes ni supongas datos donde no haya tinta.
2. AHORRO DE TOKENS EN ESPACIOS EN BLANCO:
   - Si en ESTE documento un campo con "opcional": true está completamente en blanco en el papel (sin nada de tinta escrita ni casilla marcada), OMÍTELO del objeto "campos" (no lo escribas en el JSON) o devuelve {"vacio": true}.
   - Si SÍ hay tinta escrita o un tachón en el campo pero no logras leerlo, NO lo omitas: inclúyelo con valor: null, "vacio": false, "noLeido": true y "dudoso": true.
3. Evalúa tu confianza rigurosamente por campo con tinta:
   - "alta": La letra o marca es legible sin ninguna ambigüedad.
   - "media": Se entiende por contexto pero algún carácter o número es dudoso.
   - "baja": Muy difícil de descifrar o incompleto. Marca dudoso: true.
4. POSICIÓN EXACTA DE CASILLAS EN EL FORMULARIO GO SERVICE LATAM:
   - En REVISION INICIAL y REPUESTOS REQUERIDOS, cada casilla cuadrada [ ] está impresa inmediatamente a la DERECHA de su texto:
     * ESTADO DEL EQUIPO: Operativo [ ]   Inoperativo [ ]
     * LIMPIEZA DEL EQUIPO: Limpio [ ]   Sucio [ ]
     * CABEZALES: Bueno [ ]   Regular [ ]   Malo [ ]
     * SIST. DE PROTECCION: Estab. [ ]   UPS [ ]   [recuadro de texto]
   - Verifica dentro de cuál cuadrado exacto está trazado el check (✓ o X). No confundas una marca dentro de la casilla de "Limpio [✓]" con la palabra "Sucio" que está a su derecha.
   - Para campos tipo "casilla": si está marcada devuelve true; si no tiene marca, omítelo (o valor: null).
   - Para campos tipo "opcion": devuelve el TEXTO exacto de la opción cuya casilla derecha está marcada (ej. "Limpio"); si ninguna está marcada, omítelo.
   - Para "sistema_proteccion": revisa tanto las casillas "Estab." y "UPS" como el recuadro de al lado (si la casilla "Estab." está marcada, devuelve "Estab."; si en el recuadro dice "ninguno" o "nada", devuelve ese texto con confianza "alta").
   - Para firmas ("firma_operador", "firma_cliente"): devuelve true si hay firma o rúbrica en tinta sobre la línea; si la línea está vacía, omítelo.
5. FECHAS Y HORAS ("fecha", "hora_llegada" y "hora_salida"):
   - En manuscritos de Perú el dígito "7" suele escribirse con una rayita horizontal en el medio (7̶); no lo confundas con un "9" (ej. "07-02-24").
   - Lee con cuidado los dígitos manuscritos de las horas (ej. no confundir un "5" de trazo cerrado con un "8"). Verifica que "hora_salida" sea coherente con "hora_llegada" dentro de la jornada.
6. Los textos largos (procedimiento, conclusión, recomendaciones) se transcriben fielmente sin corregir ortografía ni vocabulario técnico.
7. El número de reporte impreso (sello rojo en la cabecera) debe leerse en "numero_reporte".
8. Para cada campo con tinta que incluyas en "campos", devuelve "caja_2d": [ymin, xmin, ymax, xmax] con enteros de 0 a 1000 medidos sobre la IMAGEN COMPLETA (encerrando solo el área con el valor manuscrito, no la etiqueta impresa).
9. En "observacion" escribe una frase corta en español SOLO cuando la confianza sea "media" o "baja" explicando qué letra o dígito generó duda. Si la confianza es "alta", omite "observacion" o déjala vacía.${bloqueContexto}

CAMPOS SOLICITADOS:
${JSON.stringify(campos)}

Responde ESTRICTAMENTE con un objeto JSON (omitiendo de "campos" los opcionales que estén completamente en blanco sin tinta en este papel):
{
  "numero_reporte": "000845" o null,
  "campos": {
    "nombre_clave": {
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