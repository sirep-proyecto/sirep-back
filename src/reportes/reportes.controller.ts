import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AccionRevisionDto } from './dto/accion-revision.dto';
import { ReportesService } from './reportes.service';

@ApiTags('reportes')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('reportes')
export class ReportesController {
  constructor(private readonly reportes: ReportesService) {}

  /** Todos los reportes digitalizados, para la bandeja de revisión. */
  @Get()
  listar() {
    return this.reportes.listar();
  }

  /** Dataset actualizable de clientes, direcciones de locales y usuarios de contacto registrados. */
  @Get('dataset/clientes')
  obtenerDatasetClientes() {
    return this.reportes.obtenerDatasetClientes();
  }

  /**
   * SIREP-S3-T05: Exportación a Excel (.xlsx o .csv con BOM UTF-8) con los 31 campos,
   * colocando primero los 10 campos vitales y usando los nombres de columna acordados con RP-TECH.
   */
  @Get('exportar/excel')
  async exportarExcel(
    @Query('formato') formato: string | undefined,
    @Res() res?: Response,
  ) {
    const fmt = formato?.toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const exportacion = await this.reportes.exportarReportes(fmt);

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', exportacion.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${exportacion.filename}"`,
      );
      res.send(exportacion.buffer);
      return;
    }

    return exportacion;
  }

  /** Alias corto para exportación directa desde la bandeja (`/reportes/exportar`). */
  @Get('exportar')
  async exportar(
    @Query('formato') formato: string | undefined,
    @Res() res?: Response,
  ) {
    return this.exportarExcel(formato, res);
  }

  /** Un reporte con sus campos y los enlaces temporales a las imágenes del escaneo. */
  @Get(':numero')
  obtener(@Param('numero') numero: string) {
    return this.reportes.obtener(numero);
  }

  /**
   * Confirmar, corregir, marcar ilegible o reabrir un campo.
   * SIREP-S3-T04: Cada corrección queda registrada con el usuario autenticado de la sesión.
   */
  @Patch(':numero/campos/:campoId')
  revisarCampo(
    @Param('numero') numero: string,
    @Param('campoId') campoId: string,
    @Body() accion: AccionRevisionDto,
    @Req() req?: any,
  ) {
    const actorAutenticado =
      req?.usuario?.nombre || req?.usuario?.email || accion.actor || 'revisor';
    return this.reportes.revisarCampo(numero, campoId, {
      ...accion,
      actor: actorAutenticado,
    });
  }
}
