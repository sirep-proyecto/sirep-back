/**
 * Lo que comparten los lectores de Gemini y de OpenAI (ChatGPT): el prompt, cómo se
 * interpreta la respuesta (campos, cajas y etiquetas) y los reintentos ante límites.
 *
 * Antes vivía dentro de GeminiLector. Se sacó aquí para que, al cambiar de proveedor
 * desde Configuración, los dos lean el talonario con las mismas reglas y devuelvan las
 * cajas que usa el visor (clic en el campo). Si se cambia una regla, cambia para ambos.
 */
import {
  CajaCampo,
  CampoEsperado,
  CampoLeido,
  Confianza,
  ContextoAprendizaje,
  ProveedorIaError,
} from './types';
import { OBSERVACION_EN_BLANCO, casillaMarcada, esCampoEnBlanco } from './normalizacion';
import { resolverPromptConfigurado } from './anthropic.proveedor';
import { ETIQUETAS_ANCLA } from './etiquetas-ancla';

/**
 * Clave tomada de una variable de entorno. Si al pegarla en Render se coló otra línea
 * (por ejemplo "OPENAI_MODEL=gpt-4o-mini"), se usa solo la primera palabra: un valor con
 * espacios o saltos de línea no se puede mandar como cabecera y el error mostraría la clave.
 */
export function claveDeEntorno(valor: string | undefined): string {
  const primera = String(valor ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\x21-\x7e]+$/.test(primera) ? primera : '';
}

/** Quita de un mensaje de error cualquier clave, para que nunca llegue a la pantalla ni a los registros. */
export function ocultarClaves(mensaje: string, ...claves: Array<string | null | undefined>): string {
  let m = String(mensaje ?? '');
  for (const c of claves) if (c && c.length >= 6) m = m.split(c).join('••••');
  return m
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ••••')
    .replace(/\b(sk-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{6,})/g, '••••');
}

// Sobrecarga o límite de tasa del proveedor: suelen resolverse en segundos.
// Un 400/401/403/404 (clave o modelo mal puestos) NO se reintenta porque fallaría igual.
export const ESTADOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);

/**
 * Envía la petición y reintenta con espera creciente ante errores transitorios
 * (503 "high demand", 429, 5xx o caída de red). Al agotar los intentos lanza el último error.
 */
export async function enviarConReintentos(
  proveedor: string,
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  intentosMaximos: number,
  esperaBaseMs: number,
): Promise<Response> {
  let ultimoError: ProveedorIaError | null = null;

  for (let intento = 1; intento <= intentosMaximos; intento++) {
    let res: Response | undefined;
    try {
      res = await fetchFn(url, init);
    } catch (err: any) {
      // El mensaje de fetch puede traer la cabecera con la clave ("invalid header value")
      ultimoError = new ProveedorIaError(proveedor, `Error de conexión: ${ocultarClaves(String(err?.message ?? err))}`);
    }

    if (res) {
      if (res.ok) return res;
      const errorBody = await res.text().catch(() => '');
      ultimoError = new ProveedorIaError(proveedor, `HTTP ${res.status}: ${ocultarClaves(errorBody)}`, res.status);
      if (!ESTADOS_REINTENTABLES.has(res.status)) throw ultimoError;
    }

    if (intento < intentosMaximos && esperaBaseMs > 0) {
      const espera = esperaBaseMs * 2 ** (intento - 1);
      // Sin esto un 503 se ve igual con o sin reintentos y no hay forma de saber si están funcionando
      console.warn(
        `[${proveedor}] intento ${intento}/${intentosMaximos} falló (${ultimoError?.codigoHttp ?? 'sin respuesta'}); reintentando en ${espera} ms`,
      );
      await new Promise((r) => setTimeout(r, espera));
    }
  }

  throw ultimoError as ProveedorIaError;
}

