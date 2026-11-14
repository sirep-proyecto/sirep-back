#!/usr/bin/env node
/**
 * SIREP-S3-T18: Genera las métricas diarias por campo en `metricas/AAAA-MM-DD.csv`
 * con las columnas exactas:
 *   campo,total,confirmados,corregidos,ilegibles,confianza_declarada
 * Garantizando cero datos de clientes en el archivo generado.
 *
 * Uso:
 *   node --env-file=.env scripts/generar-metricas-diarias.mjs [--fecha=AAAA-MM-DD]
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

const fechaArg = process.argv.find((a) => a.startsWith('--fecha='))?.slice('--fecha='.length);
const fechaHoy = fechaArg || new Date().toISOString().slice(0, 10);
const EMPRESA_POR_DEFECTO = '00000000-0000-0000-0000-000000000000';

let camposMod;
let mapperMod;
try {
  camposMod = await import('../dist/escaneos/campos-formulario.js');
  mapperMod = await import('../dist/reportes/reportes.mapper.js');
} catch {
  execSync('npm run build', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
  camposMod = await import('../dist/escaneos/campos-formulario.js');
  mapperMod = await import('../dist/reportes/reportes.mapper.js');
}

const { IDS_CAMPOS_FORMULARIO } = camposMod;
const { construirCampos } = mapperMod;

const contadores = new Map();
for (const id of IDS_CAMPOS_FORMULARIO) {
  contadores.set(id, { total: 0, confirmados: 0, corregidos: 0, ilegibles: 0, alta: 0, media: 0, baja: 0 });
}

let filasLeidas = 0;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (supabaseUrl && supabaseKey && !supabaseUrl.includes('example')) {
  try {
    const client = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    const { data, error } = await client
      .from('reportes')
      .select('campos_extraidos')
      .eq('empresa_id', EMPRESA_POR_DEFECTO)
      .limit(5000);

    if (!error && Array.isArray(data)) {
      filasLeidas = data.length;
      for (const fila of data) {
        const campos = construirCampos(fila?.campos_extraidos);
        for (const c of campos) {
          const entry = contadores.get(c.id);
          if (!entry) continue;
          entry.total++;
          if (c.estado_revision === 'confirmado' || c.estado_revision === 'auto') {
            entry.confirmados++;
          } else if (c.estado_revision === 'corregido') {
            entry.corregidos++;
          } else if (c.estado_revision === 'ilegible' || c.no_leido) {
            entry.ilegibles++;
          }
          if (c.confianza === 'alta') entry.alta++;
          else if (c.confianza === 'media') entry.media++;
          else if (c.confianza === 'baja') entry.baja++;
        }
      }
    } else if (error) {
      console.warn(`Aviso consultando Supabase (${error.message}). Se genera archivo base en 0.`);
    }
  } catch (err) {
    console.warn(`Aviso conectando a Supabase (${err.message}). Se genera archivo base en 0.`);
  }
} else {
  console.warn('Sin credenciales activas de Supabase en entorno. Generando plantilla de métricas en 0.');
}

const dirMetricas = path.resolve(__dirname, '../metricas');
if (!fs.existsSync(dirMetricas)) {
  fs.mkdirSync(dirMetricas, { recursive: true });
}

const lineas = ['campo,total,confirmados,corregidos,ilegibles,confianza_declarada'];
for (const campo of IDS_CAMPOS_FORMULARIO) {
  const c = contadores.get(campo);
  const conf = `alta:${c.alta}|media:${c.media}|baja:${c.baja}`;
  lineas.push(`${campo},${c.total},${c.confirmados},${c.corregidos},${c.ilegibles},${conf}`);
}

const rutaSalida = path.join(dirMetricas, `${fechaHoy}.csv`);
fs.writeFileSync(rutaSalida, `${lineas.join('\n')}\n`, 'utf-8');
console.log(`Métricas diarias generadas (${filasLeidas} reportes agregados, 0 datos de clientes): ${rutaSalida}`);
