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
  Optional,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ActividadInterceptor, RegistrarActividad } from '../auth/actividad.interceptor';
import { RequierePermiso } from '../auth/requiere-permiso.decorator';
import { AccionRevisionDto } from './dto/accion-revision.dto';
import { ReportesService } from './reportes.service';
import { TableroService } from './tablero.service';

@ApiTags('reportes')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@UseInterceptors(ActividadInterceptor)
@Controller('reportes')
export class ReportesController {
  constructor(
    private readonly reportes: ReportesService,
    @Optional() private readonly tablero?: TableroService,
  ) {}

  /** Todos los reportes digitalizados, para la bandeja de revisión (el ingestor solo ve sus cargas). */
  @RequierePermiso('ver_reportes')
  @Get()
  listar(@Req() req?: any) {
    return this.reportes.listar(1000, req?.usuario);
  }

  /**
   * SIREP-S4-T03: Cola libre con reserva — botón "Siguiente reporte".
   * Entrega el reporte pendiente más antiguo reservado por 4 horas al revisor autenticado.
   */
  @RequierePermiso('usar_cola')
  @RegistrarActividad('reporte_reservado')
  @Post('cola/siguiente')
  tomarSiguiente(@Req() req?: any) {
    const usuario = {
      id: String(req?.usuario?.id ?? ''),
      nombre: req?.usuario?.nombre || req?.usuario?.email || 'Revisor',
    };
    return this.reportes.tomarSiguienteReporteDeCola(usuario);
  }

  /** SIREP-S4-T03: Consulta la reserva activa del revisor autenticado (si tiene una abierta). */
  @RequierePermiso('usar_cola')
  @Get('cola/mi-reserva')
  obtenerMiReserva(@Req() req?: any) {
    const usuario = {
      id: String(req?.usuario?.id ?? ''),
      nombre: req?.usuario?.nombre || req?.usuario?.email || 'Revisor',
    };
    return this.reportes.obtenerMiReserva(usuario);
  }

  /** Dataset actualizable de clientes, direcciones de locales y usuarios de contacto registrados. */
  @RequierePermiso('ver_reportes')
  @Get('dataset/clientes')
  obtenerDatasetClientes() {
    return this.reportes.obtenerDatasetClientes();
  }

  /**
   * SIREP-S3-T05: Exportación a Excel (.xlsx o .csv con BOM UTF-8) con los 31 campos,
   * colocando primero los 10 campos vitales y usando los nombres de columna acordados con RP-TECH.
   */
  @RequierePermiso('exportar')
  @RegistrarActividad('excel_exportado')
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
  @RequierePermiso('exportar')
  @RegistrarActividad('excel_exportado')
  @Get('exportar')
  async exportar(
    @Query('formato') formato: string | undefined,
    @Res() res?: Response,
  ) {
    return this.exportarExcel(formato, res);
  }

  /**
   * SIREP-S3-T18: Métricas agregadas por campo (sin ningún dato de clientes).
   * Con `?formato=csv` devuelve directamente `campo,total,confirmados,corregidos,ilegibles,confianza_declarada,omitidos`.
   */
  @RequierePermiso('ver_reportes')
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
  @RequierePermiso('ver_reportes')
  @Get('metricas/diarias')
  obtenerMetricasDiarias(
    @Query('formato') formato?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    return this.obtenerMetricasCampos(formato, res);
  }

  /**
   * SIREP-S4-T06, T07 y T08: Tablero del administrador con avance por persona (sesiones de 20 min),
   * ritmo diario, fecha estimada de término, reservas activas, alertas de calidad y doble revisión.
   */
  @RequierePermiso('gestionar_usuarios')
  @Get('tablero')
  obtenerTablero() {
    if (!this.tablero) {
      throw new ServiceUnavailableException('El servicio de tablero no está disponible.');
    }
    return this.tablero.obtenerTablero();
  }

