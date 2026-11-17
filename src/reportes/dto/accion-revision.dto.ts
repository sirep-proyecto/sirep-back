import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const TIPOS_ACCION = ['confirmar', 'corregir', 'ilegible', 'omitir', 'reabrir'] as const;
export type TipoAccion = (typeof TIPOS_ACCION)[number];

export class AccionRevisionDto {
  @IsIn(TIPOS_ACCION)
  tipo!: TipoAccion;

  /**
   * Quién firma la revisión. En producción se toma del usuario autenticado (SIREP-S3-T04);
   * se mantiene opcional en el cuerpo por compatibilidad con llamadas internas/pruebas.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  actor?: string;

  /** Obligatorio solo al corregir. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  valor?: string;
}
