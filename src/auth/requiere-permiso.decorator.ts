import { SetMetadata } from '@nestjs/common';
import type { Permiso } from './permisos';

export const CLAVE_PERMISO = 'sirep:permiso_requerido';

/** Marca una ruta (o un controlador) con el permiso que exige el AuthGuard. */
export const RequierePermiso = (permiso: Permiso) => SetMetadata(CLAVE_PERMISO, permiso);
