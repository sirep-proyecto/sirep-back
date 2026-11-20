import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { SupabaseService } from '../common/supabase.service';
import {
  esRolAdmin,
  limpiarPermisos,
  normalizarListaRoles,
  normalizarRol,
  permisosEfectivos,
  permisosPorDefectoDeRoles,
  TODOS_LOS_PERMISOS,
  type Permiso,
  type RolCanonico,
  type RolUsuario,
} from './permisos';

export interface UsuarioCuenta {
  id: string;
  usuario: string;
  nombre: string;
  rol: RolCanonico;
  roles: RolCanonico[];
  permisos: Permiso[];
  activo: boolean;
  creado_por: string | null;
  creado_en: string;
  ultimo_acceso: string | null;
}

interface FilaUsuario extends UsuarioCuenta {
  password_hash: string;
}

export interface DatosNuevoUsuario {
  usuario: string;
  nombre: string;
  password: string;
  rol: RolUsuario;
  roles?: RolUsuario[];
  permisos?: string[];
}

export interface CambiosUsuario {
  nombre?: string;
  password?: string;
  rol?: RolUsuario;
  roles?: RolUsuario[];
  permisos?: string[];
  activo?: boolean;
}

const COLUMNAS = 'id, usuario, nombre, rol, permisos, activo, creado_por, creado_en, ultimo_acceso';
const TTL_CACHE_MS = 10_000;
const MENSAJE_SIN_TABLA =
  'Falta aplicar la migración de usuarios (20261117000000_usuarios_roles_permisos.sql) en Supabase.';

export function hashearPassword(clave: string): string {
  const sal = randomBytes(16).toString('hex');
  const hash = scryptSync(clave, sal, 64).toString('hex');
  return `scrypt$${sal}$${hash}`;
}

export function verificarPassword(clave: string, guardado: string): boolean {
  const [esquema, sal, hash] = String(guardado ?? '').split('$');
  if (esquema !== 'scrypt' || !sal || !hash) return false;
  const esperado = Buffer.from(hash, 'hex');
  const calculado = scryptSync(clave, sal, esperado.length);
  return esperado.length === calculado.length && timingSafeEqual(esperado, calculado);
}

function mensajeDuplicado(error: { message?: string; details?: string }): string {
  const texto = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  return texto.includes('nombre')
    ? 'Ya existe una cuenta con ese nombre visible. Usa uno distinto para saber con claridad quién hizo cada revisión.'
    : 'Ya existe una cuenta con ese usuario.';
}

function rolLegacyDB(rol: RolCanonico): 'admin' | 'operador' | 'supervisor' {
  if (rol === 'administrador') return 'admin';
  if (rol === 'ingestor') return 'operador';
  return 'supervisor';
}

function esErrorColumnaRoles(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const texto = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
  return (
    texto.includes('roles') &&
    (texto.includes('pgrst204') ||
      texto.includes('42703') ||
      texto.includes('column') ||
      texto.includes('schema cache'))
  );
}

function esErrorRolCheck(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const texto = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
  return error.code === '23514' || texto.includes('usuarios_rol_check') || texto.includes('check constraint');
}

