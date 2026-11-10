import { CampoEsperado, CampoLeido, ContextoAprendizaje, CorreccionAprendida } from './types';

/** Texto que se guarda como observación cuando un campo opcional está en blanco en el papel. */
export const OBSERVACION_EN_BLANCO = 'En blanco en el papel';

const AFIRMATIVOS = new Set(['true', 'marcado', 'marcada', 'x', 'si', 'sí', 'yes', '1', 'firmado', 'firmada']);

/**
 * Convierte lo que devolvió el modelo para una casilla en booleano. Antes solo se aceptaban
 * "true/marcado/x/si" y un "Sí" con tilde se leía como "No".
 */
export function casillaMarcada(valor: unknown): boolean {
  if (typeof valor === 'boolean') return valor;
  return AFIRMATIVOS.has(String(valor ?? '').toLowerCase().trim());
}

/**
 * Un campo opcional que el modelo declara en blanco ("vacio": true) o que omite del JSON por no
 * tener tinta en el papel no es un fallo de lectura: el papel simplemente no lo trae.
 * Si el modelo indica explícitamente que sí había tinta pero no pudo leerla (noLeido: true o vacio: false),
 * entonces NO está en blanco y debe pasar a revisión.
 */
export function esCampoEnBlanco(esperado: CampoEsperado, extraido: any): boolean {
  if (esperado.opcional !== true) return false;
  if (extraido === undefined || extraido === null) return true;
  const sinValor = extraido.valor === undefined || extraido.valor === null || extraido.valor === '';
  if (!sinValor) return false;
  if (extraido.vacio === false || extraido.noLeido === true) return false;
  return true;
}

/**
 * Campos de texto corto / entidades donde una corrección previa exacta (ej. "Absegu" -> "Abregu",
 * "UV DTE" -> "UV DTF") se puede aplicar automáticamente si el modelo vuelve a cometer el mismo error.
 */
const CAMPOS_AUTOCORREGIBLES = new Set([
  'tecnico',
  'empresa',
  'direccion',
  'contacto',
  'equipo',
  'operador',
  'tinta',
  'sistema_proteccion',
]);

/**
 * Aplica las correcciones aprendidas de revisiones humanas anteriores sobre los campos leídos.
 * Solo actúa cuando el campo tiene un texto leído que coincide exactamente (ignorando mayúsculas/espacios)
 * con un `valorErroneo` corregido previamente para ese mismo campo. Nunca rellena campos en blanco.
 */
export function aplicarCorreccionesAprendidas(
  campos: CampoLeido[],
  contexto?: ContextoAprendizaje,
): CampoLeido[] {
  const correcciones = contexto?.correcciones;
  if (!correcciones || correcciones.length === 0) return campos;

  return campos.map((campo) => {
    if (
      campo.noLeido ||
      typeof campo.valor !== 'string' ||
      !campo.valor.trim() ||
      !CAMPOS_AUTOCORREGIBLES.has(campo.clave)
    ) {
      return campo;
    }

    const valorNorm = normalizarTexto(campo.valor);
    const coincidencia = correcciones.find(
      (c) => c.campo === campo.clave && normalizarTexto(c.valorErroneo) === valorNorm,
    );
    if (!coincidencia) return campo;

    return {
      ...campo,
      valor: coincidencia.valorCorregido,
    };
  });
}

/**
 * Extrae correcciones aprendidas y vocabulario conocido a partir de filas históricas de `reportes`.
 * Combina una semilla base del taller GO Service Latam con las correcciones reales hechas en la bandeja.
 */