/** Etiquetas impresas → cajas 0–1 sin margen (se usa su borde derecho exacto como ancla). */
export function normalizarEtiquetas(bruto: unknown): Array<{ campo: string; caja: CajaCampo }> {
  if (!bruto || typeof bruto !== 'object') return [];
  const salida: Array<{ campo: string; caja: CajaCampo }> = [];
  for (const [campo, caja] of Object.entries(bruto as Record<string, unknown>)) {
    if (!(campo in ETIQUETAS_ANCLA) || !Array.isArray(caja) || caja.length !== 4) continue;
    const n = caja.map(Number);
    if (n.some((v) => !Number.isFinite(v))) continue;
    const [ymin, xmin, ymax, xmax] = n.map((v) => Math.min(1000, Math.max(0, v)));
    if (ymax <= ymin || xmax <= xmin) continue;
    // Una etiqueta es una línea de texto: una caja enorme es una respuesta inválida
    if (ymax - ymin > 80 || xmax - xmin > 450) continue;
    salida.push({
      campo,
      caja: { x: xmin / 1000, y: ymin / 1000, ancho: (xmax - xmin) / 1000, alto: (ymax - ymin) / 1000 },
    });
  }
  return salida;
}


export function normalizarCamposLeidos(
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
        caja: normalizarCaja(extraido?.caja_2d),
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
        caja: normalizarCaja(extraido?.caja_2d),
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
      caja: normalizarCaja(extraido.caja_2d),
    };
  });
}

/**
 * Convierte la caja del modelo [ymin, xmin, ymax, xmax] (escala 0–1000) a coordenadas 0–1.
 * Se ensancha un poco porque el modelo suele ajustar la caja a la tinta y la letra manuscrita
 * se sale de la línea. Una caja inválida se descarga (null): el frontend usa entonces el mapa fijo.
 */
export function normalizarCaja(bruta: unknown): CajaCampo | null {
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

  export function construirPromptLectura(
  campos: CampoEsperado[],
  contexto?: ContextoAprendizaje,
  promptPersonalizado?: string,
): string {
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
    const promptConfigurado = resolverPromptConfigurado(promptPersonalizado);
    const bloqueExtraPrompt = promptConfigurado ? `\n\nINSTRUCCIONES DE PROMPT CONFIGURADAS:\n${promptConfigurado}` : '';
    const usarSecciones = process.env.IA_PROMPT_SECCIONES === 'true';
    const bloqueSecciones = usarSecciones
      ? `\n\nMODO POR SECCIONES DEL TALONARIO (inspecciona bloque por bloque en orden visual):
- SECCIÓN 1 (Cabecera): numero_reporte, tecnico, empresa, fecha, telefono, direccion, contacto, equipo, motivo.
- SECCIÓN 2 (Revisión Inicial): estado_del_equipo, ultimo_mantenimiento, limpieza_equipo, cabezales, sistema_proteccion, tinta, revision_linea_ln, revision_linea_lt, revision_linea_nt, operador.
- SECCIÓN 3 (Servicio Realizado): procedimiento, conclusion, recomendaciones.
- SECCIÓN 4 (Repuestos Requeridos): repuestos_tipo, codigo_repuesto, repuestos_descripcion, repuestos_cantidad.
- SECCIÓN 5 (Labor y Cierre): hora_llegada, hora_salida, garantia, facturado, firma_operador, firma_cliente.`
      : '';

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
9. ETIQUETAS IMPRESAS (para ubicar el formulario en la imagen): en "etiquetas" devuelve, para cada texto IMPRESO de esta lista que veas en la imagen, su "caja_2d" [ymin, xmin, ymax, xmax] (enteros 0–1000 sobre la IMAGEN COMPLETA) encerrando SOLO las letras impresas de la etiqueta, ajustada al texto, sin incluir el recuadro ni la letra a mano que está al lado: ${JSON.stringify(ETIQUETAS_ANCLA)}. Si una etiqueta no se ve (hoja cortada o reverso), omítela.
10. En "observacion" escribe una frase corta en español SOLO cuando la confianza sea "media" o "baja" explicando qué letra o dígito generó duda. Si la confianza es "alta", omite "observacion" o déjala vacía.${bloqueContexto}${bloqueSecciones}${bloqueExtraPrompt}

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
  },
  "etiquetas": { "empresa": [ymin, xmin, ymax, xmax], "fecha": [ymin, xmin, ymax, xmax] }
}`;
  }
