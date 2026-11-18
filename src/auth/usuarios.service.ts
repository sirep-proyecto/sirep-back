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
  limpiarPermisos,
  PERMISOS_POR_ROL,
  permisosEfectivos,
  type Permiso,
  type RolUsuario,
} from './permisos';

export interface UsuarioCuenta {
  id: string;
  usuario: string;
  nombre: string;
  rol: RolUsuario;
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
  permisos?: string[];
}

export interface CambiosUsuario {
  nombre?: string;
  password?: string;
  rol?: RolUsuario;
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
    return {
      id: fila.id,
      usuario: fila.usuario,
      nombre: fila.nombre,
      rol: fila.rol,
      permisos: permisosEfectivos(fila.rol, fila.permisos),
      activo: Boolean(fila.activo),
      creado_por: fila.creado_por ?? null,
      creado_en: fila.creado_en,
      ultimo_acceso: fila.ultimo_acceso ?? null,
    };
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

  /** Devuelve la cuenta si usuario y contraseña coinciden. Sin tabla o sin cuenta: null (el login sigue con otras vías). */
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
    if (datos.rol === 'admin') {
      throw new BadRequestException('Solo existe una cuenta de administrador y no se pueden crear más.');
    }
    const usuario = datos.usuario.trim().toLowerCase();
    const permisos = datos.permisos
      ? limpiarPermisos(datos.permisos)
      : [...PERMISOS_POR_ROL[datos.rol]].filter((p) => p !== 'gestionar_usuarios');

    const { data, error } = await this.db
      .from('usuarios')
      .insert({
        usuario,
        nombre: datos.nombre.trim(),
        rol: datos.rol,
        permisos,
        password_hash: hashearPassword(datos.password),
        creado_por: actor,
      })
      .select(COLUMNAS)
      .single();

    if (error) {
      if (tablaNoExiste(error)) throw new ServiceUnavailableException(MENSAJE_SIN_TABLA);
      if (error.code === '23505') throw new ConflictException(mensajeDuplicado(error));
      this.logger.error(`No se pudo crear la cuenta: ${error.message}`);
      throw new ServiceUnavailableException('No se pudo crear la cuenta.');
    }
    this.logger.log(`${actor} creó la cuenta "${usuario}" (${datos.rol}).`);
    return this.normalizar(data);
  }

  async actualizar(id: string, cambios: CambiosUsuario, actorId: string, actor: string): Promise<UsuarioCuenta> {
    const actual = await this.buscarPorId(id);
    if (!actual) throw new NotFoundException('No existe esa cuenta.');

    if (
      actual.rol === 'admin' &&
      (cambios.rol !== undefined || cambios.activo !== undefined || cambios.permisos !== undefined)
    ) {
      throw new BadRequestException(
        'La cuenta de administrador no puede cambiar de rol, desactivarse ni cambiar permisos. Solo su nombre y su contraseña.',
      );
    }
    const nuevoRol = cambios.rol ?? actual.rol;

    const parche: Record<string, unknown> = { actualizado_en: new Date().toISOString() };
    if (cambios.nombre !== undefined) parche.nombre = cambios.nombre.trim();
    if (cambios.activo !== undefined) parche.activo = cambios.activo;
    if (cambios.rol !== undefined) parche.rol = cambios.rol;
    if (cambios.password) parche.password_hash = hashearPassword(cambios.password);

    if (nuevoRol === 'admin') {
      // La cuenta admin conserva todos sus permisos.
    } else if (cambios.permisos !== undefined) {
      parche.permisos = limpiarPermisos(cambios.permisos);
    } else if (cambios.rol !== undefined && cambios.rol !== actual.rol) {
      // Cambió de rol sin elegir permisos: arranca con los del rol nuevo.
      parche.permisos = [...PERMISOS_POR_ROL[nuevoRol]].filter((p) => p !== 'gestionar_usuarios');
    }

    const { data, error } = await this.db.from('usuarios').update(parche).eq('id', id).select(COLUMNAS).single();
    if (error) {
      if (error.code === '23505') throw new ConflictException(mensajeDuplicado(error));
      this.logger.error(`No se pudo actualizar la cuenta ${id}: ${error.message}`);
      throw new ServiceUnavailableException('No se pudo guardar los cambios.');
    }
    this.cache.delete(id);
    this.logger.log(`${actor} actualizó la cuenta "${actual.usuario}".`);
    return this.normalizar(data);
  }

  async eliminar(id: string, actorId: string, actor: string): Promise<string> {
    const actual = await this.buscarPorId(id);
    if (!actual) throw new NotFoundException('No existe esa cuenta.');
    if (id === actorId) throw new BadRequestException('No puedes eliminar tu propia cuenta.');
    if (actual.rol === 'admin') {
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
