#!/usr/bin/env node
/**
 * SIREP-S3-T13: Script para pasar en lote los reportes ya revisados en SIREP
 * a estado cerrado/importado (bloqueado = true, estado_reporte = 'aprobado_rptech')
 * de forma idempotente, sin volver a escanear ni invocar modelos de IA.
 *
 * Uso:
 *   node --env-file=.env scripts/migrar-revisados-rptech.mjs [--dry-run]
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.includes('=')) {
      const idx = t.indexOf('=');
      const key = t.slice(0, idx).trim();
      const val = t.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const dryRun = process.argv.includes('--dry-run');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const EMPRESA_POR_DEFECTO = '00000000-0000-0000-0000-000000000000';

if (!supabaseUrl || !supabaseKey) {
  console.error('Faltan SUPABASE_URL o SUPABASE_KEY en las variables de entorno.');
  process.exit(1);
}

let mapperMod;
let normMod;
try {
  mapperMod = await import('../dist/reportes/reportes.mapper.js');
  normMod = await import('../dist/ia-extractor/normalizacion.js');
} catch {
  execSync('npm run build', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
  mapperMod = await import('../dist/reportes/reportes.mapper.js');
  normMod = await import('../dist/ia-extractor/normalizacion.js');
}

const { construirCampos, numeroVisible } = mapperMod;
const { similitudTexto } = normMod;

const client = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function cargarCatalogo(tabla) {
  try {
    const { data, error } = await client
      .from(tabla)
      .select('id, nombre')
      .eq('empresa_id', EMPRESA_POR_DEFECTO)
      .limit(1000);
    if (error || !Array.isArray(data)) return [];
    return data.filter((r) => r?.id && r?.nombre);
  } catch {
    return [];
  }
}

function buscarVinculoOptimo(texto, catalogo) {
  const limpio = (texto || '').trim();
  if (!limpio || catalogo.length === 0) return null;
  let mejor = null;
  let mejorScore = 0;
  for (const item of catalogo) {
    const s = similitudTexto(limpio, item.nombre);
    if (s >= 0.85 && s > mejorScore) {
      mejorScore = s;
      mejor = item.id;
    }
  }
  return mejor;
}

const [clientesCat, equiposCat, perfilesCat] = await Promise.all([
  cargarCatalogo('clientes'),
  cargarCatalogo('equipos'),
  cargarCatalogo('perfiles'),
]);

const { data: filas, error } = await client
  .from('reportes')
  .select('id, escaneo_id, numero_talonario, origen, estado_reporte, bloqueado, cliente, serie_equipo, tecnico_asignado, cliente_id, equipo_id, tecnico_perfil_id, campos_extraidos, datos_originales, corregido_por, fecha_correccion')
  .eq('empresa_id', EMPRESA_POR_DEFECTO)
  .eq('origen', 'historico')
  .order('creado_en', { ascending: true })
  .limit(5000);

if (error) {
  console.error(`Error consultando reportes: ${error.message}`);
  process.exit(1);
}

let listos = 0;
let yaCerrados = 0;
let migrados = 0;
let omitidosPendientes = 0;

for (const fila of filas || []) {
  const campos = construirCampos(fila.campos_extraidos);
  const pendientes = campos.filter((c) => c.estado_revision === 'pendiente');
  if (pendientes.length > 0) {
    omitidosPendientes++;
    continue;
  }

  listos++;
  if (fila.bloqueado || fila.estado_reporte === 'aprobado_rptech' || fila.estado_reporte === 'cerrado') {
    yaCerrados++;
    continue;
  }

  const numero = numeroVisible(fila);
  const ahora = new Date().toISOString();
  const payload = {
    estado_reporte: 'aprobado_rptech',
    bloqueado: true,
    importado_en: ahora,
    datos_originales:
      fila.datos_originales && Object.keys(fila.datos_originales).length > 0
        ? fila.datos_originales
        : (fila.campos_extraidos ?? {}),
    corregido_por: fila.corregido_por || 'migracion-lote',
    fecha_correccion: fila.fecha_correccion || ahora,
  };

  if (!fila.cliente_id) {
    const cid = buscarVinculoOptimo(fila.cliente, clientesCat);
    if (cid) payload.cliente_id = cid;
  }
  if (!fila.equipo_id) {
    const eid = buscarVinculoOptimo(fila.serie_equipo, equiposCat);
    if (eid) payload.equipo_id = eid;
  }
  if (!fila.tecnico_perfil_id) {
    const tid = buscarVinculoOptimo(fila.tecnico_asignado, perfilesCat);
    if (tid) payload.tecnico_perfil_id = tid;
  }

  if (dryRun) {
    console.log(`[DRY-RUN] Reporte N° ${numero} listo para cierre e importación idempotente.`);
    migrados++;
    continue;
  }

  const { error: errUpd } = await client.from('reportes').update(payload).eq('id', fila.id);
  if (errUpd) {
    console.error(`Error actualizando reporte N° ${numero}: ${errUpd.message}`);
    continue;
  }

  if (fila.escaneo_id) {
    await client.from('escaneos').update({ estado: 'completo' }).eq('id', fila.escaneo_id);
  }

  console.log(`Reporte N° ${numero} cerrado e importado correctamente.`);
  migrados++;
}

console.log('='.repeat(60));
console.log(`Modo: ${dryRun ? 'SIMULACION (--dry-run)' : 'PRODUCCION'}`);
console.log(`Total reportes históricos en BD: ${(filas || []).length}`);
console.log(`Listos sin campos pendientes:    ${listos}`);
console.log(`Ya cerrados previamente:         ${yaCerrados}`);
console.log(`Cerrados/migrados en esta ejecución: ${migrados}`);
console.log(`Omitidos por tener pendientes:   ${omitidosPendientes}`);
console.log('='.repeat(60));
