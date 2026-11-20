/**
 * Catálogo de roles y permisos de SIREP (SIREP-S4-T01 y T02).
 *
 * Roles oficiales del Sprint 4:
 * - administrador (Wilber Peralta): crea usuarios, asigna roles, ve tablero, libera reservas, exporta Excel, reintenta RP-TECH y lote.
 * - ingestor (David y Valentino): sube PDFs, ve el estado de lo que subió y reintenta errores. No corrige campos.
 * - revisor (Adriana, Fabián, Jean, Darwin): toma reportes de la cola, confirma o corrige campos y cierra la revisión.
 *
 * Una persona puede tener más de un rol (`roles: RolCanonico[]`).
 * Se aceptan los alias previos ('admin' -> 'administrador', 'operador' -> 'ingestor', 'supervisor' -> 'revisor')
 * para compatibilidad con datos y pruebas previas.
 */

export const ROLES = ['administrador', 'ingestor', 'revisor'] as const;
/** Roles asignables por el administrador a cuentas (una persona puede tener uno o varios). */
export const ROLES_ASIGNABLES = ['administrador', 'ingestor', 'revisor'] as const;
export const ROLES_CON_ALIAS = [
  'administrador',
  'ingestor',
  'revisor',
  'admin',
  'supervisor',
  'operador',
] as const;
export const ROLES_ASIGNABLES_CON_ALIAS = [
  'administrador',
  'ingestor',
  'revisor',
  'admin',
  'supervisor',
  'operador',
] as const;

export type RolCanonico = (typeof ROLES)[number];
export type RolUsuario = (typeof ROLES_CON_ALIAS)[number];

export interface DefinicionPermiso {
  id: string;
  etiqueta: string;
  descripcion: string;
  /** Solo el rol administrador puede tenerlo; no se concede a otros roles. */
  soloAdmin?: boolean;
}

export const CATALOGO_PERMISOS = [
  {
    id: 'ver_reportes',
    etiqueta: 'Ver reportes',
    descripcion: 'Abrir la bandeja, los reportes, sus escaneos y los PDF.',
  },
  {
    id: 'usar_cola',
    etiqueta: 'Usar cola de revisión',
    descripcion: 'Tomar el siguiente reporte pendiente de la cola con reserva.',
  },
  {
    id: 'editar_campos',
    etiqueta: 'Editar reportes',
    descripcion: 'Confirmar, corregir, omitir o reabrir campos y vincular clientes y equipos.',
  },
  {
    id: 'cerrar_reportes',
    etiqueta: 'Cerrar reportes',
    descripcion: 'Cerrar e importar los reportes ya revisados.',
  },
  {
    id: 'subir_escaneos',
    etiqueta: 'Subir reportes',
    descripcion: 'Subir escaneos nuevos desde la bandeja.',
  },
  {
    id: 'exportar',
    etiqueta: 'Exportar a Excel',
    descripcion: 'Descargar el Excel con todos los reportes.',
  },
  {
    id: 'configurar_bot',
    etiqueta: 'Configurar el bot de Telegram',
    descripcion: 'Conectar, desconectar o cambiar la dirección del bot.',
  },
  {
    id: 'gestionar_usuarios',
    etiqueta: 'Gestionar usuarios y accesos',
    descripcion: 'Crear cuentas, ver tablero de avance, liberar reservas y ejecutar paso en lote.',
    soloAdmin: true,
  },
] as const satisfies readonly DefinicionPermiso[];

export type Permiso = (typeof CATALOGO_PERMISOS)[number]['id'];

export const TODOS_LOS_PERMISOS: Permiso[] = CATALOGO_PERMISOS.map((p) => p.id);

const PERMISOS_ASIGNABLES: Permiso[] = CATALOGO_PERMISOS.filter(
  (p) => !('soloAdmin' in p && p.soloAdmin),
).map((p) => p.id);

