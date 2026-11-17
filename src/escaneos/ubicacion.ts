/**
 * Responsabilidad: ubicar cada campo del talonario en ESTE escaneo a partir de las
 * etiquetas impresas ("EMPRESA:", "FECHA:", "ULTIMO MANT.:"…) que la IA encuentra.
 *
 * Existe porque el mapa fijo del talonario supone que la hoja está siempre en el mismo
 * sitio, y cada escaneo sale algo corrido, con otro margen o levemente girado. Las
 * etiquetas impresas son idénticas en todos los talonarios y la IA las localiza mucho
 * mejor que la letra a mano, así que sirven de "anclas":
 *
 *  1. Cada etiqueta tiene una posición conocida en el talonario: termina justo donde
 *     empieza el recuadro de su campo, a media altura de ese recuadro.
 *  2. Con las anclas encontradas se ajusta una transformación afín (mueve, escala y
 *     corrige un giro leve) del mapa del talonario a esta imagen. Las anclas que no
 *     cuadran con las demás (una etiqueta mal ubicada por la IA) se descartan.
 *  3. Todos los campos —también los vacíos, que la IA no marca— se colocan con esa
 *     transformación, y los que tienen su propia etiqueta se afinan con ella.
 *
 * Si hay pocas anclas o la transformación no es creíble, no se toca nada y se conserva
 * lo de antes (la caja que dio la IA o el mapa fijo). Funciones puras, sin red.
 */
import { REGIONES_TALONARIO } from '../reportes/talonario.regiones';
import type { CajaCampo, CampoLeido } from '../ia-extractor/types';
import { ETIQUETAS_ANCLA } from '../ia-extractor/etiquetas-ancla';

export { ETIQUETAS_ANCLA };

/** Caja de una etiqueta impresa encontrada por la IA (coordenadas 0–1 de la página). */
export interface EtiquetaEncontrada {
  campo: string;
  caja: CajaCampo;
}

interface Punto {
  x: number;
  y: number;
}

