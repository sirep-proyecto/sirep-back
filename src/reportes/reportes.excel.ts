import { deflateRawSync } from 'zlib';
import { construirCampos, FilaReporte, numeroVisible, valorVigente } from './reportes.mapper';

export interface ColumnaExportacion {
  /** Nombre de columna acordado con RP-TECH */
  columna: string;
  /** Etiqueta descriptiva del campo */
  etiqueta: string;
  /** Clave interna en `campos_extraidos` (o null si viene de la fila/metadato) */
  claveFormulario: string | null;
  /** Si pertenece a los 10 campos vitales que van primero en el Excel (SIREP-S3-T05) */
  vital: boolean;
}

/**
 * SIREP-S3-T05: Exportación a Excel con todos los campos, los vitales primero,
 * y nombres de columna acordados con RP-TECH.
 *
 * Orden de los 10 campos vitales según la especificación del Sprint 3:
 * 1. N° de talonario (`numero_talonario`)
 * 2. Fecha (`fecha`)
 * 3. Técnico (`tecnico_asignado`)
 * 4. Cliente (`cliente`)
 * 5. Equipo (`serie_equipo`)
 * 6. Motivo (`motivo`)
 * 7. Procedimiento (`procedimiento`)
 * 8. Conclusión (`conclusion`)
 * 9. Hora de llegada (`hora_llegada`)
 * 10. Hora de salida (`hora_salida`)
 */
export const COLUMNAS_EXPORTACION_RPTECH: readonly ColumnaExportacion[] = [
  // --- 10 Campos Vitales (van primero) ---
  { columna: 'numero_talonario', etiqueta: 'N° de talonario', claveFormulario: null, vital: true },
  { columna: 'fecha', etiqueta: 'Fecha', claveFormulario: 'fecha', vital: true },
  { columna: 'tecnico_asignado', etiqueta: 'Técnico', claveFormulario: 'tecnico', vital: true },
  { columna: 'cliente', etiqueta: 'Cliente', claveFormulario: 'empresa', vital: true },
  { columna: 'serie_equipo', etiqueta: 'Equipo', claveFormulario: 'equipo', vital: true },
  { columna: 'motivo', etiqueta: 'Motivo', claveFormulario: 'motivo', vital: true },
  { columna: 'procedimiento', etiqueta: 'Procedimiento', claveFormulario: 'procedimiento', vital: true },
  { columna: 'conclusion', etiqueta: 'Conclusión', claveFormulario: 'conclusion', vital: true },
  { columna: 'hora_llegada', etiqueta: 'Hora de llegada', claveFormulario: 'hora_llegada', vital: true },
  { columna: 'hora_salida', etiqueta: 'Hora de salida', claveFormulario: 'hora_salida', vital: true },

  // --- Resto de los 31 campos del formulario físico ---
  { columna: 'telefono', etiqueta: 'Teléfono', claveFormulario: 'telefono', vital: false },
  { columna: 'direccion', etiqueta: 'Dirección', claveFormulario: 'direccion', vital: false },
  { columna: 'contacto', etiqueta: 'Contacto', claveFormulario: 'contacto', vital: false },
  { columna: 'estado_equipo', etiqueta: 'Estado del equipo', claveFormulario: 'estado_del_equipo', vital: false },
  { columna: 'ultimo_mantenimiento', etiqueta: 'Último mantenimiento', claveFormulario: 'ultimo_mantenimiento', vital: false },
  { columna: 'limpieza_equipo', etiqueta: 'Limpieza del equipo', claveFormulario: 'limpieza_equipo', vital: false },
  { columna: 'cabezales', etiqueta: 'Cabezales', claveFormulario: 'cabezales', vital: false },
  { columna: 'sistema_proteccion', etiqueta: 'Sistema de protección', claveFormulario: 'sistema_proteccion', vital: false },
  { columna: 'tinta', etiqueta: 'Tinta', claveFormulario: 'tinta', vital: false },
  { columna: 'revision_linea_ln', etiqueta: 'Revisión línea L+N', claveFormulario: 'revision_linea_ln', vital: false },
  { columna: 'revision_linea_lt', etiqueta: 'Revisión línea L+T', claveFormulario: 'revision_linea_lt', vital: false },
  { columna: 'revision_linea_nt', etiqueta: 'Revisión línea N+T', claveFormulario: 'revision_linea_nt', vital: false },
  { columna: 'operador', etiqueta: 'Operador', claveFormulario: 'operador', vital: false },
  { columna: 'recomendaciones', etiqueta: 'Recomendaciones', claveFormulario: 'recomendaciones', vital: false },
  { columna: 'repuestos_tipo', etiqueta: 'Repuestos tipo', claveFormulario: 'repuestos_tipo', vital: false },
  { columna: 'codigo_repuesto', etiqueta: 'Código repuesto', claveFormulario: 'codigo_repuesto', vital: false },
  { columna: 'repuestos_descripcion', etiqueta: 'Repuestos descripción', claveFormulario: 'repuestos_descripcion', vital: false },
  { columna: 'repuestos_cantidad', etiqueta: 'Repuestos cantidad', claveFormulario: 'repuestos_cantidad', vital: false },
  { columna: 'garantia', etiqueta: 'Garantía', claveFormulario: 'garantia', vital: false },
  { columna: 'facturado', etiqueta: 'Facturado', claveFormulario: 'facturado', vital: false },
  { columna: 'firma_operador', etiqueta: 'Firma operador', claveFormulario: 'firma_operador', vital: false },
  { columna: 'firma_cliente', etiqueta: 'Firma cliente', claveFormulario: 'firma_cliente', vital: false },

  // --- Metadatos de trazabilidad e integración con RP-TECH ---
  { columna: 'origen', etiqueta: 'Origen', claveFormulario: null, vital: false },
  { columna: 'estado_reporte', etiqueta: 'Estado reporte', claveFormulario: null, vital: false },
  { columna: 'corregido_por', etiqueta: 'Corregido por', claveFormulario: null, vital: false },
  { columna: 'creado_en', etiqueta: 'Creado en', claveFormulario: null, vital: false },
  { columna: 'actualizado_en', etiqueta: 'Actualizado en', claveFormulario: null, vital: false },
];

