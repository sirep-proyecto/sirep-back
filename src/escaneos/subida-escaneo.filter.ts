import { ArgumentsHost, Catch, ExceptionFilter, PayloadTooLargeException } from '@nestjs/common';
import { limiteMbEscaneo } from './escaneos.util';

/**
 * Multer corta la subida con 413 cuando el archivo pasa el límite (`MAX_MB_ESCANEO`).
 * Su mensaje es "File too large"; la página necesita un texto en español y un `codigo` estable.
 */
@Catch(PayloadTooLargeException)
export class SubidaEscaneoFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const mb = limiteMbEscaneo();
    res.status(413).json({
      statusCode: 413,
      codigo: 'muy_grande',
      message: `El archivo es demasiado grande. El máximo es ${mb} MB; reduce la calidad del escaneo o súbelo por partes.`,
    });
  }
}