  /**
   * SIREP-S4-T05: Registro inmutable de eventos de revisión e ingesta.
   * Solo visible para el administrador.
   */
  @RequierePermiso('gestionar_usuarios')
  @Get('eventos')
  listarEventos(
    @Query('limite') limite?: string,
    @Query('usuario_id') usuarioId?: string,
    @Query('reporte') reporte?: string,
    @Query('tipo_accion') tipoAccion?: string,
  ) {
    if (!this.tablero) {
      throw new ServiceUnavailableException('El servicio de tablero no está disponible.');
    }
    return this.tablero.listarEventos({
      limite: limite ? Number(limite) : undefined,
      usuarioId,
      reporte,
      tipoAccion,
    });
  }

  /**
   * SIREP-S3-T13 / SIREP-S4-T02: Paso en lote de todos los reportes ya revisados a RP-TECH.
   * Exclusivo del administrador.
   */
  @RequierePermiso('gestionar_usuarios')
  @RegistrarActividad('lote_cerrado')
  @Post('importar-lote')
  importarLote(@Req() req?: any) {
    const actor = req?.usuario?.nombre || req?.usuario?.email || 'sistema';
    return this.reportes.importarReportesRevisadosEnLote(actor);
  }

  /**
   * PDF del reporte con el formato del reporte técnico de RP-TECH (hoja de la empresa),
   * con los valores ya corregidos y el escaneo original en el anexo.
   */
  @RequierePermiso('ver_reportes')
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
  @RequierePermiso('ver_reportes')
  @Get(':numero')
  obtener(@Param('numero') numero: string) {
    return this.reportes.obtener(numero);
  }

  /**
   * SIREP-S4-T03: Libera un reporte reservado para que vuelva a la cola.
   * Puede ejecutarlo el propio revisor dueño de la reserva o el administrador.
   */
  @RequierePermiso('usar_cola')
  @RegistrarActividad('reporte_liberado', (req) => ({ reporte: req.params?.numero }))
  @Post(':numero/liberar')
  liberar(@Param('numero') numero: string, @Req() req?: any) {
    return this.reportes.liberarReporte(numero, req?.usuario ?? {});
  }

  /**
   * SIREP-S3-T10: Guardar vínculos (`cliente_id`, `equipo_id`, `tecnico_perfil_id`)
   * conservando intacto el texto manuscrito leído originalmente.
   */
  @RequierePermiso('editar_campos')
  @RegistrarActividad('vinculos_actualizados', (req) => ({ reporte: req.params?.numero }))
  @Patch(':numero/vinculos')
  vincular(
    @Param('numero') numero: string,
    @Body()
    vinculos: {
      cliente_id?: string | null;
      equipo_id?: string | null;
      tecnico_perfil_id?: string | null;
    },
    @Req() req?: any,
  ) {
    return this.reportes.vincularEntidades(numero, vinculos, req?.usuario);
  }

  /**
   * SIREP-S3-T11: Endpoint del contrato de importación idempotente.
   * Cierra el reporte revisado y no lo duplica si se llama más de una vez.
   */
  @RequierePermiso('cerrar_reportes')
  @RegistrarActividad('reporte_cerrado', (req) => ({ reporte: req.params?.numero }))
  @Patch(':numero/importar')
  importar(@Param('numero') numero: string, @Req() req?: any) {
    const actor = req?.usuario?.nombre || req?.usuario?.email || 'sistema';
    return this.reportes.importarReporteRevisado(numero, actor);
  }

  /**
   * Confirmar, corregir, marcar ilegible, omitir (vacío en el papel) o reabrir un campo.
   * SIREP-S3-T04: Cada corrección queda registrada con el usuario autenticado de la sesión.
   */
  @RequierePermiso('editar_campos')
  @RegistrarActividad('campo_revisado', (req) => ({
    reporte: req.params?.numero,
    campo: req.params?.campoId,
    tipo: req.body?.tipo,
  }))
  @Patch(':numero/campos/:campoId')
  revisarCampo(
    @Param('numero') numero: string,
    @Param('campoId') campoId: string,
    @Body() accion: AccionRevisionDto,
    @Req() req?: any,
  ) {
    const actorAutenticado =
      req?.usuario?.nombre || req?.usuario?.email || accion.actor || 'revisor';
    return this.reportes.revisarCampo(
      numero,
      campoId,
      {
        ...accion,
        actor: actorAutenticado,
      },
      req?.usuario,
    );
  }
}