/** x' = a·x + b·y + c ; y' = d·x + e·y + f */
export interface Afin {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface ResultadoUbicacion {
  transformacion: Afin;
  /** Anclas que entraron al ajuste (las demás se descartaron por no cuadrar). */
  anclasUsadas: string[];
  /** Error medio de las anclas usadas, en fracción de la página. */
  errorMedio: number;
}

const MINIMO_ANCLAS = 5;
/** Corrección local máxima que se acepta de la propia etiqueta, en fracción de página. */
const AJUSTE_LOCAL_MAXIMO = 0.025;
/** Por encima de este error medio la transformación no se considera fiable. */
const ERROR_MAXIMO = 0.02;

/** Dónde DEBERÍA estar el ancla de un campo según el mapa del talonario. */
function anclaEsperada(campo: string): Punto | null {
  const r = REGIONES_TALONARIO[campo];
  return r ? { x: r.x, y: r.y + r.alto / 2 } : null;
}

/** Dónde está el ancla en ESTE escaneo: borde derecho de la etiqueta, a media altura. */
function anclaEncontrada(caja: CajaCampo): Punto {
  return { x: caja.x + caja.ancho, y: caja.y + caja.alto / 2 };
}

export function aplicarAfin(t: Afin, p: Punto): Punto {
  return { x: t.a * p.x + t.b * p.y + t.c, y: t.d * p.x + t.e * p.y + t.f };
}

/** Resuelve un sistema 3×3 por Cramer; null si es singular. */
function resolver3(m: number[][], v: number[]): number[] | null {
  const det = (k: number[][]) =>
    k[0][0] * (k[1][1] * k[2][2] - k[1][2] * k[2][1]) -
    k[0][1] * (k[1][0] * k[2][2] - k[1][2] * k[2][0]) +
    k[0][2] * (k[1][0] * k[2][1] - k[1][1] * k[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  return [0, 1, 2].map((col) => det(m.map((fila, i) => fila.map((val, j) => (j === col ? v[i] : val)))) / d);
}

/** Mínimos cuadrados de la afín que lleva `origen` a `destino`. */
export function ajustarAfin(origen: Punto[], destino: Punto[]): Afin | null {
  if (origen.length < 3) return null;
  const sxx = origen.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = origen.reduce((s, p) => s + p.x * p.y, 0);
  const syy = origen.reduce((s, p) => s + p.y * p.y, 0);
  const sx = origen.reduce((s, p) => s + p.x, 0);
  const sy = origen.reduce((s, p) => s + p.y, 0);
  const n = origen.length;
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const lado = (sel: (q: Punto) => number) => [
    origen.reduce((s, p, i) => s + p.x * sel(destino[i]), 0),
    origen.reduce((s, p, i) => s + p.y * sel(destino[i]), 0),
    destino.reduce((s, q) => s + sel(q), 0),
  ];
  const fx = resolver3(m, lado((q) => q.x));
  const fy = resolver3(m, lado((q) => q.y));
  if (!fx || !fy) return null;
  return { a: fx[0], b: fx[1], c: fx[2], d: fy[0], e: fy[1], f: fy[2] };
}

/** Una transformación creíble solo escala un poco, gira poco y no se sale de la hoja. */
function esCreible(t: Afin): boolean {
  const escalaX = Math.hypot(t.a, t.d);
  const escalaY = Math.hypot(t.b, t.e);
  const giro = Math.abs(Math.atan2(t.d, t.a));
  return (
    escalaX > 0.75 && escalaX < 1.3 &&
    escalaY > 0.75 && escalaY < 1.3 &&
    giro < 0.09 && // ~5°
    Math.abs(t.c) < 0.25 && Math.abs(t.f) < 0.25
  );
}

const distancia = (p: Punto, q: Punto) => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * Calcula la transformación del talonario a este escaneo con las etiquetas encontradas.
 * Descarta iterativamente las anclas que no cuadran (residuo grande frente a la mediana).
 */
export function calcularUbicacion(etiquetas: readonly EtiquetaEncontrada[]): ResultadoUbicacion | null {
  let pares = etiquetas
    .map((e) => ({ campo: e.campo, esperado: anclaEsperada(e.campo), real: anclaEncontrada(e.caja) }))
    .filter((p): p is { campo: string; esperado: Punto; real: Punto } => p.esperado !== null);

  for (let ronda = 0; ronda < 4; ronda++) {
    if (pares.length < MINIMO_ANCLAS) return null;
    const t = ajustarAfin(pares.map((p) => p.esperado), pares.map((p) => p.real));
    if (!t) return null;
    const residuos = pares.map((p) => distancia(aplicarAfin(t, p.esperado), p.real));
    const ordenados = [...residuos].sort((x, y) => x - y);
    const mediana = ordenados[Math.floor(ordenados.length / 2)];
    const umbral = Math.max(0.012, 2.5 * mediana);
    const quedan = pares.filter((_, i) => residuos[i] <= umbral);
    if (quedan.length === pares.length) {
      const errorMedio = residuos.reduce((s, r) => s + r, 0) / residuos.length;
      if (!esCreible(t) || errorMedio > ERROR_MAXIMO) return null;
      return { transformacion: t, anclasUsadas: pares.map((p) => p.campo), errorMedio };
    }
    pares = quedan;
  }
  return null;
}

const recortar01 = (v: number) => Math.min(1, Math.max(0, v));
const redondear = (v: number) => Number(v.toFixed(4));

/** Región del talonario llevada a este escaneo (las 4 esquinas transformadas → caja que las contiene). */
function transformarRegion(t: Afin, campo: string): CajaCampo | null {
  const r = REGIONES_TALONARIO[campo];
  if (!r) return null;
  const esquinas = [
    { x: r.x, y: r.y },
    { x: r.x + r.ancho, y: r.y },
    { x: r.x, y: r.y + r.alto },
    { x: r.x + r.ancho, y: r.y + r.alto },
  ].map((p) => aplicarAfin(t, p));
  const x0 = recortar01(Math.min(...esquinas.map((p) => p.x)));
  const y0 = recortar01(Math.min(...esquinas.map((p) => p.y)));
  const x1 = recortar01(Math.max(...esquinas.map((p) => p.x)));
  const y1 = recortar01(Math.max(...esquinas.map((p) => p.y)));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: redondear(x0), y: redondear(y0), ancho: redondear(x1 - x0), alto: redondear(y1 - y0) };
}

/**
 * Coloca en `caja` la zona de cada campo en este escaneo. Devuelve los campos nuevos
 * (no modifica los de entrada) y el resultado del ajuste, o null si no hubo ajuste fiable.
 */
export function ubicarCampos(
  campos: readonly CampoLeido[],
  etiquetas: readonly EtiquetaEncontrada[],
  pagina: number,
): { campos: CampoLeido[]; ubicacion: ResultadoUbicacion | null } {
  const ubicacion = calcularUbicacion(etiquetas);
  if (!ubicacion) return { campos: [...campos], ubicacion: null };

  const t = ubicacion.transformacion;
  const usadas = new Set(ubicacion.anclasUsadas);
  const etiquetaDe = new Map(etiquetas.map((e) => [e.campo, e.caja]));

  const nuevos = campos.map((campo) => {
    const base = transformarRegion(t, campo.clave);
    if (!base) return campo;

    // Afinado local: si la etiqueta de ESTE campo cuadró, se corrige el pequeño desvío
    // que le queda (hoja levemente doblada); nunca más de AJUSTE_LOCAL_MAXIMO.
    let dx = 0;
    let dy = 0;
    const propia = etiquetaDe.get(campo.clave);
    const esperado = anclaEsperada(campo.clave);
    if (propia && esperado && usadas.has(campo.clave)) {
      const previsto = aplicarAfin(t, esperado);
      const real = anclaEncontrada(propia);
      dx = Math.max(-AJUSTE_LOCAL_MAXIMO, Math.min(AJUSTE_LOCAL_MAXIMO, real.x - previsto.x));
      dy = Math.max(-AJUSTE_LOCAL_MAXIMO, Math.min(AJUSTE_LOCAL_MAXIMO, real.y - previsto.y));
    }
    const caja: CajaCampo = {
      x: redondear(recortar01(base.x + dx)),
      y: redondear(recortar01(base.y + dy)),
      ancho: base.ancho,
      alto: base.alto,
      pagina,
    };
    return { ...campo, caja };
  });

  return { campos: nuevos, ubicacion };
}
