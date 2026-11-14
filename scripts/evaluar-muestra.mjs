#!/usr/bin/env node
/**
 * SIREP-S2-T07 / SIREP-S3-T15 / SIREP-S3-T17:
 * Script de Evaluación Automatizada y Experimentos de la Muestra con IA.
 *
 * Uso:
 *   node scripts/evaluar-muestra.mjs [opciones]
 *
 * Opciones:
 *   --proveedor=gemini|openai|anthropic   Proveedor de IA a utilizar (por defecto IA_PROVEEDOR o gemini)
 *   --modelo=nombre_modelo                Nombre exacto del modelo
 *   --lado-largo=1600|2400                Resolución de la imagen en píxeles de lado largo (por defecto 1600)
 *   --temperatura=0.1                     Temperatura de muestreo (0.0 a 2.0)
 *   --preprocesar=true|false              Activa normalización de contraste y nitidez (SIREP-S3-T17)
 *   --prompt-secciones=true|false         Activa guía de lectura por secciones del talonario (SIREP-S3-T17)
 *   --evaluador-ia=true|false             Evalúa textos largos dudosos con IA semántica si hay API key
 *   --muestra=ruta_directorio             Directorio local con PDFs o imágenes escaneadas (por defecto ./muestra)
 *   --plantilla=ruta_archivo              Archivo CSV con transcripción manual a ciegas
 *   --salida=ruta_salida.csv              Ruta del CSV resultante
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const args = process.argv.slice(2);
function obtenerArg(nombre, defecto = undefined) {
  const prefix = `--${nombre}=`;
  const match = args.find((a) => a.startsWith(prefix));
  if (match) return match.substring(prefix.length);
  return defecto;
}

const proveedor = (
  obtenerArg('proveedor') ||
  process.env.IA_PROVEEDOR ||
  process.env.IA_PROVIDER ||
  'gemini'
).toLowerCase();

const modeloPorDefecto =
  proveedor === 'gemini'
    ? process.env.GEMINI_MODEL || 'gemini-3.8-flash'
    : proveedor === 'anthropic' || proveedor === 'claude'
      ? process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest'
      : process.env.OPENAI_MODEL || 'gpt-4o-mini';

const modelo = obtenerArg('modelo') || process.env.IA_MODELO || modeloPorDefecto;
const ladoLargo = parseInt(obtenerArg('lado-largo', process.env.IA_LADO_LARGO_PX || '1600'), 10);
const temperaturaArg = obtenerArg('temperatura');
const temperatura = temperaturaArg !== undefined ? Number(temperaturaArg) : undefined;
const preprocesar = obtenerArg('preprocesar', process.env.IA_PREPROCESAR_IMAGEN || 'false') === 'true';
const promptSecciones = obtenerArg('prompt-secciones', process.env.IA_PROMPT_SECCIONES || 'false') === 'true';
const evaluadorIa = obtenerArg('evaluador-ia', 'false') === 'true';
const dirMuestra = path.resolve(obtenerArg('muestra', './muestra'));
const archivoPlantilla = path.resolve(obtenerArg('plantilla', './muestra/transcripcion_manual.csv'));
const dirSalidaJson = path.resolve(obtenerArg('dir-json', './resultados_json'));
const sufijoPre = preprocesar ? '_pre' : '';
const rutaCsvSalida = path.resolve(
  obtenerArg('salida', `./evaluacion_${proveedor}_${ladoLargo}px${sufijoPre}.csv`),
);

if (promptSecciones) {
  process.env.IA_PROMPT_SECCIONES = 'true';
}
if (preprocesar) {
  process.env.IA_PREPROCESAR_IMAGEN = 'true';
}

console.log('='.repeat(70));
console.log('       SIREP — Evaluación Automatizada y Experimentos (T15 / T17)');
console.log('='.repeat(70));
console.log(`Proveedor:        ${proveedor}`);
console.log(`Modelo:           ${modelo}`);
console.log(`Resolución:       ${ladoLargo} px (lado largo)`);
console.log(`Preprocesamiento: ${preprocesar ? 'activado (contraste + nitidez)' : 'desactivado'}`);
console.log(`Prompt secciones: ${promptSecciones ? 'activado' : 'estándar'}`);
console.log(`Evaluador IA tex: ${evaluadorIa ? 'activado' : 'similitud local'}`);
console.log(`Carpeta muestra:  ${dirMuestra}`);
console.log(`Plantilla ref:    ${archivoPlantilla}`);
console.log(`Salida CSV:       ${rutaCsvSalida}`);
console.log('='.repeat(70));

if (!fs.existsSync(dirSalidaJson)) {
  fs.mkdirSync(dirSalidaJson, { recursive: true });
}

let normalizarModulo;
let escaneosUtil;
try {
  normalizarModulo = await import('../dist/ia-extractor/normalizacion.js');
  escaneosUtil = await import('../dist/escaneos/escaneos.util.js');
} catch {
  console.log('Compilando backend TypeScript...');
  execSync('npm run build', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
  normalizarModulo = await import('../dist/ia-extractor/normalizacion.js');
  escaneosUtil = await import('../dist/escaneos/escaneos.util.js');
}

const { compararCampo } = normalizarModulo;
const { esPDF, renderizarPaginasPDF, fusionarLecturas, optimizarParaIA } = escaneosUtil;

let camposFormulario;
try {
  const camposMod = await import('../dist/escaneos/campos-formulario.js');
  camposFormulario = camposMod.CAMPOS_FORMULARIO;
} catch {
  camposFormulario = [];
}

function parsearCsvRfc4180(texto) {
  const limpio = texto.replace(/^\uFEFF/, '');
  const filas = [];
  let filaActual = [];
  let campoActual = '';
  let enComillas = false;

  for (let i = 0; i < limpio.length; i++) {
    const ch = limpio[i];
    if (enComillas) {
      if (ch === '"') {
        if (limpio[i + 1] === '"') {
          campoActual += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campoActual += ch;
      }
    } else if (ch === '"') {
      enComillas = true;
    } else if (ch === ',') {
      filaActual.push(campoActual.trim());
      campoActual = '';
    } else if (ch === '\n') {
      filaActual.push(campoActual.replace(/\r$/, '').trim());
      if (filaActual.length > 1 || filaActual[0] !== '') {
        filas.push(filaActual);
      }
      filaActual = [];
      campoActual = '';
    } else {
      campoActual += ch;
    }
  }
  if (campoActual || filaActual.length > 0) {
    filaActual.push(campoActual.replace(/\r$/, '').trim());
    if (filaActual.length > 1 || filaActual[0] !== '') {
      filas.push(filaActual);
    }
  }
  return filas;
}

function cargarPlantillaReferencia(ruta) {
  const referencia = new Map();
  if (!fs.existsSync(ruta)) {
    console.warn(`Aviso: No se encontró plantilla en ${ruta}. Todo campo sin referencia se marcará "sin referencia".`);
    return referencia;
  }
  const contenido = fs.readFileSync(ruta, 'utf-8');
  const filas = parsearCsvRfc4180(contenido);
  if (filas.length <= 1) return referencia;

  const cabeceras = filas[0].map((c) => c.toLowerCase());
  for (let i = 1; i < filas.length; i++) {
    const valores = filas[i];
    const fila = {};
    cabeceras.forEach((c, idx) => {
      fila[c] = valores[idx];
    });
    const idReporte = fila.reporte || fila.numero_reporte || fila.id || `rep_${i}`;
    referencia.set(idReporte, fila);
  }
  return referencia;
}

async function evaluarTextoLargoSemantico(clave, esperado, leido) {
  if (!evaluadorIa || !process.env.GEMINI_API_KEY) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-3.8-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const prompt = `Compara técnicamente dos transcripciones del campo "${clave}" de un reporte de mantenimiento.
Esperado: "${esperado}"
Leído por OCR/IA: "${leido}"
¿Expresan el mismo hecho o procedimiento técnico sin contradicciones ni pérdida crítica? Responde JSON {"equivalente": true|false}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, response_mime_type: 'application/json' },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const txt = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(txt || '{}');
    return typeof parsed.equivalente === 'boolean' ? parsed.equivalente : null;
  } catch {
    return null;
  }
}

const factoryMod = await import('../dist/ia-extractor/ia-extractor.factory.js');
const { crearLectorDeReportes } = factoryMod;

const lector = crearLectorDeReportes({
  proveedor,
  modelo,
  temperatura,
  geminiConfig: { modelo, temperatura },
  openaiConfig: { modelo, temperatura },
  anthropicConfig: { modelo, temperatura },
});

const archivosMuestra = fs.existsSync(dirMuestra)
  ? fs.readdirSync(dirMuestra).filter((f) => /\.(pdf|jpe?g|png|webp)$/i.test(f))
  : [];

console.log(`Archivos encontrados en muestra: ${archivosMuestra.length}`);

const plantillaRef = cargarPlantillaReferencia(archivoPlantilla);
const filasCsv = [];
const cabeceraCsv = 'reporte,campo,valor esperado,valor leído,confianza,resultado,costo,tiempo';
filasCsv.push(cabeceraCsv);

function escaparCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

let costoTotalUsd = 0;
let tiempoTotalMs = 0;
let totalCamposConReferencia = 0;
let totalSinReferencia = 0;
let aciertos = 0;
let erroresAltaConfianza = 0;
const statsPorCampo = new Map();
const porcentajesCorreccionPorReporte = [];

for (let idx = 0; idx < archivosMuestra.length; idx++) {
  const archivo = archivosMuestra[idx];
  const nombreReporte = path.basename(archivo, path.extname(archivo));
  const rutaCompleta = path.join(dirMuestra, archivo);

  console.log(`\n[${idx + 1}/${archivosMuestra.length}] Procesando reporte: ${archivo}...`);
  const bufferOriginal = fs.readFileSync(rutaCompleta);

  const tInicio = Date.now();
  try {
    let buffersImagenes = [];
    if (esPDF(bufferOriginal)) {
      const paginasPng = await renderizarPaginasPDF(bufferOriginal, { dpi: 200 });
      for (const png of paginasPng) {
        const opt = await optimizarParaIA(png, {
          ladoLargo,
          normalizarContraste: preprocesar,
          nitidez: preprocesar,
        });
        buffersImagenes.push(opt.buffer);
      }
    } else {
      const opt = await optimizarParaIA(bufferOriginal, {
        ladoLargo,
        normalizarContraste: preprocesar,
        nitidez: preprocesar,
      });
      buffersImagenes.push(opt.buffer);
    }

    const lecturasPaginas = [];
    for (let p = 0; p < buffersImagenes.length; p++) {
      const resPagina = await lector.leer(buffersImagenes[p], 'image/jpeg', camposFormulario, temperatura);
      lecturasPaginas.push(resPagina);
    }

    const res = fusionarLecturas(lecturasPaginas);
    const tiempoMs = Date.now() - tInicio;
    tiempoTotalMs += tiempoMs;
    costoTotalUsd += res.uso.costoUsd;

    console.log(`N° Reporte: ${res.numeroReporte || 'S/N'} | Tokens: ${res.uso.tokensEntrada}+${res.uso.tokensSalida} | Costo: $${res.uso.costoUsd.toFixed(6)} | Tiempo: ${tiempoMs} ms`);

    const rutaJson = path.join(dirSalidaJson, `${nombreReporte}_${proveedor}_${ladoLargo}px${sufijoPre}.json`);
    fs.writeFileSync(rutaJson, JSON.stringify(res, null, 2), 'utf-8');

    const idRef = res.numeroReporte || nombreReporte;
    const ref = plantillaRef.get(idRef) || plantillaRef.get(nombreReporte) || null;
    let camposQueRequierenCorreccion = 0;

    for (const campo of res.campos) {
      if (campo.dudoso || campo.confianza === 'baja' || campo.noLeido) {
        camposQueRequierenCorreccion++;
      }

      const esperado = ref && ref[campo.clave] !== undefined ? ref[campo.clave] : undefined;
      const def = camposFormulario.find((c) => c.clave === campo.clave) || { tipo: 'texto' };
      const evaluacion = compararCampo(campo.clave, def.tipo, esperado, campo.valor, campo.noLeido);

      if (
        evaluacion.resultado === 'dudoso' &&
        ['procedimiento', 'conclusion', 'recomendaciones'].includes(campo.clave)
      ) {
        const eqIa = await evaluarTextoLargoSemantico(campo.clave, evaluacion.valorEsperado, evaluacion.valorLeido);
        if (eqIa === true) evaluacion.resultado = 'correcto';
        else if (eqIa === false) evaluacion.resultado = 'error';
      }

      if (evaluacion.resultado === 'sin referencia') {
        totalSinReferencia++;
      } else {
        totalCamposConReferencia++;
        const stat = statsPorCampo.get(campo.clave) || { total: 0, correctos: 0, erroresAltaConf: 0 };
        stat.total++;
        if (evaluacion.resultado === 'correcto' || evaluacion.resultado === 'vacío correcto') {
          aciertos++;
          stat.correctos++;
        } else if (evaluacion.resultado === 'error' && campo.confianza === 'alta') {
          erroresAltaConfianza++;
          stat.erroresAltaConf++;
        }
        statsPorCampo.set(campo.clave, stat);
      }

      filasCsv.push([
        escaparCsv(nombreReporte),
        escaparCsv(campo.clave),
        escaparCsv(evaluacion.valorEsperado),
        escaparCsv(evaluacion.valorLeido),
        escaparCsv(campo.confianza),
        escaparCsv(evaluacion.resultado),
        escaparCsv(res.uso.costoUsd.toFixed(6)),
        escaparCsv(tiempoMs),
      ].join(','));
    }

    if (res.campos.length > 0) {
      porcentajesCorreccionPorReporte.push((camposQueRequierenCorreccion / res.campos.length) * 100);
    }
  } catch (err) {
    console.error(`Error en reporte ${nombreReporte}: ${err.message}`);
    filasCsv.push([
      escaparCsv(nombreReporte),
      'ERROR_GLOBAL',
      '""',
      escaparCsv(err.message),
      'baja',
      'error',
      '0',
      Date.now() - tInicio,
    ].join(','));
  }
}

const BOM = '\uFEFF';
const csvCompleto = BOM + filasCsv.join('\r\n');
fs.writeFileSync(rutaCsvSalida, csvCompleto, 'utf-8');

const promedioCorreccion =
  porcentajesCorreccionPorReporte.length > 0
    ? porcentajesCorreccionPorReporte.reduce((a, b) => a + b, 0) / porcentajesCorreccionPorReporte.length
    : 0;

console.log('\n' + '='.repeat(70));
console.log('                 RESUMEN DE EVALUACIÓN Y EXPERIMENTO');
console.log('='.repeat(70));
console.log(`Configuración:               ${proveedor} / ${modelo} / ${ladoLargo}px / pre=${preprocesar}`);
console.log(`Reportes procesados:         ${archivosMuestra.length}`);
console.log(`Tiempo promedio:             ${archivosMuestra.length > 0 ? Math.round(tiempoTotalMs / archivosMuestra.length) : 0} ms / reporte`);
console.log(`Costo acumulado:             $${costoTotalUsd.toFixed(5)} USD`);
console.log(`% campos a revisión/reporte: ${promedioCorreccion.toFixed(1)}%`);
console.log(`Campos sin referencia:       ${totalSinReferencia}`);
if (totalCamposConReferencia > 0) {
  console.log(`Precisión global (con ref):  ${((aciertos / totalCamposConReferencia) * 100).toFixed(1)}%`);
  console.log(`Errores alta confianza:      ${erroresAltaConfianza} (${((erroresAltaConfianza / totalCamposConReferencia) * 100).toFixed(2)}%)`);
  console.log('\nPrecisión por campo:');
  for (const [clave, st] of statsPorCampo.entries()) {
    const pct = ((st.correctos / st.total) * 100).toFixed(1);
    console.log(`  - ${clave.padEnd(22)} ${pct}% (${st.correctos}/${st.total}) | errores alta conf: ${st.erroresAltaConf}`);
  }
}
console.log(`CSV exportado:               ${rutaCsvSalida}`);
console.log('='.repeat(70));