function esErrorUnSoloAdmin(
  error: { code?: string; message?: string; details?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const texto = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  return error.code === '23505' && texto.includes('un_solo_admin');
}

function tablaNoExiste(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const texto = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
  return (
    texto.includes('42p01') ||
    texto.includes('pgrst205') ||
    texto.includes('does not exist') ||
    texto.includes('could not find the table')
  );
}

@Injectable()
export class UsuariosService {
  private readonly logger = new Logger(UsuariosService.name);
  private readonly cache = new Map<string, { vence: number; valor: UsuarioCuenta | null }>();

  constructor(private readonly supabase: SupabaseService) {}

  private get db() {
    return this.supabase.getClient();
  }

  private normalizar(fila: any): UsuarioCuenta {
    const tieneGestionAdmin = Array.isArray(fila.permisos) && fila.permisos.includes('gestionar_usuarios');
    const rolCanon: RolCanonico =
      esRolAdmin(fila.rol, fila.roles) || tieneGestionAdmin ? 'administrador' : normalizarRol(fila.rol);
    const roles = normalizarListaRoles(rolCanon, fila.roles);
    const permisos = permisosEfectivos(rolCanon, fila.permisos, roles);
    // Si tiene permisos tanto de ingestor (subir_escaneos) como de revisor (editar_campos), refleja ambos roles.
    if (
      rolCanon !== 'administrador' &&
      permisos.includes('subir_escaneos') &&
      permisos.includes('editar_campos') &&
      roles.length === 1
    ) {
      if (!roles.includes('ingestor')) roles.push('ingestor');
      if (!roles.includes('revisor')) roles.push('revisor');
    }
    return {
      id: fila.id,
      usuario: fila.usuario,
      nombre: fila.nombre,
      rol: rolCanon,
      roles,
      permisos,
      activo: Boolean(fila.activo),
      creado_por: fila.creado_por ?? null,
      creado_en: fila.creado_en,
      ultimo_acceso: fila.ultimo_acceso ?? null,
    };
  }

  /**
   * Ejecuta inserciones o actualizaciones sobre public.usuarios tolerando si en Supabase aún
   * no se aplicó la migración 20261119000000 (columna `roles`, check ampliado y retiro de un_solo_admin).
   */
  private async escribirConFallbackEsquema(
    ejecutar: (datos: Record<string, unknown>) => Promise<{ data: any; error: any }>,
    payload: Record<string, unknown>,
    rolCanon: RolCanonico,
  ): Promise<{ data: any; error: any }> {
    let resultado = await ejecutar(payload);
    if (resultado.error && (esErrorColumnaRoles(resultado.error) || esErrorRolCheck(resultado.error))) {
      const { roles: _omitido, ...sinRoles } = payload;
      if (sinRoles.rol !== undefined || esErrorRolCheck(resultado.error)) {
        sinRoles.rol = rolLegacyDB(rolCanon);
      }
      resultado = await ejecutar(sinRoles);
    }
    if (resultado.error && esErrorUnSoloAdmin(resultado.error)) {
      const { roles: _omitido, ...compatAdmin } = payload;
      compatAdmin.rol = 'supervisor';
      compatAdmin.permisos = [...TODOS_LOS_PERMISOS];
      resultado = await ejecutar(compatAdmin);
    }
    return resultado;
  }

  async listar(): Promise<UsuarioCuenta[]> {
    const { data, error } = await this.db
      .from('usuarios')
      .select(COLUMNAS)
      .order('creado_en', { ascending: true });
    if (error) {
      if (tablaNoExiste(error)) throw new ServiceUnavailableException(MENSAJE_SIN_TABLA);
      throw new ServiceUnavailableException('No se pudo leer la lista de usuarios.');
    }
    return (data ?? []).map((f) => this.normalizar(f));
  }

  private async buscarPorId(id: string): Promise<UsuarioCuenta | null> {
    const { data, error } = await this.db.from('usuarios').select(COLUMNAS).eq('id', id).maybeSingle();
    if (error) {
      if (tablaNoExiste(error)) throw new ServiceUnavailableException(MENSAJE_SIN_TABLA);
      throw new ServiceUnavailableException('No se pudo leer el usuario.');
    }
    return data ? this.normalizar(data) : null;
  }

  /** Para validar cada petición con la cuenta al día; se guarda unos segundos para no consultar siempre. */
  async obtenerParaSesion(id: string): Promise<UsuarioCuenta | null> {
    const ahora = Date.now();
    const guardado = this.cache.get(id);
    if (guardado && guardado.vence > ahora) return guardado.valor;
    try {
      const valor = await this.buscarPorId(id);
      this.cache.set(id, { vence: ahora + TTL_CACHE_MS, valor });
      return valor;
    } catch (error) {
      // Si Supabase no responde un instante, se reutiliza lo último conocido en vez de sacar a todos.
      if (guardado) return guardado.valor;
      throw error;
    }
  }

  /** Devuelve la cuenta si usuario y contraseña coinciden. Sin tabla o sin cuenta: null. */
  async verificarCredenciales(identificador: string, password: string): Promise<UsuarioCuenta | null> {
    const id = identificador.trim().toLowerCase();
    const sinDominio = id.replace(/@sirep\.local$/, '');
    const { data, error } = await this.db
      .from('usuarios')
      .select(`${COLUMNAS}, password_hash`)
      .in('usuario', [...new Set([id, sinDominio])])
      .limit(1);

    if (error) {
      if (!tablaNoExiste(error)) this.logger.warn(`No se pudo consultar usuarios: ${error.message}`);
      return null;
    }
    const fila = (data ?? [])[0] as FilaUsuario | undefined;
    if (!fila || !verificarPassword(password, fila.password_hash)) return null;
    if (!fila.activo) {
      throw new UnauthorizedException('Tu cuenta está desactivada. Pide acceso a un administrador.');
    }

    void this.db
      .from('usuarios')
      .update({ ultimo_acceso: new Date().toISOString() })
      .eq('id', fila.id)
      .then(({ error: e }) => {
        if (e) this.logger.warn(`No se pudo guardar el último acceso: ${e.message}`);
      });
    return this.normalizar(fila);
  }

  async crear(datos: DatosNuevoUsuario, actor: string): Promise<UsuarioCuenta> {
    const rolCanon: RolCanonico = esRolAdmin(datos.rol, datos.roles)
      ? 'administrador'
      : normalizarRol(datos.rol);
    const rolesCanon = normalizarListaRoles(rolCanon, datos.roles);
    const usuario = datos.usuario.trim().toLowerCase();
    const permisos = esRolAdmin(rolCanon, rolesCanon)
      ? [...TODOS_LOS_PERMISOS]
      : datos.permisos
        ? limpiarPermisos(datos.permisos)
        : permisosPorDefectoDeRoles(rolesCanon);

    const payload: Record<string, unknown> = {
      usuario,
      nombre: datos.nombre.trim(),
      rol: rolCanon,
      roles: rolesCanon,
      permisos,
      password_hash: hashearPassword(datos.password),
      creado_por: actor,
    };

    const { data, error } = await this.escribirConFallbackEsquema(
      async (p) => this.db.from('usuarios').insert(p).select(COLUMNAS).single(),
      payload,
      rolCanon,
    );

    if (error) {
      if (tablaNoExiste(error)) throw new ServiceUnavailableException(MENSAJE_SIN_TABLA);
      if (error.code === '23505') throw new ConflictException(mensajeDuplicado(error));
      this.logger.error(`No se pudo crear la cuenta: ${error.message}`);
      throw new ServiceUnavailableException('No se pudo crear la cuenta.');
    }
    this.logger.log(`${actor} creó la cuenta "${usuario}" (${rolCanon}).`);
    return this.normalizar({ ...data, roles: rolesCanon });
  }

  async actualizar(id: string, cambios: CambiosUsuario, actorId: string, actor: string): Promise<UsuarioCuenta> {
    const actual = await this.buscarPorId(id);
    if (!actual) throw new NotFoundException('No existe esa cuenta.');

    // SIREP-S4-T01: Un usuario no puede cambiar su propio rol ni sus propios permisos.
    if (
      id === actorId &&
      (cambios.rol !== undefined ||
        cambios.roles !== undefined ||
        cambios.permisos !== undefined ||
        cambios.activo === false)
    ) {
      throw new BadRequestException('No puedes cambiar tu propio rol ni tus propios permisos.');
    }

    const nuevoRolBase = cambios.rol !== undefined ? normalizarRol(cambios.rol) : actual.rol;
    const nuevosRoles =
      cambios.roles !== undefined || cambios.rol !== undefined
        ? normalizarListaRoles(nuevoRolBase, cambios.roles)
        : actual.roles;
    const esAdmin = esRolAdmin(nuevoRolBase, nuevosRoles);
    const nuevoRol: RolCanonico = esAdmin ? 'administrador' : nuevoRolBase;

    const parche: Record<string, unknown> = { actualizado_en: new Date().toISOString() };
    if (cambios.nombre !== undefined) parche.nombre = cambios.nombre.trim();
    if (cambios.activo !== undefined) parche.activo = cambios.activo;
    if (cambios.rol !== undefined || cambios.roles !== undefined) {
      parche.rol = nuevoRol;
      parche.roles = nuevosRoles;
    }
    if (cambios.password) parche.password_hash = hashearPassword(cambios.password);

    if (esAdmin) {
      parche.permisos = [...TODOS_LOS_PERMISOS];
    } else if (cambios.permisos !== undefined) {
      parche.permisos = limpiarPermisos(cambios.permisos);
    } else if (cambios.rol !== undefined || cambios.roles !== undefined) {
      // Cambió de rol(es) sin elegir permisos manuales: une los permisos por defecto de sus roles.
      parche.permisos = permisosPorDefectoDeRoles(nuevosRoles);
    }

    const { data, error } = await this.escribirConFallbackEsquema(
      async (p) => this.db.from('usuarios').update(p).eq('id', id).select(COLUMNAS).single(),
      parche,
      nuevoRol,
    );
    if (error) {
      if (error.code === '23505') throw new ConflictException(mensajeDuplicado(error));
      this.logger.error(`No se pudo actualizar la cuenta ${id}: ${error.message}`);
      throw new ServiceUnavailableException('No se pudo guardar los cambios.');
    }
    this.cache.delete(id);
    this.logger.log(`${actor} actualizó la cuenta "${actual.usuario}".`);
    return this.normalizar({ ...data, roles: nuevosRoles });
  }

  async eliminar(id: string, actorId: string, actor: string): Promise<string> {
    const actual = await this.buscarPorId(id);
    if (!actual) throw new NotFoundException('No existe esa cuenta.');
    if (id === actorId) throw new BadRequestException('No puedes eliminar tu propia cuenta.');
    if (esRolAdmin(actual.rol, actual.roles)) {
      throw new BadRequestException('La cuenta de administrador no se puede eliminar.');
    }

    const { error } = await this.db.from('usuarios').delete().eq('id', id);
    if (error) {
      this.logger.error(`No se pudo eliminar la cuenta ${id}: ${error.message}`);
      throw new ServiceUnavailableException('No se pudo eliminar la cuenta.');
    }
    this.cache.delete(id);
    this.logger.log(`${actor} eliminó la cuenta "${actual.usuario}".`);
    return actual.usuario;
  }
}
