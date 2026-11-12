#!/usr/bin/env node
/**
 * SIREP-S3-T06: Script de copia de seguridad diaria de la base de datos de SIREP.
 * Exporta un respaldo JSON/SQL fechado (`backups/sirep_backup_AAAA-MM-DD.json`) de las tablas
 * `escaneos`, `reportes` y `dataset_clientes` usando las credenciales de Supabase configuradas en `.env`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';

async function ejecutarBackup() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!url || !key) {
    console.error('Error: Faltan SUPABASE_URL o SUPABASE_KEY en el entorno (.env).');
    process.exit(1);
  }

  const supabase = createClient(url, key);
  const fechaHoy = new Date().toISOString().slice(0, 10);
  const carpetaBackups = path.resolve(process.cwd(), process.env.BACKUP_DIR || 'backups');
  fs.mkdirSync(carpetaBackups, { recursive: true });

  const tablas = ['escaneos', 'reportes', 'dataset_clientes'];
  const respaldo = {
    proyecto: 'SIREP',
    fecha_backup: new Date().toISOString(),
    tablas: {},
  };

  for (const tabla of tablas) {
    const { data, error } = await supabase.from(tabla).select('*');
    if (error) {
      // Si una tabla opcional aún no existe, se registra advertencia sin abortar las demás
      console.warn(`Aviso al respaldar tabla "${tabla}": ${error.message}`);
      respaldo.tablas[tabla] = [];
    } else {
      respaldo.tablas[tabla] = data ?? [];
      console.log(`Tabla "${tabla}": ${(data ?? []).length} registros respaldados.`);
    }
  }

  const rutaArchivo = path.join(carpetaBackups, `sirep_backup_${fechaHoy}.json`);
  fs.writeFileSync(rutaArchivo, JSON.stringify(respaldo, null, 2), 'utf-8');
  console.log(`Copia de seguridad diaria guardada en: ${rutaArchivo}`);
}

ejecutarBackup().catch((err) => {
  console.error('Fallo al generar copia de seguridad diaria:', err?.message ?? err);
  process.exit(1);
});
