import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
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

  /**
   * SIREP-S3-T18: Métricas agregadas por campo (sin ningún dato de clientes).
   * Con `?formato=csv` devuelve directamente `campo,total,confirmados,corregidos,ilegibles,confianza_declarada`.
   */
  @Get('metricas/campos')
  async obtenerMetricasCampos(
    @Query('formato') formato?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const metricas = await this.reportes.obtenerMetricasCampos();
    if (formato?.toLowerCase() === 'csv' && res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="metricas_${metricas.fecha}.csv"`,
      );
      return metricas.csv;
    }
    return metricas;
  }

  /** Alias para consumo diario automatizado (`/reportes/metricas/diarias`). */
  @Get('metricas/diarias')
  obtenerMetricasDiarias(
    @Query('formato') formato?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    return this.obtenerMetricasCampos(formato, res);
  }

  /**
   * SIREP-S3-T13: Paso en lote de todos los reportes ya revisados a estado cerrado/importado
   * sin volver a escanear ni consumir IA.
   */
  @Post('importar-lote')
  importarLote(@Req() req?: any) {
    const actor = req?.usuario?.nombre || req?.usuario?.email || 'sistema';
    return this.reportes.importarReportesRevisadosEnLote(actor);
  }

  /**
   * PDF del reporte con el formato del reporte técnico de RP-TECH (hoja de la empresa),
   * con los valores ya corregidos y el escaneo original en el anexo.
   */
  @Get(':numero/pdf')
  async descargarPdf(@Param('numero') numero: string, @Res() res?: Response) {
    const pdf = await this.reportes.generarPdf(numero);

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
      res.send(pdf.buffer);
      return;
    }

    return pdf;
  }

  /** Un reporte con sus campos y los enlaces temporales a las imágenes del escaneo. */
  @Get(':numero')
  obtener(@Param('numero') numero: string) {
    return this.reportes.obtener(numero);
  }

  /**
   * SIREP-S3-T10: Guardar vínculos (`cliente_id`, `equipo_id`, `tecnico_perfil_id`)
   * conservando intacto el texto manuscrito leído originalmente.
   */
  @Patch(':numero/vinculos')
  vincular(
    @Param('numero') numero: string,
    @Body()
    vinculos: {
      cliente_id?: string | null;
      equipo_id?: string | null;
      tecnico_perfil_id?: string | null;
    },
  ) {
    return this.reportes.vincularEntidades(numero, vinculos);
  }

  /**
   * SIREP-S3-T11: Endpoint del contrato de importación idempotente.
   * Cierra el reporte revisado y no lo duplica si se llama más de una vez.
   */
  @Patch(':numero/importar')
  importar(@Param('numero') numero: string, @Req() req?: any) {
    const actor = req?.usuario?.nombre || req?.usuario?.email || 'sistema';
    return this.reportes.importarReporteRevisado(numero, actor);
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
