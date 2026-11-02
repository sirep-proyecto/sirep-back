import * as crypto from 'crypto';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

/**
 * Calcula la huella digital SHA-256 del archivo escaneado original.
 * Utilizado para detectar si el mismo archivo fue reenviado.
 */
export function calcularHuellaSHA256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Extrae el número de reporte impreso del talonario a partir del texto acompañante
 * o del nombre del archivo (ej. "000214.pdf", "0005-A.pdf", "Reporte N° 000845").
 * Importante: Los ceros iniciales y letras (como 0005-A) se conservan como texto.
 */
export function extraerNumeroReporte(texto?: string | null): string | null {
  if (!texto) return null;
  const limpio = texto.trim();

  // Patrón con guion o letra (ej: 0005-A, 000845-B)
  const conLetra = limpio.match(/(\d{3,7}-[A-Za-z])/);
  if (conLetra && conLetra[1]) return conLetra[1];

  // Patrón numérico con ceros a la izquierda (ej: 000845, 000214)
  const coincidencia = limpio.match(/(?:reporte|n[°o.]?|talonario)?\s*[:#-]?\s*(\d{4,7})/i);
  if (coincidencia && coincidencia[1]) {
    return coincidencia[1];
  }

  // Nombre de archivo con ceros (ej: 000845.pdf)
  const porArchivo = limpio.match(/^([0-9A-Za-z-]{4,10})\.[a-zA-Z0-9]+$/);
  if (porArchivo && porArchivo[1]) {
    return porArchivo[1];
  }

  return null;
}

/**
 * Procesa un PDF para determinar su número de páginas y extraer cada página
 * de manera independiente para su archivado y visualización.
 */
export async function procesarPaginasPDF(
  buffer: Buffer,
): Promise<{ totalPaginas: number; paginas: Buffer[] }> {
  try {
    const pdfDoc = await PDFDocument.load(buffer);
    const totalPaginas = pdfDoc.getPageCount();
    const paginas: Buffer[] = [];

    for (let i = 0; i < totalPaginas; i++) {
      const subDoc = await PDFDocument.create();
      const [copiedPage] = await subDoc.copyPages(pdfDoc, [i]);
      subDoc.addPage(copiedPage);
      const subPdfBytes = await subDoc.save();
      paginas.push(Buffer.from(subPdfBytes));
    }

    return { totalPaginas, paginas };
  } catch (err) {
    // Si no es un PDF válido o falla pdf-lib, devolvemos 1 página con el buffer original
    return { totalPaginas: 1, paginas: [buffer] };
  }
}

/**
 * Genera la copia optimizada/comprimida para enviar al modelo de IA.
 * El archivo original se conserva sin comprimir en Storage (Guía pág. 10 y 17).
 */
export async function optimizarParaIA(
  buffer: Buffer,
  mimetype: string,
): Promise<{ buffer: Buffer; mimetype: string }> {
  if (mimetype === 'application/pdf') {
    // Gemini y modelos multimodales soportan PDF directamente
    return { buffer, mimetype: 'application/pdf' };
  }

  try {
    const optimizado = await sharp(buffer)
      .rotate()
      .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    return { buffer: optimizado, mimetype: 'image/jpeg' };
  } catch (err) {
    return { buffer, mimetype };
  }
}