export function construirContextoDesdeReportes(
  filas: Array<{
    cliente?: string | null;
    tecnico_asignado?: string | null;
    serie_equipo?: string | null;
    direccion?: string | null;
    campos_extraidos?: Record<string, any> | null;
  }> = [],
): ContextoAprendizaje {
  const mapaCorrecciones = new Map<string, CorreccionAprendida>();
  const conjuntos: Record<string, Set<string>> = {
    empresa: new Set(['Abregu', 'Abregu Print', 'Cecely']),
    tecnico: new Set(['Orlando', 'Antony', 'Antony Yaranga', 'Carlos']),
    equipo: new Set(['UV DTF', 'Plotter DTF UV', 'Plotter DTF', 'UV Cama plana', 'Subli 3H', 'DTF 60cm']),
    contacto: new Set(['Vladimir', 'Julio']),
    operador: new Set(['Fiorella', 'Zamir', 'Adriana', 'Alexander']),
  };

  const agregarValorConocido = (campo: string, valor: unknown) => {
    if (typeof valor !== 'string') return;
    const limpio = valor.trim();
    if (!limpio || limpio.length > 60) return;
    if (!conjuntos[campo]) conjuntos[campo] = new Set();
    if (conjuntos[campo].size < 25) {
      conjuntos[campo].add(limpio);
    }
  };

  for (const fila of filas) {
    agregarValorConocido('empresa', fila.cliente);
    agregarValorConocido('tecnico', fila.tecnico_asignado);
    agregarValorConocido('equipo', fila.serie_equipo);

    const extraidos = fila.campos_extraidos;
    if (!extraidos || typeof extraidos !== 'object') continue;

    for (const [clave, datos] of Object.entries(extraidos)) {
      if (!datos || typeof datos !== 'object') continue;
      const rev = datos.revision;
      if (rev?.estado === 'corregido' && typeof rev.valor_corregido === 'string') {
        const corregido = rev.valor_corregido.trim();
        if (corregido) {
          agregarValorConocido(clave, corregido);
          const original = typeof datos.valor === 'string' ? datos.valor.trim() : '';
          if (original && normalizarTexto(original) !== normalizarTexto(corregido)) {
            const llave = `${clave}:${normalizarTexto(original)}`;
            if (!mapaCorrecciones.has(llave) && mapaCorrecciones.size < 40) {
              mapaCorrecciones.set(llave, {
                campo: clave,
                valorErroneo: original,
                valorCorregido: corregido,
              });
            }
          }
        }
      } else if (rev?.estado === 'confirmado' && typeof datos.valor === 'string') {
        agregarValorConocido(clave, datos.valor);
      }
    }
  }

  const valoresConocidos: Record<string, string[]> = {};
  for (const [clave, set] of Object.entries(conjuntos)) {
    if (set.size > 0) valoresConocidos[clave] = Array.from(set);
  }

  return {
    correcciones: Array.from(mapaCorrecciones.values()),
    valoresConocidos,
  };
}

/**
 * Normaliza un texto para comparación:
 * - Convierte a minúsculas
 * - Remueve tildes y diacríticos
 * - Colapsa espacios múltiples y quita espacios en extremos
 */
