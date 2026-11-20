#!/usr/bin/env node
/**
 * SIREP-S4-T04: Crea o sincroniza en Supabase las 7 cuentas reales del equipo:
 * - Wilber Peralta (administrador)
 * - David (ingestor)
 * - Valentino (ingestor)
 * - Adriana (revisor)
 * - Fabián (revisor)
 * - Jean (revisor)
 * - Darwin (revisor)
 *
 * Uso:
 *   node --env-file=.env scripts/seed-usuarios-s4.mjs
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function hashearPassword(clave) {
  const sal = randomBytes(16).toString('hex');
  const hash = scryptSync(clave, sal, 64).toString('hex');
  return `scrypt$${sal}$${hash}`;
}

export const USUARIOS_REALES_S4 = [
  {
    usuario: 'wilber',
    nombre: 'Wilber Peralta',
    rol: 'administrador',
    roles: ['administrador'],
    permisos: [
      'ver_reportes',
      'usar_cola',
      'editar_campos',
      'cerrar_reportes',
      'subir_escaneos',
      'exportar',
      'configurar_bot',
      'gestionar_usuarios',
    ],
    passwordInicial: process.env.SEED_PASS_WILBER || 'Wilber2026!',
  },
  {
    usuario: 'david',
    nombre: 'David',
    rol: 'ingestor',
    roles: ['ingestor'],
    permisos: ['ver_reportes', 'subir_escaneos'],
    passwordInicial: process.env.SEED_PASS_DAVID || 'David2026!',
  },
  {
    usuario: 'valentino',
    nombre: 'Valentino',
    rol: 'ingestor',
    roles: ['ingestor'],
    permisos: ['ver_reportes', 'subir_escaneos'],
    passwordInicial: process.env.SEED_PASS_VALENTINO || 'Valentino2026!',
  },
  {
    usuario: 'adriana',
    nombre: 'Adriana',
    rol: 'revisor',
    roles: ['revisor'],
    permisos: ['ver_reportes', 'usar_cola', 'editar_campos', 'cerrar_reportes'],
    passwordInicial: process.env.SEED_PASS_ADRIANA || 'Adriana2026!',
  },
  {
    usuario: 'fabian',
    nombre: 'Fabián',
    rol: 'revisor',
    roles: ['revisor'],
    permisos: ['ver_reportes', 'usar_cola', 'editar_campos', 'cerrar_reportes'],
    passwordInicial: process.env.SEED_PASS_FABIAN || 'Fabian2026!',
  },
  {
    usuario: 'jean',
    nombre: 'Jean',
    rol: 'revisor',
    roles: ['revisor'],
    permisos: ['ver_reportes', 'usar_cola', 'editar_campos', 'cerrar_reportes'],
    passwordInicial: process.env.SEED_PASS_JEAN || 'Jean2026!',
  },
  {
    usuario: 'darwin',
    nombre: 'Darwin',
    rol: 'revisor',
    roles: ['revisor'],
    permisos: ['ver_reportes', 'usar_cola', 'editar_campos', 'cerrar_reportes'],
    passwordInicial: process.env.SEED_PASS_DARWIN || 'Darwin2026!',
  },
];

function rolLegacyDB(rol) {
  if (rol === 'administrador') return 'admin';
  if (rol === 'ingestor') return 'operador';
  return 'supervisor';
}

function textoError(error) {
  return `${error?.code ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`.toLowerCase();
}

function esErrorEsquemaLegacy(error) {
  const t = textoError(error);
  return (
    (t.includes('roles') && (t.includes('pgrst204') || t.includes('42703') || t.includes('column') || t.includes('schema cache'))) ||
    error?.code === '23514' ||
    t.includes('usuarios_rol_check')
  );
}

function esErrorUnSoloAdmin(error) {
  const t = textoError(error);
  return error?.code === '23505' && t.includes('un_solo_admin');
}

async function escribirConFallback(ejecutar, payload, rolCanon, todosPermisosAdmin) {
  let res = await ejecutar(payload);
  if (res.error && esErrorEsquemaLegacy(res.error)) {
    const { roles: _omitido, ...sinRoles } = payload;
    sinRoles.rol = rolLegacyDB(rolCanon);
    res = await ejecutar(sinRoles);
  }
  if (res.error && esErrorUnSoloAdmin(res.error)) {
    const { roles: _omitido, ...compatAdmin } = payload;
    compatAdmin.rol = 'supervisor';
    compatAdmin.permisos = todosPermisosAdmin;
    res = await ejecutar(compatAdmin);
  }
  return res;
}

const TODOS_PERMISOS_ADMIN = [
  'ver_reportes',
  'usar_cola',
  'editar_campos',
  'cerrar_reportes',
  'subir_escaneos',
  'exportar',
  'configurar_bot',
  'gestionar_usuarios',
];

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.error('Faltan SUPABASE_URL o SUPABASE_KEY en el entorno (.env).');
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const filtroOficiales = `(${USUARIOS_REALES_S4.map((c) => `"${c.usuario}"`).join(',')})`;
  const { data: eliminados, error: errorEliminar } = await supabase
    .from('usuarios')
    .delete()
    .not('usuario', 'in', filtroOficiales)
    .select('usuario');

  if (errorEliminar) {
    console.error(`Error eliminando cuentas antiguas: ${errorEliminar.message}`);
    process.exit(1);
  }
  if (eliminados && eliminados.length > 0) {
    console.log(`Eliminados fuera de los 7 oficiales: ${eliminados.map((u) => u.usuario).join(', ')}`);
  }

  for (const cuenta of USUARIOS_REALES_S4) {
    const { data: existente } = await supabase
      .from('usuarios')
      .select('id, usuario')
      .eq('usuario', cuenta.usuario)
      .maybeSingle();

    if (existente?.id) {
      const { error } = await escribirConFallback(
        (p) => supabase.from('usuarios').update(p).eq('id', existente.id),
        {
          nombre: cuenta.nombre,
          rol: cuenta.rol,
          roles: cuenta.roles,
          permisos: cuenta.permisos,
          activo: true,
          actualizado_en: new Date().toISOString(),
        },
        cuenta.rol,
        TODOS_PERMISOS_ADMIN,
      );

      if (error) {
        console.error(`Error actualizando ${cuenta.usuario}: ${error.message}`);
      } else {
        console.log(`Actualizado: ${cuenta.usuario} (${cuenta.nombre}) -> rol: ${cuenta.rol}`);
      }
    } else {
      const payloadCrear = {
        usuario: cuenta.usuario,
        nombre: cuenta.nombre,
        rol: cuenta.rol,
        roles: cuenta.roles,
        permisos: cuenta.permisos,
        password_hash: hashearPassword(cuenta.passwordInicial),
        activo: true,
        creado_por: 'sprint4-seed',
      };

      const { error } = await escribirConFallback(
        (p) => supabase.from('usuarios').insert(p),
        payloadCrear,
        cuenta.rol,
        TODOS_PERMISOS_ADMIN,
      );

      if (error) {
        console.error(`Error creando ${cuenta.usuario}: ${error.message}`);
      } else {
        console.log(`Creado: ${cuenta.usuario} (${cuenta.nombre}) -> rol: ${cuenta.rol}`);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fallo en seed de usuarios S4:', err?.message ?? err);
    process.exit(1);
  });
}