export type FilaReporteExportable = FilaReporte & Record<string, any>;

/**
 * Convierte una fila de `reportes` en un objeto plano con todas las columnas de exportación,
 * priorizando el valor revisado/corregido en `campos_extraidos` o la columna consultable.
 */
export function construirFilaExportacion(fila: FilaReporteExportable): Record<string, string> {
  const campos = construirCampos(fila.campos_extraidos);
  const mapaVigentes = new Map<string, string | null>();
  let ultimoRevisor: string | null = fila.corregido_por ?? null;

  for (const campo of campos) {
    mapaVigentes.set(campo.id, valorVigente(campo));
    if (!ultimoRevisor && (campo.corregido_por || campo.revisado_por)) {
      ultimoRevisor = campo.corregido_por || campo.revisado_por;
    }
  }

  const hayPendientes = campos.some((c) => c.estado_revision === 'pendiente');
  const estadoReporte =
    fila.estado_reporte ?? (hayPendientes ? 'pendiente_revision' : 'aprobado');

  const salida: Record<string, string> = {};

  for (const def of COLUMNAS_EXPORTACION_RPTECH) {
    if (def.columna === 'numero_talonario') {
      salida[def.columna] = numeroVisible(fila);
      continue;
    }
    if (def.columna === 'origen') {
      salida[def.columna] = String(fila.origen ?? 'historico');
      continue;
    }
    if (def.columna === 'estado_reporte') {
      salida[def.columna] = String(estadoReporte);
      continue;
    }
    if (def.columna === 'corregido_por') {
      salida[def.columna] = ultimoRevisor ? String(ultimoRevisor) : '';
      continue;
    }
    if (def.columna === 'creado_en') {
      salida[def.columna] = fila.creado_en ? String(fila.creado_en) : '';
      continue;
    }
    if (def.columna === 'actualizado_en') {
      salida[def.columna] = fila.actualizado_en ? String(fila.actualizado_en) : '';
      continue;
    }

    const desdeCampo = def.claveFormulario ? mapaVigentes.get(def.claveFormulario) : null;
    const desdeColumna = fila[def.columna];
    const valorFinal =
      desdeCampo !== null && desdeCampo !== undefined && String(desdeCampo).trim() !== ''
        ? String(desdeCampo).trim()
        : desdeColumna !== null && desdeColumna !== undefined && String(desdeColumna).trim() !== ''
          ? String(desdeColumna).trim()
          : '';

    salida[def.columna] = valorFinal;
  }

  return salida;
}

