import {
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  Query,
  BadRequestException,
  Req,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { EscaneosService } from './escaneos.service';
import { limiteMbEscaneo } from './escaneos.util';
import { SubidaEscaneoFilter } from './subida-escaneo.filter';

@ApiTags('escaneos')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('escaneos')
export class EscaneosController {
  constructor(private readonly escaneosService: EscaneosService) {}

  @Get()
  async listar(@Query('limite') limite?: string) {
    const lim = limite ? parseInt(limite, 10) : 50;
    return this.escaneosService.listarEscaneos(lim);
  }

  @Get(':id')
  async obtenerPorId(@Param('id') id: string) {
    return this.escaneosService.obtenerEscaneoPorId(id);
  }

  /**
   * Sube UN reporte (un PDF de 1 a MAX_PAGINAS_REPORTE páginas, o una foto JPG/PNG/WebP).
   * La página sube varios archivos con una petición por archivo.
   *
   * multipart/form-data, requiere `Authorization: Bearer <token>`:
   *  - `file` (obligatorio): el archivo, hasta MAX_MB_ESCANEO MB (10 por defecto).
   *  - `numeroReporte` (opcional): N° del reporte si ya se conoce.
   *
   * 201 -> { escaneoId, numeroReporte, estado: 'procesado' | 'completo', campos, camposDudosos,
   *          totalPaginas, huella, rutasPaginas, metricasIA }
   *
   * Errores: todos traen { statusCode, codigo, message } con `message` en español para mostrar tal cual.
   *  - 400 formato_no_admitido: no es PDF ni imagen (Word, etc.)
   *  - 400 demasiadas_paginas: el PDF excede MAX_PAGINAS_REPORTE
   *  - 400 archivo_danado: PDF dañado/con contraseña, o archivo vacío
   *  - 400 falta_archivo: no se envió el campo `file`
   *  - 413 muy_grande: supera MAX_MB_ESCANEO
   *  - 409 archivo_duplicado | reporte_duplicado: además trae numeroReporte, escaneoId, recibidoEn,
   *        origen ('telegram' | 'web') y enviadoPor del reporte que ya existía (null si no se conocen)
   *  - 502 lectura_ia: falló la IA; no se guardó nada, se puede reintentar
   */
  @Post('upload')
  @UseFilters(SubidaEscaneoFilter)
  @UseInterceptors(FileInterceptor('file', {
    // getter: se lee en cada petición, así no depende de que el .env ya esté cargado al importar la clase
    limits: {
      get fileSize() {
        return limiteMbEscaneo() * 1024 * 1024;
      },
    },
  }))
  async subirEscaneo(
    @UploadedFile() file: Express.Multer.File,
    @Body('numeroReporte') numeroReporte?: string,
    @Body('enviadoPor') enviadoPor?: string,
    @Req() req?: any,
  ) {
    if (!file) {
      throw new BadRequestException({
        statusCode: 400,
        codigo: 'falta_archivo',
        message: 'No se recibió ningún archivo. Selecciona un PDF o una foto del reporte.',
      });
    }
    const remitente = req?.usuario?.nombre || req?.usuario?.email || enviadoPor || 'web';
    return this.escaneosService.procesarEscaneo({
      buffer: file.buffer,
      filename: file.originalname,
      caption: numeroReporte,
      mimetype: file.mimetype,
      enviadoPor: remitente,
    });
  }
}
