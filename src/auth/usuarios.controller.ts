import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ActividadService } from './actividad.service';
import { AuthGuard } from './auth.guard';
import { CATALOGO_PERMISOS, ETIQUETAS_ROL, PERMISOS_POR_ROL, ROLES, ROLES_ASIGNABLES, type RolUsuario } from './permisos';
import { RequierePermiso } from './requiere-permiso.decorator';
import { UsuariosService } from './usuarios.service';

export class CrearUsuarioDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9._@-]{3,60}$/, {
    message: 'El usuario debe tener de 3 a 60 caracteres: letras, números, punto, guion, guion bajo o @.',
  })
  usuario!: string;

  @IsString()
  @MinLength(2, { message: 'El nombre es muy corto.' })
  @MaxLength(80)
  nombre!: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  @MaxLength(100)
  password!: string;

  @IsIn([...ROLES_ASIGNABLES], { message: 'El rol debe ser supervisor u operador.' })
  rol!: RolUsuario;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permisos?: string[];
}

export class ActualizarUsuarioDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre es muy corto.' })
  @MaxLength(80)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  @MaxLength(100)
  password?: string;

  @IsOptional()
  @IsIn([...ROLES_ASIGNABLES], { message: 'El rol debe ser supervisor u operador.' })
  rol?: RolUsuario;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permisos?: string[];

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

const actorDe = (req: any) => req?.usuario?.nombre || req?.usuario?.email || 'desconocido';

@ApiTags('usuarios')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@RequierePermiso('gestionar_usuarios')
@Controller('usuarios')
export class UsuariosController {
  constructor(
    private readonly usuarios: UsuariosService,
    private readonly actividad: ActividadService,
  ) {}

  /** Cuentas de la app y catálogo de roles y permisos. */
  @Get()
  async listar() {
    const cuentas = await this.usuarios.listar();
    return {
      cuentas,
      catalogo: {
        permisos: CATALOGO_PERMISOS,
        roles: ROLES.map((id) => ({
          id,
          etiqueta: ETIQUETAS_ROL[id],
          permisos_por_defecto: PERMISOS_POR_ROL[id],
        })),
      },
    };
  }

  /** Bitácora: qué hizo cada cuenta (revisar, cerrar, subir, exportar, cambiar accesos…). */
  @Get('actividad')
  actividadDeCuentas(
    @Query('limite') limite?: string,
    @Query('usuario_id') usuarioId?: string,
    @Query('accion') accion?: string,
  ) {
    return this.actividad.listar({ limite: Number(limite) || undefined, usuarioId, accion });
  }

  @Post()
  async crear(@Body() body: CrearUsuarioDto, @Req() req: any) {
    const creada = await this.usuarios.crear(body, actorDe(req));
    this.actividad.registrar(req?.usuario, 'cuenta_creada', { usuario: creada.usuario, rol: creada.rol });
    return creada;
  }

  @Patch(':id')
  async actualizar(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: ActualizarUsuarioDto, @Req() req: any) {
    const cuenta = await this.usuarios.actualizar(id, body, String(req?.usuario?.id ?? ''), actorDe(req));
    const { password, ...resto } = body;
    this.actividad.registrar(req?.usuario, 'cuenta_actualizada', {
      usuario: cuenta.usuario,
      cambios: Object.keys(resto),
      contrasena_cambiada: Boolean(password),
    });
    return cuenta;
  }

  @Delete(':id')
  @HttpCode(204)
  async eliminar(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: any) {
    const usuario = await this.usuarios.eliminar(id, String(req?.usuario?.id ?? ''), actorDe(req));
    this.actividad.registrar(req?.usuario, 'cuenta_eliminada', { usuario });
  }
}