function escaparCsv(valor: string): string {
  const texto = String(valor ?? '');
  if (/[",\r\n;]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

/**
 * Genera un CSV con BOM UTF-8 (`\uFEFF`) para que Excel reconozca tildes y eñes automáticamente.
 */
export function generarCsvReportes(filas: FilaReporteExportable[]): string {
  const encabezados = COLUMNAS_EXPORTACION_RPTECH.map((c) => escaparCsv(c.columna)).join(',');
  const lineas = filas.map((fila) => {
    const registro = construirFilaExportacion(fila);
    return COLUMNAS_EXPORTACION_RPTECH.map((c) => escaparCsv(registro[c.columna] ?? '')).join(',');
  });

  return '\uFEFF' + [encabezados, ...lineas].join('\r\n') + '\r\n';
}

function escaparXml(texto: string): string {
  return String(texto ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function nombreColumnaExcel(indiceBase0: number): string {
  let n = indiceBase0 + 1;
  let nombre = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    nombre = String.fromCharCode(65 + resto) + nombre;
    n = Math.floor((n - 1) / 26);
  }
  return nombre;
}

const TABLA_CRC32 = (() => {
  const tabla = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tabla[i] = c >>> 0;
  }
  return tabla;
})();

function calcularCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = TABLA_CRC32[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function empaquetarZip(archivos: Array<{ ruta: string; contenido: Buffer }>): Buffer {
  const partesLocales: Buffer[] = [];
  const directorioCentral: Buffer[] = [];
  let offsetActual = 0;

  for (const arch of archivos) {
    const nombreBuf = Buffer.from(arch.ruta, 'utf-8');
    const datosSinComprimir = arch.contenido;
    const datosComprimidos = deflateRawSync(datosSinComprimir);
    const crc = calcularCrc32(datosSinComprimir);

    const headerLocal = Buffer.alloc(30);
    headerLocal.writeUInt32LE(0x04034b50, 0); // Firma local file header
    headerLocal.writeUInt16LE(20, 4); // Versión requerida (2.0)
    headerLocal.writeUInt16LE(0x0800, 6); // Bit 11 = nombres en UTF-8
    headerLocal.writeUInt16LE(8, 8); // Método 8 = Deflate
    headerLocal.writeUInt16LE(0, 10); // Hora mod
    headerLocal.writeUInt16LE(0x596c, 12); // Fecha mod (2026-11-12)
    headerLocal.writeUInt32LE(crc, 14);
    headerLocal.writeUInt32LE(datosComprimidos.length, 18);
    headerLocal.writeUInt32LE(datosSinComprimir.length, 22);
    headerLocal.writeUInt16LE(nombreBuf.length, 26);
    headerLocal.writeUInt16LE(0, 28);

    partesLocales.push(headerLocal, nombreBuf, datosComprimidos);

    const headerCentral = Buffer.alloc(46);
    headerCentral.writeUInt32LE(0x02014b50, 0); // Firma central directory
    headerCentral.writeUInt16LE(20, 4);
    headerCentral.writeUInt16LE(20, 6);
    headerCentral.writeUInt16LE(0x0800, 8);
    headerCentral.writeUInt16LE(8, 10);
    headerCentral.writeUInt16LE(0, 12);
    headerCentral.writeUInt16LE(0x596c, 14);
    headerCentral.writeUInt32LE(crc, 16);
    headerCentral.writeUInt32LE(datosComprimidos.length, 20);
    headerCentral.writeUInt32LE(datosSinComprimir.length, 24);
    headerCentral.writeUInt16LE(nombreBuf.length, 28);
    headerCentral.writeUInt16LE(0, 30);
    headerCentral.writeUInt16LE(0, 32);
    headerCentral.writeUInt16LE(0, 34);
    headerCentral.writeUInt16LE(0, 36);
    headerCentral.writeUInt32LE(0, 38);
    headerCentral.writeUInt32LE(offsetActual, 42);

    directorioCentral.push(headerCentral, nombreBuf);
    offsetActual += headerLocal.length + nombreBuf.length + datosComprimidos.length;
  }

  const tamanoCentral = directorioCentral.reduce((acc, b) => acc + b.length, 0);
  const finCentral = Buffer.alloc(22);
  finCentral.writeUInt32LE(0x06054b50, 0);
  finCentral.writeUInt16LE(0, 4);
  finCentral.writeUInt16LE(0, 6);
  finCentral.writeUInt16LE(archivos.length, 8);
  finCentral.writeUInt16LE(archivos.length, 10);
  finCentral.writeUInt32LE(tamanoCentral, 12);
  finCentral.writeUInt32LE(offsetActual, 16);
  finCentral.writeUInt16LE(0, 20);

  return Buffer.concat([...partesLocales, ...directorioCentral, finCentral]);
}

/**
 * Genera un libro nativo de Excel (`.xlsx` OpenXML) en UTF-8 con todas las columnas,
 * colocando primero los 10 campos vitales y conservando tildes, eñes y saltos de línea.
 */
export function generarExcelReportes(filas: FilaReporteExportable[]): Buffer {
  const filasXml: string[] = [];

  // Fila 1: Encabezados con los nombres de columna acordados con RP-TECH (estilo 1 = negrita)
  const celdasEncabezado = COLUMNAS_EXPORTACION_RPTECH.map((col, idx) => {
    const ref = `${nombreColumnaExcel(idx)}1`;
    return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${escaparXml(col.columna)}</t></is></c>`;
  }).join('');
  filasXml.push(`<row r="1">${celdasEncabezado}</row>`);

  // Filas 2..N: Datos de cada reporte
  filas.forEach((fila, filaIdx) => {
    const numFila = filaIdx + 2;
    const registro = construirFilaExportacion(fila);
    const celdas = COLUMNAS_EXPORTACION_RPTECH.map((col, colIdx) => {
      const ref = `${nombreColumnaExcel(colIdx)}${numFila}`;
      const valor = registro[col.columna] ?? '';
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escaparXml(valor)}</t></is></c>`;
    }).join('');
    filasXml.push(`<row r="${numFila}">${celdas}</row>`);
  });

  const colsAncho = COLUMNAS_EXPORTACION_RPTECH.map(
    (col, idx) =>
      `<col min="${idx + 1}" max="${idx + 1}" width="${col.vital ? 24 : 18}" customWidth="1"/>`,
  ).join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols>${colsAncho}</cols>` +
    `<sheetData>${filasXml.join('')}</sheetData>` +
    `</worksheet>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Reportes SIREP" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const workbookRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  return empaquetarZip([
    { ruta: '[Content_Types].xml', contenido: Buffer.from(contentTypesXml, 'utf-8') },
    { ruta: '_rels/.rels', contenido: Buffer.from(rootRelsXml, 'utf-8') },
    { ruta: 'xl/workbook.xml', contenido: Buffer.from(workbookXml, 'utf-8') },
    { ruta: 'xl/_rels/workbook.xml.rels', contenido: Buffer.from(workbookRelsXml, 'utf-8') },
    { ruta: 'xl/styles.xml', contenido: Buffer.from(stylesXml, 'utf-8') },
    { ruta: 'xl/worksheets/sheet1.xml', contenido: Buffer.from(sheetXml, 'utf-8') },
  ]);
}