export function normalizarTexto(texto: unknown): string {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Normaliza una fecha al formato estándar AAAA-MM-DD.
 * Soporta formatos: DD/MM/AAAA, DD-MM-AAAA, AAAA-MM-DD, DD/MM/AA, etc.
 */
export function normalizarFechaEvaluacion(valor: unknown): string {
  if (!valor) return '';
  const str = String(valor).trim();
  if (!str) return '';

  // Formato AAAA-MM-DD
  const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    const [, a, m, d] = isoMatch;
    return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Formato DD/MM/AAAA o DD-MM-AAAA
  const latamMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (latamMatch) {
    const [, d, m, a] = latamMatch;
    return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Formato DD/MM/AA
  const cortoMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (cortoMatch) {
    const [, d, m, yy] = cortoMatch;
    const a = Number(yy) < 50 ? `20${yy}` : `19${yy}`;
    return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return normalizarTexto(str);
}

/**
 * Normaliza una hora al formato estándar HH:MM (24h).
 * Soporta formatos: H:MM, HH:MM, HH:MM:SS, con AM/PM opcional.
 */
export function normalizarHoraEvaluacion(valor: unknown): string {
  if (!valor) return '';
  const str = String(valor).trim();
  if (!str) return '';

  const ampmMatch = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (ampmMatch) {
    let horas = parseInt(ampmMatch[1], 10);
    const minutos = ampmMatch[2];
    const periodo = ampmMatch[3]?.toLowerCase();

    if (periodo) {
      const esPm = periodo.includes('p');
      if (esPm && horas < 12) horas += 12;
      if (!esPm && horas === 12) horas = 0;
    }

    return `${String(horas).padStart(2, '0')}:${minutos}`;
  }

  return normalizarTexto(str);
}

/**
 * Calcula el coeficiente de similitud de Dice / Sørensen entre dos textos.
 * Retorna un valor entre 0 (totalmente diferente) y 1 (idénticos).
 */
export function similitudTexto(a: string, b: string): number {
  const normA = normalizarTexto(a);
  const normB = normalizarTexto(b);

  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;
  if (normA.length < 2 || normB.length < 2) return normA === normB ? 1.0 : 0.0;

  const obtenerBigramas = (str: string): Map<string, number> => {
    const bigramas = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bigrama = str.substring(i, i + 2);
      bigramas.set(bigrama, (bigramas.get(bigrama) || 0) + 1);
    }
    return bigramas;
  };

  const bigramasA = obtenerBigramas(normA);
  const bigramasB = obtenerBigramas(normB);

  let interseccion = 0;
  for (const [bigrama, countA] of bigramasA.entries()) {
    if (bigramasB.has(bigrama)) {
      interseccion += Math.min(countA, bigramasB.get(bigrama)!);
    }
  }

  const total = (normA.length - 1) + (normB.length - 1);
  return total === 0 ? 0 : (2.0 * interseccion) / total;
}

export type ResultadoComparacion = 'correcto' | 'error' | 'no leído' | 'vacío correcto' | 'dudoso';

export interface EvaluacionCampo {
  resultado: ResultadoComparacion;
  valorEsperado: string;
  valorLeido: string;
  similitud?: number;
}

/**
 * Compara el valor extraído por el modelo contra la plantilla de referencia manual.
 * Aplica las reglas del Sprint 2:
 * - "vacío" o en blanco esperado vs noLeido/vacio => vacío correcto
 * - "ilegible" esperado vs noLeido => correcto
 * - Formatos normalizados para fecha y hora
 * - Similitud de texto con umbral para texto libre (procedimiento, conclusión, recomendaciones)
 */
export function compararCampo(
  clave: string,
  tipo: string,
  valorEsperadoRaw: unknown,
  valorLeidoRaw: unknown,
  noLeido: boolean,
): EvaluacionCampo {
  const esperadoNorm = normalizarTexto(valorEsperadoRaw);
  const esVacioEsperado = esperadoNorm === '' || esperadoNorm === 'vacio' || esperadoNorm === 'vacío' || esperadoNorm === 'n/a';
  const esIlegibleEsperado = esperadoNorm === 'ilegible';

  const leidoNorm = normalizarTexto(valorLeidoRaw);
  const esVacioLeido = noLeido || leidoNorm === '' || leidoNorm === 'null' || leidoNorm === 'undefined';

  const valorEsperadoStr = String(valorEsperadoRaw ?? '').trim();
  const valorLeidoStr = valorLeidoRaw === null || valorLeidoRaw === undefined ? '' : String(valorLeidoRaw).trim();

  // Caso 1: Se esperaba vacío en el papel
  if (esVacioEsperado) {
    if (esVacioLeido) {
      return { resultado: 'vacío correcto', valorEsperado: valorEsperadoStr || 'vacío', valorLeido: valorLeidoStr || '(vacío)' };
    }
    return { resultado: 'error', valorEsperado: valorEsperadoStr || 'vacío', valorLeido: valorLeidoStr };
  }

  // Caso 2: Se esperaba ilegible en el papel
  if (esIlegibleEsperado) {
    if (noLeido || esVacioLeido) {
      return { resultado: 'correcto', valorEsperado: valorEsperadoStr, valorLeido: 'no leído' };
    }
    return { resultado: 'dudoso', valorEsperado: valorEsperadoStr, valorLeido: valorLeidoStr };
  }

  // Caso 3: El modelo no leyó pero había un valor esperado
  if (esVacioLeido) {
    return { resultado: 'no leído', valorEsperado: valorEsperadoStr, valorLeido: '(no leído)' };
  }

  // Caso 4: Tipo fecha
  if (tipo === 'fecha') {
    const fEsp = normalizarFechaEvaluacion(valorEsperadoRaw);
    const fLei = normalizarFechaEvaluacion(valorLeidoRaw);
    return {
      resultado: fEsp === fLei ? 'correcto' : 'error',
      valorEsperado: fEsp,
      valorLeido: fLei,
    };
  }

  // Caso 5: Tipo hora
  if (tipo === 'hora') {
    const hEsp = normalizarHoraEvaluacion(valorEsperadoRaw);
    const hLei = normalizarHoraEvaluacion(valorLeidoRaw);
    return {
      resultado: hEsp === hLei ? 'correcto' : 'error',
      valorEsperado: hEsp,
      valorLeido: hLei,
    };
  }

  // Caso 6: Texto libre extenso (procedimiento, conclusion, recomendaciones)
  const esTextoLibre = ['procedimiento', 'conclusion', 'recomendaciones', 'motivo'].includes(clave);
  if (esTextoLibre) {
    const score = similitudTexto(String(valorEsperadoRaw), String(valorLeidoRaw));
    let res: ResultadoComparacion = 'error';
    if (score >= 0.82) {
      res = 'correcto';
    } else if (score >= 0.50) {
      res = 'dudoso'; // Marcar para revisión humana
    }
    return {
      resultado: res,
      valorEsperado: valorEsperadoStr,
      valorLeido: valorLeidoStr,
      similitud: Math.round(score * 100) / 100,
    };
  }

  // Caso 7: Comparación directa normalizada (sin tildes, minúsculas, espacios colapsados)
  const coincide = normalizarTexto(valorEsperadoRaw) === normalizarTexto(valorLeidoRaw);
  return {
    resultado: coincide ? 'correcto' : 'error',
    valorEsperado: valorEsperadoStr,
    valorLeido: valorLeidoStr,
  };
}