/** Normaliza cualquier alias ('admin', 'supervisor', 'operador') al rol oficial del Sprint 4. */
export function normalizarRol(valor: unknown): RolCanonico {
  const v = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (v === 'administrador' || v === 'admin') return 'administrador';
  if (v === 'ingestor' || v === 'operador') return 'ingestor';
  return 'revisor';
}

export function esRolAdmin(rol: unknown, rolesExtra?: readonly unknown[]): boolean {
  if (normalizarRol(rol) === 'administrador') return true;
  if (Array.isArray(rolesExtra)) {
    return rolesExtra.some((r) => normalizarRol(r) === 'administrador');
  }
  return false;
}

export function normalizarListaRoles(rolPrincipal: unknown, listaRoles?: unknown): RolCanonico[] {
  const canonicoPrincipal = normalizarRol(rolPrincipal);
  const conjunto = new Set<RolCanonico>([canonicoPrincipal]);
  if (Array.isArray(listaRoles)) {
    for (const r of listaRoles) {
      if (esRol(r)) conjunto.add(normalizarRol(r));
    }
  }
  return ROLES.filter((r) => conjunto.has(r));
}

/** Permisos con los que nace una cuenta de cada rol (Sprint 4: SIREP-S4-T02). */
export const PERMISOS_POR_ROL: Record<RolUsuario, Permiso[]> = {
  administrador: [...TODOS_LOS_PERMISOS],
  ingestor: ['ver_reportes', 'subir_escaneos'],
  revisor: ['ver_reportes', 'usar_cola', 'editar_campos', 'cerrar_reportes'],
  // Alias de compatibilidad hacia atrás
  admin: [...TODOS_LOS_PERMISOS],
  supervisor: ['ver_reportes', 'usar_cola', 'editar_campos', 'cerrar_reportes'],
  operador: ['ver_reportes', 'subir_escaneos', 'exportar', 'configurar_bot'],
};

export const ETIQUETAS_ROL: Record<RolUsuario, string> = {
  administrador: 'Administrador',
  ingestor: 'Ingestor',
  revisor: 'Revisor',
  admin: 'Administrador',
  supervisor: 'Revisor',
  operador: 'Ingestor',
};

export function esRol(valor: unknown): valor is RolUsuario {
  return typeof valor === 'string' && (ROLES_CON_ALIAS as readonly string[]).includes(valor);
}

export function esPermiso(valor: unknown): valor is Permiso {
  return typeof valor === 'string' && (TODOS_LOS_PERMISOS as string[]).includes(valor);
}

/** Une los permisos por defecto de uno o varios roles asignados a la misma persona. */
export function permisosPorDefectoDeRoles(roles: readonly RolUsuario[]): Permiso[] {
  const unidos = new Set<Permiso>();
  for (const r of roles) {
    const canon = normalizarRol(r);
    for (const p of PERMISOS_POR_ROL[canon]) {
      if (canon === 'administrador' || p !== 'gestionar_usuarios') {
        unidos.add(p);
      }
    }
  }
  return TODOS_LOS_PERMISOS.filter((p) => unidos.has(p));
}

/** Deja solo permisos conocidos, sin repetir y sin los reservados al administrador. */
export function limpiarPermisos(lista: unknown): Permiso[] {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set<Permiso>();
  for (const item of lista) {
    if (esPermiso(item) && PERMISOS_ASIGNABLES.includes(item)) vistos.add(item);
  }
  return TODOS_LOS_PERMISOS.filter((p) => vistos.has(p));
}

/** Lo que de verdad puede hacer una cuenta: el administrador siempre todo; varios roles unen sus permisos si no hay lista explícita. */
export function permisosEfectivos(rol: string, permisos: unknown, rolesExtra?: readonly string[]): Permiso[] {
  if (esRolAdmin(rol, rolesExtra)) return [...TODOS_LOS_PERMISOS];
  const limpios = limpiarPermisos(permisos);
  if (limpios.length > 0 || (Array.isArray(permisos) && (!rolesExtra || rolesExtra.length <= 1))) {
    return limpios;
  }
  const listaRoles = normalizarListaRoles(rol, rolesExtra);
  return permisosPorDefectoDeRoles(listaRoles);
}
