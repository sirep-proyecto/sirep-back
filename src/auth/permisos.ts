/**
 * Catálogo de roles y permisos de SIREP.
 *
 * Un permiso es una acción concreta que una cuenta puede hacer. Cada rol trae un
 * conjunto por defecto, y el administrador puede ajustar los permisos cuenta por
 * cuenta desde Configuración > Usuarios y accesos.
 */

export const ROLES = ['admin', 'supervisor', 'operador'] as const;
/** Roles que el administrador puede asignar. Solo existe una cuenta admin (la crea la instalación). */
export const ROLES_ASIGNABLES = ['supervisor', 'operador'] as const;
export type RolUsuario = (typeof ROLES)[number];

export interface DefinicionPermiso {
  id: string;
  etiqueta: string;
  descripcion: string;
  /** Solo el rol admin puede tenerlo; no se concede a otros roles. */
  soloAdmin?: boolean;
}

export const CATALOGO_PERMISOS = [
  {
    id: 'ver_reportes',
    etiqueta: 'Ver reportes',
    descripcion: 'Abrir la bandeja, los reportes, sus escaneos y los PDF.',
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
    descripcion: 'Crear cuentas y controlar qué puede hacer cada una.',
    soloAdmin: true,
  },
] as const satisfies readonly DefinicionPermiso[];

export type Permiso = (typeof CATALOGO_PERMISOS)[number]['id'];

export const TODOS_LOS_PERMISOS: Permiso[] = CATALOGO_PERMISOS.map((p) => p.id);

const PERMISOS_ASIGNABLES: Permiso[] = CATALOGO_PERMISOS.filter(
  (p) => !('soloAdmin' in p && p.soloAdmin),
).map((p) => p.id);

/** Permisos con los que nace una cuenta de cada rol. */
export const PERMISOS_POR_ROL: Record<RolUsuario, Permiso[]> = {
  admin: [...TODOS_LOS_PERMISOS],
  supervisor: ['ver_reportes', 'editar_campos', 'cerrar_reportes', 'exportar'],
  operador: ['ver_reportes', 'subir_escaneos', 'exportar', 'configurar_bot'],
};

export const ETIQUETAS_ROL: Record<RolUsuario, string> = {
  admin: 'Administrador',
  supervisor: 'Supervisor',
  operador: 'Operador',
};

export function esRol(valor: unknown): valor is RolUsuario {
  return typeof valor === 'string' && (ROLES as readonly string[]).includes(valor);
}

export function esPermiso(valor: unknown): valor is Permiso {
  return typeof valor === 'string' && (TODOS_LOS_PERMISOS as string[]).includes(valor);
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

/** Lo que de verdad puede hacer una cuenta: el admin siempre todo. */
export function permisosEfectivos(rol: string, permisos: unknown): Permiso[] {
  if (rol === 'admin') return [...TODOS_LOS_PERMISOS];
  return limpiarPermisos(permisos);
}
