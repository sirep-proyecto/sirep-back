#!/usr/bin/env node
/**
 * Envía en lote a RP-TECH los reportes históricos ya revisados en SIREP
 * (sin campos pendientes) que aún no están allá. Contrato: docs/contrato-historico.md.
 *
 * Antes este script marcaba `aprobado_rptech` sin enviar nada a RP-TECH. Ahora el
 * reporte solo queda como importado cuando RP-TECH confirma que lo guardó
 * (201 creado o 200 ya_existia). Reenviar es seguro: RP-TECH no duplica el mismo sirep_id.
 *
 * Uso:
 *   node --env-file=.env scripts/migrar-revisados-rptech.mjs [--dry-run]
 *   (o npm run db:migrar-revisados)
 *
 * Necesita SUPABASE_URL, SUPABASE_KEY, RPTECH_URL y RPTECH_CLAVE.
 * --dry-run: arma cada envío y muestra cuántos irían, sin enviar ni cambiar nada.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(__dirname, '..');
const envPath = path.join(raiz, '.env');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.includes('=')) {
      const idx = t.indexOf('=');
      const key = t.slice(0, idx).trim();
      if (!process.env[key]) process.env[key] = t.slice(idx + 1).trim();
    }
  }
}

const dryRun = process.argv.includes('--dry-run');
const EMPRESA_POR_DEFECTO = '00000000-0000-0000-0000-000000000000';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_KEY en .env');
  process.exit(1);
}

// Usa el mismo código que la API (compilado en dist) para no tener dos versiones del envío.
const modulo = (rel) => import(pathToFileURL(path.join(raiz, rel)).href);
let mapper, cliente, envio;
const cargar = async () => {
  mapper = await modulo('dist/reportes/reportes.mapper.js');
  cliente = await modulo('dist/rptech/rptech.cliente.js');
  envio = await modulo('dist/rptech/rptech.envio.js');
};
try {
  await cargar();
} catch {
  execSync('npm run build', { stdio: 'inherit', cwd: raiz });
  await cargar();
}

const cfg = cliente.configDesdeEntorno(process.env);
if (!cfg && !dryRun) {
  console.error('Faltan RPTECH_URL o RPTECH_CLAVE en .env: no se envía nada.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });

const { data: filas, error } = await supabase
  .from('reportes')
  .select('*, escaneo:escaneos(id, ruta_original, paginas, enviado_por, estado, creado_en)')
  .eq('empresa_id', EMPRESA_POR_DEFECTO)
  .eq('origen', 'historico')
  .order('creado_en', { ascending: true })
  .limit(5000);

if (error) {
  console.error(`Error consultando reportes: ${error.message}`);
  process.exit(1);
}

const cuenta = { listos: 0, yaEnRptech: 0, pendientes: 0, creados: 0, yaExistian: 0, observados: [], reintentar: [] };

for (const fila of filas ?? []) {
  const numero = mapper.numeroVisible(fila);
  const tienePendientes = mapper.construirCampos(fila.campos_extraidos).some((c) => c.estado_revision === 'pendiente');
  if (tienePendientes) {
    cuenta.pendientes++;
    continue;
  }
  if (!cliente.listoParaEnviar(fila, false)) {
    cuenta.yaEnRptech++;
    continue;
  }
  cuenta.listos++;

  if (dryRun) {
    const prueba = envio.construirEnvio(fila, { tipo: 'application/pdf', sha256: '0'.repeat(64), paginas: 1, contenido_base64: '' });
    const sinFormato = Object.keys(prueba.datos_originales);
    console.log(`[DRY-RUN] N° ${numero} se enviaría.${sinFormato.length ? ` Sin formato (van en datos_originales): ${sinFormato.join(', ')}` : ''}`);
    continue;
  }

  const r = await cliente.enviarReporte(supabase, fila, cfg);
  if (r.estado === 'clave_invalida') {
    console.error('RP-TECH rechazó la clave (401). Revisa RPTECH_CLAVE. Se detiene el lote.');
    process.exit(1);
  }
  if (r.estado === 'importado') {
    if (r.yaExistia) cuenta.yaExistian++;
    else cuenta.creados++;
    console.log(`N° ${numero}: ${r.yaExistia ? 'ya estaba' : 'guardado'} en RP-TECH (${r.rptechId}).`);
  } else if (r.estado === 'observado') {
    cuenta.observados.push(numero);
    console.warn(`N° ${numero}: RP-TECH no lo aceptó (${r.codigo}): ${JSON.stringify(r.detalle)}`);
  } else {
    cuenta.reintentar.push(numero);
    console.warn(`N° ${numero}: sin respuesta, se reintenta en la próxima ejecución. ${r.detalle}`);
  }
}

console.log('='.repeat(60));
console.log(`Modo: ${dryRun ? 'SIMULACIÓN (--dry-run)' : 'ENVÍO A RP-TECH'}`);
console.log(`Históricos en SIREP:              ${(filas ?? []).length}`);
console.log(`Con campos pendientes (no van):   ${cuenta.pendientes}`);
console.log(`Ya en RP-TECH antes:              ${cuenta.yaEnRptech}`);
console.log(`Listos para enviar:               ${cuenta.listos}`);
if (!dryRun) {
  console.log(`Guardados ahora en RP-TECH:       ${cuenta.creados}`);
  console.log(`Ya existían en RP-TECH:           ${cuenta.yaExistian}`);
  console.log(`Observados (corregir en bandeja): ${cuenta.observados.length} ${cuenta.observados.join(', ')}`);
  console.log(`Por reintentar:                   ${cuenta.reintentar.length} ${cuenta.reintentar.join(', ')}`);
}
console.log('='.repeat(60));
