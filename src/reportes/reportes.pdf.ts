/**
 * Responsabilidad: arma el PDF del reporte técnico con el formato de la hoja de papel
 * de GO Service Latam (el mismo que genera RP-TECH), usando los valores ya revisados.
 * Página 1 = el formulario (carta: franja, logo, N° en rojo, campos en cajas, casillas
 * con X, recuadros con renglones, tabla de repuestos, información de la labor, firmas);
 * páginas siguientes = ANEXO con el escaneo original y, si hubo correcciones, el escaneo
 * con los valores corregidos dibujados encima.
 * Son funciones puras (sin red ni base): reciben el reporte con sus campos resueltos y
 * los bytes del escaneo; la descarga del storage la hace `ReportesService`.
 * Se porta de `rp-tech-backend/supabase/functions/reporte-pdf/pdf.ts` (pdf-lib).
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, RGB, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { casillaMarcada, normalizarTexto } from '../ia-extractor/normalizacion';
import { renderizarPaginasPDF, esPDF } from '../escaneos/escaneos.util';
import { CampoContrato, RegionContrato } from './reportes.mapper';
import { REGIONES_TALONARIO } from './talonario.regiones';

// ---------------------------------------------------------------------------
// Datos de la empresa: un solo lugar. SIREP aún no tiene configuración de empresa
// (el reporte siempre es de GO Service Latam); si se agrega, se reemplaza esta constante.
// ---------------------------------------------------------------------------
export interface DatosEmpresaPdf {
  nombre: string;
  telefonos: string[];
  correos: string[];
  direccion: string;
  redes: string;
  /** Color de acento (línea, cabecera de tabla) y color oscuro de las franjas, en hex. */
  color: string;
  colorOscuro: string;
  textoLegal: string;
  textoConformidad: string;
}

export const EMPRESA_PDF: DatosEmpresaPdf = {
  nombre: 'GO Service Latam',
  telefonos: ['WhatsApp: 51 943116468'],
  correos: ['admin@goservicelatam.com.pe', 'serviciotecnico@goservicelatam.co'],
  direccion: 'Jirón Huánuco 2131 int 233 – Galería LA MULTI (cruce de Huánuco con Italia – Gamarra)',
  redes: 'goservicelatam',
  color: '#8a3d8f',
  colorOscuro: '#3b3b47',
  textoLegal:
    'El cliente acepta los términos y condiciones del servicio, de acuerdo a las cláusulas de la carta de garantía de servicio. ' +
    'Los servicios que se realicen y no sean considerados parte de la garantía serán cobrados al cliente, de acuerdo a la tarifa ' +
    'estándar de servicio ($ 40.00 más IGV la hora o fracción).',
  textoConformidad: 'Con el VB° doy la conformidad de que el servicio se realizó tal como indica este informe',
};

export interface ReportePdf {
  /** N° de talonario (o `SN-…` si no se leyó). */
  numero: string;
  /** Los 31 campos ya resueltos con `construirCampos`. */
  campos: CampoContrato[];
  /** Quién revisó y cuándo (ISO), para la línea "Transcrito con SIREP". */
  revisadoPor?: string | null;
  revisadoEn?: string | null;
  empresa?: DatosEmpresaPdf;
}

const TINTA = rgb(0.11, 0.11, 0.14);
const VALOR = rgb(0.07, 0.13, 0.25);
const GRIS = rgb(0.38, 0.38, 0.44);
const BORDE = rgb(0.42, 0.42, 0.47);
const RAYA = rgb(0.86, 0.86, 0.89);
const ROJO = rgb(0.75, 0.22, 0.17);
const BLANCO = rgb(1, 1, 1);
const CREMA = rgb(1, 0.96, 0.84);
const NARANJA = rgb(0.93, 0.53, 0.1);

const ZONA_HORARIA = 'America/Lima';
const LADO_MAXIMO_PX = 1600;
const CALIDAD_JPEG = 80;
const FILAS_REPUESTOS = 4;

// ---------------------------------------------------------------------------
// Valores y mapeo de campos del formulario a lo que dibuja el formato
// ---------------------------------------------------------------------------

/** Estados en los que el campo queda en blanco aunque el modelo haya leído algo (`omitido` es un estado futuro). */
const ESTADOS_SIN_VALOR = new Set(['ilegible', 'omitido']);

/**
 * Valor vigente: corrección humana > lectura de la IA > vacío si el campo se marcó
 * ilegible u omitido. Un texto en blanco cuenta como vacío (null).
 */
export function valorParaPdf(campo: CampoContrato): string | null {
  if (ESTADOS_SIN_VALOR.has(String(campo.estado_revision))) return null;
  const corregido = campo.valor_corregido?.trim();
  const valor = corregido ? corregido : campo.valor_modelo?.trim();
  return valor ? valor : null;
}

/** Valor vigente de cada campo por id (cadena vacía si no hay). */
export function valoresDelReporte(campos: readonly CampoContrato[]): Record<string, string> {
  return Object.fromEntries(campos.map((c) => [c.id, valorParaPdf(c) ?? '']));
}

/** Opción del formulario ("Garantía" y "garantia" coinciden) o null si no es ninguna de las permitidas. */
export function elegirOpcion<T extends string>(valor: string | null | undefined, permitidas: readonly T[]): T | null {
  const v = normalizarTexto(valor ?? '');
  return (permitidas as readonly string[]).includes(v) ? (v as T) : null;
}

/** Casillas del sistema de protección: «Estab.», «UPS», ambas, o texto libre que va a "Otro". */
export function casillasProteccion(valor: string | null | undefined): { estab: boolean; ups: boolean; otro: string | null } {
  const texto = (valor ?? '').trim();
  if (!texto) return { estab: false, ups: false, otro: null };
  const v = normalizarTexto(texto);
  const estab = v.includes('estab');
  const ups = /\bups\b/.test(v);
  return { estab, ups, otro: estab || ups ? null : texto };
}

export interface FilaRepuesto {
  codigo: string;
  descripcion: string;
  cantidad: string;
}

/**
 * Tabla de repuestos: tres columnas de texto con una línea por repuesto; la línea N de
 * cada columna forma la fila N. Si una columna trae menos líneas, la fila queda con ese
 * dato vacío en lugar de descartarse. Las filas totalmente vacías se omiten.
 */
export function parsearRepuestos(
  codigos: string | null | undefined,
  descripciones: string | null | undefined,
  cantidades: string | null | undefined,
): FilaRepuesto[] {
  const lineas = (t: string | null | undefined) => String(t ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim());
  const cods = lineas(codigos);
  const descs = lineas(descripciones);
  const cants = lineas(cantidades);
  const total = Math.max(cods.length, descs.length, cants.length);
  const filas: FilaRepuesto[] = [];
  for (let i = 0; i < total; i++) {
    const fila = { codigo: cods[i] ?? '', descripcion: descs[i] ?? '', cantidad: cants[i] ?? '' };
    if (fila.codigo || fila.descripcion || fila.cantidad) filas.push(fila);
  }
  return filas;
}

/** `AAAA-MM-DD` o `DD/MM/AAAA` → `DD/MM/AAAA`; cualquier otro texto se muestra tal como se leyó. */
export function fechaParaPdf(valor: string | null | undefined): string {
  const t = (valor ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : t;
}

/** `H:MM`/`HH:MM[:SS]` → `HH:MM`; otro texto se muestra tal cual. */
export function horaParaPdf(valor: string | null | undefined): string {
  const t = (valor ?? '').trim();
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?$/.exec(t);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
}

/** Tensión de una línea: un número solo se muestra con su unidad. */
function voltaje(valor: string): string {
  return /^\d+([.,]\d+)?$/.test(valor) ? `${valor} V` : valor;
}

/** Quién revisó y cuándo: el último con fecha entre los campos; si ninguno, lo guardado en el reporte. */
export function derivarRevision(
  campos: readonly CampoContrato[],
  respaldo?: { por?: string | null; en?: string | null },
): { por: string | null; en: string | null } {
  let por: string | null = null;
  let en: string | null = null;
  for (const c of campos) {
    const quien = c.corregido_por ?? c.revisado_por;
    const cuando = c.corregido_en ?? c.revisado_en;
    if (quien && cuando && (en === null || cuando > en)) {
      por = quien;
      en = cuando;
    }
  }
  return { por: por ?? respaldo?.por ?? null, en: en ?? respaldo?.en ?? null };
}

function fechaLima(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-PE', { timeZone: ZONA_HORARIA, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Región de un campo: la que midió el modelo en este escaneo o, si no hay, la del mapa fijo del talonario. */
export function regionDeCampo(campo: Pick<CampoContrato, 'id' | 'region'>): RegionContrato | null {
  return campo.region ?? REGIONES_TALONARIO[campo.id] ?? null;
}

// ---------------------------------------------------------------------------
// Texto seguro para fuentes estándar (solo WinAnsi)
// ---------------------------------------------------------------------------
const EXTRA_WINANSI = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

export function limpiar(t: unknown): string {
  return String(t ?? '')
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .split('')
    .map((c) => (c === '\n' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 255) || EXTRA_WINANSI.includes(c) ? c : ''))
    .join('');
}

function colorDeHex(hex: string, defecto: RGB): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return defecto;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ---------------------------------------------------------------------------
// Imágenes: normalizar el escaneo, comprimirlo y recortar las firmas
// ---------------------------------------------------------------------------
interface PaginaEscaneo {
  /** Imagen completa, ya girada según EXIF, para recortar a resolución original. */
  original: Buffer;
  /** Versión comprimida (JPEG, lado máximo 1600 px) para incrustar. */
  jpeg: Buffer;
  ancho: number;
  alto: number;
}

/** El escaneo puede venir como imágenes (una por página) o como un PDF: un PDF se rasteriza. */
async function prepararPaginas(escaneo: Uint8Array | Uint8Array[] | null | undefined): Promise<PaginaEscaneo[]> {
  const entradas = !escaneo ? [] : Array.isArray(escaneo) ? escaneo : [escaneo];
  const imagenes: Buffer[] = [];
  for (const e of entradas) {
    if (!e || e.length < 8) continue;
    const buf = Buffer.from(e);
    if (esPDF(buf)) {
      try {
        imagenes.push(...(await renderizarPaginasPDF(buf, { dpi: 150, maxPaginas: 4 })));
      } catch {
        // PDF dañado: se omite el anexo en lugar de impedir la descarga del reporte.
      }
    } else {
      imagenes.push(buf);
    }
  }
  const paginas: PaginaEscaneo[] = [];
  for (const img of imagenes) {
    try {
      // `rotate()` sin argumentos aplica la orientación EXIF (las fotos de celular).
      const original = await sharp(img).rotate().toBuffer();
      const { data, info } = await sharp(original)
        .resize({ width: LADO_MAXIMO_PX, height: LADO_MAXIMO_PX, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: CALIDAD_JPEG, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      paginas.push({ original, jpeg: data, ancho: info.width, alto: info.height });
    } catch {
      // Imagen ilegible: se omite esa página.
    }
  }
  return paginas;
}

/**
 * Recorta la región de una firma del escaneo y deja solo la tinta (el papel queda
 * transparente) para dibujarla sobre la línea de firma sin un recuadro blanco.
 */
export async function recortarFirma(pagina: Pick<PaginaEscaneo, 'original'>, region: RegionContrato): Promise<Buffer | null> {
  try {
    const meta = await sharp(pagina.original).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return null;
    const left = Math.max(0, Math.min(W - 1, Math.round(region.x * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(region.y * H)));
    const width = Math.max(1, Math.min(W - left, Math.round(region.ancho * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(region.alto * H)));
    const { data, info } = await sharp(pagina.original)
      .extract({ left, top, width, height })
      .resize({ width: 700, withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgba = Buffer.alloc(info.width * info.height * 4);
    let tinta = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      const g = data[i];
      // Del papel (>=190) a la tinta (<=90): opacidad progresiva, color azul oscuro.
      const a = Math.max(0, Math.min(255, Math.round(((190 - g) * 255) / 100)));
      if (a > 160) tinta++;
      rgba[i * 4] = 18;
      rgba[i * 4 + 1] = 32;
      rgba[i * 4 + 2] = 70;
      rgba[i * 4 + 3] = a;
    }
    // Casi sin tinta = no hay firma en la región (solo sombras del papel).
    if (tinta < info.width * info.height * 0.002) return null;
    return await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return null;
  }
}

async function incrustar(doc: PDFDocument, bytes: Uint8Array | null | undefined): Promise<PDFImage | null> {
  if (!bytes || bytes.length < 4) return null;
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
    // Cualquier otro formato (webp, etc.): se convierte a JPEG.
    return await doc.embedJpg(await sharp(Buffer.from(bytes)).flatten({ background: '#ffffff' }).jpeg({ quality: CALIDAD_JPEG }).toBuffer());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dibujo (coordenadas "desde arriba", como se lee el formulario)
// ---------------------------------------------------------------------------
class Hoja {
  readonly W = 612;
  readonly H = 792;
  readonly M = 30;
  pagina!: PDFPage;

  constructor(
    public doc: PDFDocument,
    public f: PDFFont,
    public fb: PDFFont,
    public fi: PDFFont,
    public acento: RGB,
    public oscuro: RGB,
  ) {}

  nueva(): PDFPage {
    this.pagina = this.doc.addPage([this.W, this.H]);
    return this.pagina;
  }

  Y(top: number): number {
    return this.H - top;
  }

  texto(t: string, x: number, base: number, tam: number, fuente: PDFFont = this.f, c: RGB = TINTA): void {
    const limpio = limpiar(t);
    if (limpio) this.pagina.drawText(limpio, { x, y: this.Y(base), size: tam, font: fuente, color: c });
  }

  ancho(t: string, tam: number, fuente: PDFFont = this.f): number {
    return fuente.widthOfTextAtSize(limpiar(t), tam);
  }

  /** Texto en una línea que se achica hasta 6.5 pt y, si aún no entra, se corta con "…". */
  ajustado(t: string, x: number, base: number, max: number, tam = 9.5, fuente: PDFFont = this.fb, c: RGB = VALOR): void {
    let s = limpiar(t).replace(/\n/g, ' ');
    let z = tam;
    while (z > 6.5 && fuente.widthOfTextAtSize(s, z) > max) z -= 0.5;
    while (s.length > 1 && fuente.widthOfTextAtSize(s, z) > max) s = s.slice(0, -2) + '…';
    this.texto(s, x, base, z, fuente, c);
  }

  caja(x: number, top: number, w: number, h: number, r = 6, borde: RGB = BORDE, relleno?: RGB): void {
    r = Math.min(r, h / 2, w / 2);
    const d = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
    this.pagina.drawSvgPath(d, { x, y: this.Y(top), borderColor: borde, borderWidth: 0.8, color: relleno });
  }

  etiqueta(t: string, x: number, base: number, tam = 8): number {
    this.texto(t.toUpperCase(), x, base, tam, this.fi, TINTA);
    return this.ancho(t.toUpperCase(), tam, this.fi);
  }

  /** ETIQUETA: [ valor ] — una fila del formulario. */
  campo(etq: string, valor: string, x: number, top: number, w: number, h = 17): void {
    const lw = this.etiqueta(etq + ':', x, top + h / 2 + 3);
    const bx = x + lw + 5;
    this.caja(bx, top, w - lw - 5, h, 7);
    this.ajustado(valor, bx + 7, top + h / 2 + 3.3, w - lw - 19);
  }

  /** Casilla con su rótulo a la izquierda; marcada lleva una X. Devuelve la x donde sigue lo siguiente. */
  casilla(etq: string, marcada: boolean, x: number, top: number): number {
    this.texto(etq, x, top + 8, 8, this.fi);
    const cx = x + this.ancho(etq, 8, this.fi) + 4;
    this.caja(cx, top, 10, 10, 2.5);
    if (marcada) {
      const p = this.pagina;
      const y0 = this.Y(top);
      p.drawLine({ start: { x: cx + 2.2, y: y0 - 2.2 }, end: { x: cx + 7.8, y: y0 - 7.8 }, thickness: 1.4, color: VALOR });
      p.drawLine({ start: { x: cx + 7.8, y: y0 - 2.2 }, end: { x: cx + 2.2, y: y0 - 7.8 }, thickness: 1.4, color: VALOR });
    }
    return cx + 10 + 9;
  }

  envolver(texto: string, fuente: PDFFont, tam: number, max: number): string[] {
    const lineas: string[] = [];
    for (const parrafo of limpiar(texto).split('\n')) {
      let actual = '';
      for (const palabra of parrafo.split(' ')) {
        const prueba = actual ? actual + ' ' + palabra : palabra;
        if (fuente.widthOfTextAtSize(prueba, tam) <= max) {
          actual = prueba;
          continue;
        }
        if (actual) lineas.push(actual);
        let resto = palabra;
        while (fuente.widthOfTextAtSize(resto, tam) > max) {
          let i = resto.length;
          while (i > 1 && fuente.widthOfTextAtSize(resto.slice(0, i), tam) > max) i--;
          lineas.push(resto.slice(0, i));
          resto = resto.slice(i);
        }
        actual = resto;
      }
      lineas.push(actual);
    }
    return lineas;
  }

  /** Recuadro grande con renglones (Procedimiento, Conclusión...). Devuelve true si el texto no entró completo. */
  recuadro(etq: string, valor: string, top: number, h: number): boolean {
    const x = this.M;
    const w = this.W - this.M * 2;
    const col = 112;
    const interlinea = 13.5;
    this.caja(x, top, w, h, 9);
    this.etiqueta(etq, x + 9, top + 15, 8.5);
    const xt = x + col;
    const wt = w - col - 10;
    const renglones = Math.max(1, Math.floor((h - 8) / interlinea));
    for (let i = 1; i <= renglones; i++) {
      const yb = top + 4 + i * interlinea;
      if (yb < top + h - 3) {
        this.pagina.drawLine({ start: { x: xt, y: this.Y(yb + 2) }, end: { x: x + w - 10, y: this.Y(yb + 2) }, thickness: 0.4, color: RAYA });
      }
    }
    let tam = 9.5;
    let lineas = this.envolver(valor, this.f, tam, wt);
    while (lineas.length > renglones && tam > 7.5) {
      tam -= 0.5;
      lineas = this.envolver(valor, this.f, tam, wt);
    }
    let corto = false;
    if (lineas.length > renglones) {
      corto = true;
      lineas = lineas.slice(0, renglones);
      lineas[renglones - 1] = (lineas[renglones - 1] + ' … (continúa en el anexo)').slice(-200);
      while (this.ancho(lineas[renglones - 1], tam) > wt) lineas[renglones - 1] = '…' + lineas[renglones - 1].slice(2);
    }
    lineas.forEach((l, i) => this.texto(l, xt, top + 4 + (i + 1) * interlinea, tam, this.f, VALOR));
    return corto;
  }

  franjaSuperior(): void {
    this.pagina.drawRectangle({ x: 0, y: this.Y(16), width: this.W, height: 16, color: this.oscuro });
    this.pagina.drawRectangle({ x: 0, y: this.Y(20), width: this.W, height: 4, color: this.acento });
  }

  pie(e: DatosEmpresaPdf, numero: string, pagina: number, total: number): void {
    const alto = 52;
    this.pagina.drawRectangle({ x: 0, y: 0, width: this.W, height: alto, color: this.oscuro });
    this.pagina.drawRectangle({ x: 0, y: alto, width: this.W, height: 3, color: this.acento });
    const filas = [e.telefonos.join(' · '), e.correos.join(' · '), e.direccion].filter(Boolean);
    if (!filas.length) filas.push(e.nombre);
    filas.slice(0, 3).forEach((l, i) => this.ajustado(l, this.M, this.H - alto + 14 + i * 12, 400, 8, this.f, BLANCO));
    if (e.redes) {
      const w = Math.min(this.ancho(e.redes, 9, this.fb), 150);
      this.ajustado(e.redes, this.W - this.M - w, this.H - alto + 20, 150, 9, this.fb, BLANCO);
    }
    const pag = `Reporte ${numero} · Página ${pagina} de ${total}`;
    this.texto(pag, this.W - this.M - this.ancho(pag, 7), this.H - 12, 7, this.f, rgb(0.8, 0.8, 0.84));
  }
}

interface SeccionAnexo {
  titulo: string;
  texto: string;
}

// ---------------------------------------------------------------------------
// Generador
// ---------------------------------------------------------------------------

/**
 * Genera el PDF. `escaneo` son las páginas del escaneo (imágenes JPG/PNG, o un PDF que se
 * rasteriza); sin escaneo el PDF queda en el formulario solo. `logo` es opcional: sin él se
 * escribe el nombre de la empresa en el encabezado.
 */
export async function generarPdfReporte(
  reporte: ReportePdf,
  escaneo?: Uint8Array | Uint8Array[] | null,
  logo?: Uint8Array | null,
): Promise<Uint8Array> {
  const empresa = reporte.empresa ?? EMPRESA_PDF;
  const v = valoresDelReporte(reporte.campos);
  const numero = reporte.numero || '—';

  const doc = await PDFDocument.create();
  doc.setTitle(`Reporte técnico ${numero}`);
  doc.setAuthor(empresa.nombre);
  doc.setCreator('SIREP');
  doc.setProducer('SIREP');
  const [f, fb, fi] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.HelveticaBoldOblique),
  ]);
  const acento = colorDeHex(empresa.color, rgb(0.54, 0.24, 0.56));
  const oscuro = colorDeHex(empresa.colorOscuro, rgb(0.23, 0.23, 0.28));
  const H = new Hoja(doc, f, fb, fi, acento, oscuro);
  const M = H.M;
  const ancho = H.W - M * 2;
  const anexo: SeccionAnexo[] = [];
  const paginasEscaneo = await prepararPaginas(escaneo);

  // ================= PÁGINA 1: el formulario =================
  H.nueva();
  H.franjaSuperior();

  // ---- Encabezado: logo (o nombre) centrado ----
  const imgLogo = await incrustar(doc, logo);
  const anchoLogo = 120;
  const altoLogo = 96;
  const topCab = 26;
  const xLogo = (H.W - anchoLogo) / 2;
  if (imgLogo) {
    const s = imgLogo.scaleToFit(anchoLogo, altoLogo);
    H.pagina.drawImage(imgLogo, { x: xLogo + (anchoLogo - s.width) / 2, y: H.Y(topCab + (altoLogo + s.height) / 2), width: s.width, height: s.height });
  } else {
    const lineas = H.envolver(empresa.nombre, fb, 17, anchoLogo + 80);
    lineas.slice(0, 3).forEach((l, i) => H.texto(l, (H.W - H.ancho(l, 17, fb)) / 2, topCab + 44 + i * 20, 17, fb, acento));
  }

  // ---- Título, N° en rojo y técnico ----
  const tituloTop = topCab + altoLogo + 4;
  const titulo = 'REPORTE TÉCNICO';
  H.texto(titulo, (H.W - H.ancho(titulo, 13, fb)) / 2, tituloTop + 12, 13, fb);
  const no = `N° ${numero}`;
  H.texto(no, H.W - M - H.ancho(no, 15, fb), tituloTop + 13, 15, fb, ROJO);
  H.campo('Técnico', v.tecnico, H.W - M - 210, topCab + 62, 210);

  // Línea de procedencia (solo si hay datos de revisión)
  const rev = derivarRevision(reporte.campos, { por: reporte.revisadoPor, en: reporte.revisadoEn });
  if (rev.por) {
    const cuando = rev.en ? fechaLima(rev.en) : '';
    const leyenda = `Transcrito con SIREP · revisado por ${rev.por}${cuando ? ` el ${cuando}` : ''}`;
    H.texto(leyenda, (H.W - H.ancho(leyenda, 6.8)) / 2, tituloTop + 23, 6.8, f, GRIS);
  }

  // ---- Datos del cliente ----
  let top = tituloTop + 32;
  const fila = 22;
  H.campo('Empresa', v.empresa, M, top, 330);
  H.campo('Fecha', fechaParaPdf(v.fecha), M + 340, top, 105);
  H.campo('Telf', v.telefono, M + 455, top, ancho - 455);
  top += fila;
  H.campo('Dirección', v.direccion, M, top, 340);
  H.campo('Equipo', v.equipo, M + 350, top, ancho - 350);
  top += fila;
  H.campo('Contacto', v.contacto, M, top, 230);
  H.campo('Motivo', v.motivo, M + 240, top, ancho - 240);
  if (v.motivo.length > 70) anexo.push({ titulo: 'Motivo de la visita', texto: v.motivo });
  top += fila + 1;
  const legal = H.envolver(empresa.textoLegal, f, 6.8, ancho).slice(0, 3);
  legal.forEach((l, i) => H.texto(l, M, top + 6 + i * 8.5, 6.8, f, GRIS));
  top += legal.length * 8.5 + 4;

  // ---- Revisión inicial ----
  top += 6;
  H.texto('REVISIÓN INICIAL', M, top + 9, 9, fi);
  top += 16;
  const estado = elegirOpcion(v.estado_del_equipo, ['operativo', 'inoperativo'] as const);
  let x = H.etiqueta('Estado del equipo:', M, top + 8) + M + 6;
  x = H.casilla('Operativo', estado === 'operativo', x, top);
  x = H.casilla('Inoperativo', estado === 'inoperativo', x, top);
  H.campo('Último mant.', fechaParaPdf(v.ultimo_mantenimiento), x + 2, top - 3, 150);
  x = x + 162;
  const limpieza = elegirOpcion(v.limpieza_equipo, ['limpio', 'sucio'] as const);
  x = H.etiqueta('Limpieza:', x, top + 8) + x + 6;
  x = H.casilla('Limpio', limpieza === 'limpio', x, top);
  H.casilla('Sucio', limpieza === 'sucio', x, top);
  top += fila;

  const cabezales = elegirOpcion(v.cabezales, ['bueno', 'regular', 'malo'] as const);
  const proteccion = casillasProteccion(v.sistema_proteccion);
  x = H.etiqueta('Cabezales:', M, top + 8) + M + 6;
  x = H.casilla('Bueno', cabezales === 'bueno', x, top);
  x = H.casilla('Regular', cabezales === 'regular', x, top);
  x = H.casilla('Malo', cabezales === 'malo', x, top);
  x = H.etiqueta('Sist. de protección:', x + 2, top + 8) + x + 8;
  x = H.casilla('Estab.', proteccion.estab, x, top);
  x = H.casilla('UPS', proteccion.ups, x, top);
  x = H.casilla('Otro', proteccion.otro !== null, x, top);
  if (proteccion.otro) H.ajustado(proteccion.otro, x - 70, top + 19, 70, 6.5, f, VALOR);
  H.campo('Tinta', v.tinta, x, top - 3, M + ancho - x);
  top += fila;

  x = H.etiqueta('Revisión de líneas:', M, top + 8) + M + 6;
  H.campo('L+N', voltaje(v.revision_linea_ln), x, top - 3, 72);
  x += 80;
  H.campo('L+T', voltaje(v.revision_linea_lt), x, top - 3, 72);
  x += 80;
  H.campo('N+T', voltaje(v.revision_linea_nt), x, top - 3, 72);
  x += 80;
  H.campo('Operador', v.operador, x, top - 3, M + ancho - x);
  top += fila + 2;

  // ---- Procedimiento, conclusión y recomendaciones ----
  if (H.recuadro('Procedimiento', v.procedimiento, top, 122)) anexo.push({ titulo: 'Procedimiento', texto: v.procedimiento });
  top += 128;
  if (H.recuadro('Conclusión', v.conclusion, top, 36)) anexo.push({ titulo: 'Conclusión', texto: v.conclusion });
  top += 42;
  if (H.recuadro('Recomendaciones', v.recomendaciones, top, 36)) anexo.push({ titulo: 'Recomendaciones', texto: v.recomendaciones });
  top += 44;

  // ---- Repuestos (izquierda) e información de la labor (derecha) ----
  const anchoRep = 318;
  const xLab = M + anchoRep + 14;
  const anchoLab = ancho - anchoRep - 14;
  const tipoRepuesto = elegirOpcion(v.repuestos_tipo, ['venta', 'descarte', 'garantia'] as const);
  x = H.etiqueta('Repuestos requeridos:', M, top + 8) + M + 6;
  x = H.casilla('Venta', tipoRepuesto === 'venta', x, top);
  x = H.casilla('Descarte', tipoRepuesto === 'descarte', x, top);
  H.casilla('Garantía', tipoRepuesto === 'garantia', x, top);
  H.etiqueta('Información de la labor:', xLab, top + 8);
  top += 15;

  const altoFila = 15;
  const altoTabla = 16 + FILAS_REPUESTOS * altoFila;
  H.caja(M, top, anchoRep, altoTabla, 8);
  H.pagina.drawRectangle({ x: M + 0.6, y: H.Y(top + 15), width: anchoRep - 1.2, height: 14.4, color: acento });
  H.caja(M, top, anchoRep, altoTabla, 8); // borde por encima del relleno
  const cCod = M + 8;
  const cDes = M + 82;
  const cCan = M + anchoRep - 34;
  H.texto('CÓDIGO', cCod, top + 10.5, 7, fb, BLANCO);
  H.texto('DESCRIPCIÓN', cDes, top + 10.5, 7, fb, BLANCO);
  H.texto('CANT', cCan, top + 10.5, 7, fb, BLANCO);
  const repuestos = parsearRepuestos(v.codigo_repuesto, v.repuestos_descripcion, v.repuestos_cantidad);
  const visibles = repuestos.length > FILAS_REPUESTOS ? repuestos.slice(0, FILAS_REPUESTOS - 1) : repuestos;
  for (let i = 0; i < FILAS_REPUESTOS; i++) {
    const yb = top + 16 + i * altoFila;
    if (i > 0) H.pagina.drawLine({ start: { x: M + 1, y: H.Y(yb) }, end: { x: M + anchoRep - 1, y: H.Y(yb) }, thickness: 0.4, color: RAYA });
    const rp = visibles[i];
    if (rp) {
      H.ajustado(rp.codigo, cCod, yb + 11, cDes - cCod - 6, 8, f, VALOR);
      H.ajustado(rp.descripcion, cDes, yb + 11, cCan - cDes - 8, 8, f, VALOR);
      H.ajustado(rp.cantidad, cCan + 4, yb + 11, 26, 8, fb, VALOR);
    } else if (i === FILAS_REPUESTOS - 1 && repuestos.length > FILAS_REPUESTOS) {
      H.texto(`+ ${repuestos.length - visibles.length} repuestos más en el anexo`, cDes, yb + 11, 7.5, fi, GRIS);
    }
  }
  if (repuestos.length > FILAS_REPUESTOS) {
    anexo.push({
      titulo: 'Repuestos (lista completa)',
      texto: repuestos.map((r) => `${r.cantidad || '?'} × ${r.descripcion || '(sin descripción)'}${r.codigo ? ` · ${r.codigo}` : ''}`).join('\n'),
    });
  }

  // Información de la labor
  H.caja(xLab, top, anchoLab, altoTabla, 8);
  const campoLabor = (etq: string, valor: string, t: number) => {
    const lw = H.ancho(etq.toUpperCase(), 7.5, fi);
    const bx = xLab + anchoLab - 10 - 66;
    H.texto(etq.toUpperCase(), bx - 6 - lw, t + 11, 7.5, fi);
    H.caja(bx, t, 66, 16, 7);
    H.ajustado(valor, bx + 8, t + 11.5, 52, 9.5, fb, VALOR);
  };
  campoLabor('Hora de llegada cliente', horaParaPdf(v.hora_llegada), top + 8);
  campoLabor('Hora de salida cliente', horaParaPdf(v.hora_salida), top + 30);
  let xl = xLab + anchoLab - 10 - H.ancho('GARANTÍA', 8, fi) - H.ancho('FACTURADO', 8, fi) - 46;
  xl = H.casilla('GARANTÍA', v.garantia !== '' && casillaMarcada(v.garantia), xl, top + 55);
  H.casilla('FACTURADO', v.facturado !== '' && casillaMarcada(v.facturado), xl, top + 55);
  top += altoTabla + 12;

  // ---- Conformidad y firmas ----
  H.envolver(empresa.textoConformidad, f, 7.5, ancho)
    .slice(0, 2)
    .forEach((l, i) => H.texto(l, (H.W - H.ancho(l, 7.5)) / 2, top + 6 + i * 9, 7.5, f, GRIS));
  top += 14;
  const anchoF = (ancho - 50) / 2;
  const lineaFirma = Math.min(top + 62, H.H - 52 - 34);
  const firmas: Array<{ id: string; etq: string; nombre: string }> = [
    { id: 'firma_operador', etq: 'Firma del Operador del Equipo', nombre: v.operador },
    { id: 'firma_cliente', etq: 'Firma del Cliente o Administrador', nombre: '' },
  ];
  for (let i = 0; i < firmas.length; i++) {
    const { id, etq, nombre } = firmas[i];
    const xf = M + i * (anchoF + 50);
    const campo = reporte.campos.find((c) => c.id === id);
    let imagenFirma: PDFImage | null = null;
    // Firma presente según el valor vigente (la IA dijo que hay firma o una persona lo corrigió).
    if (campo && v[id] !== '' && casillaMarcada(v[id])) {
      const region = regionDeCampo(campo);
      const pagina = region ? paginasEscaneo[Math.max(0, region.pagina - 1)] : undefined;
      if (region && pagina) imagenFirma = await incrustar(doc, await recortarFirma(pagina, region));
    }
    if (imagenFirma) {
      const s = imagenFirma.scaleToFit(anchoF - 40, lineaFirma - top - 4);
      H.pagina.drawImage(imagenFirma, { x: xf + (anchoF - s.width) / 2, y: H.Y(lineaFirma - 2), width: s.width, height: s.height });
    }
    H.pagina.drawLine({ start: { x: xf, y: H.Y(lineaFirma) }, end: { x: xf + anchoF, y: H.Y(lineaFirma) }, thickness: 0.7, color: TINTA });
    if (nombre) H.ajustado(nombre, xf + (anchoF - Math.min(H.ancho(nombre, 8.5, fb), anchoF)) / 2, lineaFirma + 11, anchoF, 8.5, fb, VALOR);
    H.texto(etq, xf + (anchoF - H.ancho(etq, 7.5)) / 2, lineaFirma + (nombre ? 21 : 11), 7.5, f, GRIS);
  }

  // ================= ANEXO =================
  const encabezadoAnexo = (titulo: string, sub: string) => {
    H.nueva();
    H.franjaSuperior();
    H.texto(titulo, M, 48, 13, fb);
    H.texto(no, H.W - M - H.ancho(no, 12, fb), 48, 12, fb, ROJO);
    H.ajustado(sub, M, 62, ancho, 8.5, f, GRIS);
  };
  const subtitulo = [v.empresa, v.equipo, fechaParaPdf(v.fecha)].filter(Boolean).join(' · ');

  // Texto que no entró en los recuadros
  if (anexo.length) {
    const limite = H.H - 52 - 18;
    let y = 0;
    const paginaTexto = () => {
      encabezadoAnexo('ANEXO DEL REPORTE', subtitulo);
      y = 78;
    };
    const tituloSeccion = (t: string, nota = '') => {
      if (y + 40 > limite) paginaTexto();
      H.pagina.drawRectangle({ x: M, y: H.Y(y + 16), width: ancho, height: 16, color: rgb(0.95, 0.94, 0.96) });
      H.texto(t.toUpperCase(), M + 8, y + 11.5, 8.5, fb, acento);
      if (nota) H.texto(`(${nota})`, M + 12 + H.ancho(t.toUpperCase(), 8.5, fb), y + 11.5, 8, f, GRIS);
      y += 24;
    };
    paginaTexto();
    for (const sec of anexo) {
      tituloSeccion(sec.titulo);
      for (const l of H.envolver(sec.texto, f, 9.5, ancho)) {
        if (y + 13 > limite) {
          paginaTexto();
          tituloSeccion(sec.titulo, 'continúa');
        }
        H.texto(l, M, y + 10, 9.5, f, VALOR);
        y += 13;
      }
      y += 10;
    }
  }

  // Escaneo original y, si hubo correcciones, el escaneo con ellas dibujadas encima
  const total = paginasEscaneo.length;
  for (let n = 0; n < total; n++) {
    const imagen = await incrustar(doc, paginasEscaneo[n].jpeg);
    if (!imagen) continue;
    encabezadoAnexo(`ANEXO · ESCANEO ORIGINAL${total > 1 ? ` (hoja ${n + 1} de ${total})` : ''}`, subtitulo);
    dibujarEscaneo(H, imagen, paginasEscaneo[n]);
  }
  for (let n = 0; n < total; n++) {
    const cambios = reporte.campos.filter((c) => esCorreccion(c) && (regionDeCampo(c)?.pagina ?? 1) === n + 1);
    if (!cambios.length) continue;
    const imagen = await incrustar(doc, paginasEscaneo[n].jpeg);
    if (!imagen) continue;
    encabezadoAnexo(`ANEXO · ESCANEO CON CORRECCIONES${total > 1 ? ` (hoja ${n + 1} de ${total})` : ''}`, subtitulo);
    const area = dibujarEscaneo(H, imagen, paginasEscaneo[n]);
    for (const c of cambios) dibujarCorreccion(H, area, c);
    H.texto(
      'Recuadro naranja = valor corregido por la persona que revisó · gris = campo dejado en blanco',
      M,
      H.H - 52 - 8,
      7,
      fi,
      GRIS,
    );
  }

  // Pie en todas las páginas
  const paginas = doc.getPages();
  paginas.forEach((pg, i) => {
    H.pagina = pg;
    H.pie(empresa, numero, i + 1, paginas.length);
  });
  return await doc.save();
}

/** Campo que una persona cambió (corregido) o dejó en blanco (ilegible/omitido): se resalta en el anexo. */
export function esCorreccion(c: CampoContrato): boolean {
  const estado = String(c.estado_revision);
  return (estado === 'corregido' && Boolean(c.valor_corregido?.trim())) || ESTADOS_SIN_VALOR.has(estado);
}

interface AreaEscaneo {
  x: number;
  /** Borde superior en coordenadas "desde arriba". */
  top: number;
  w: number;
  h: number;
}

/** Dibuja el escaneo centrado y a escala en la zona libre de la página de anexo. */
function dibujarEscaneo(H: Hoja, imagen: PDFImage, pagina: Pick<PaginaEscaneo, 'ancho' | 'alto'>): AreaEscaneo {
  const topMax = 72;
  const baseMax = H.H - 52 - 18;
  const s = Math.min((H.W - H.M * 2) / pagina.ancho, (baseMax - topMax) / pagina.alto);
  const w = pagina.ancho * s;
  const h = pagina.alto * s;
  const x = (H.W - w) / 2;
  H.pagina.drawImage(imagen, { x, y: H.Y(topMax + h), width: w, height: h });
  H.pagina.drawRectangle({ x, y: H.Y(topMax + h), width: w, height: h, borderColor: RAYA, borderWidth: 0.6 });
  return { x, top: topMax, w, h };
}

/** Recuadro crema con borde naranja y el valor corregido sobre la región del campo (gris "vacío" si quedó en blanco). */
function dibujarCorreccion(H: Hoja, area: AreaEscaneo, campo: CampoContrato): void {
  const region = regionDeCampo(campo);
  if (!region) return;
  const vacio = ESTADOS_SIN_VALOR.has(String(campo.estado_revision));
  const x = area.x + region.x * area.w;
  const top = area.top + region.y * area.h;
  const w = region.ancho * area.w;
  const h = region.alto * area.h;
  const p = H.pagina;
  p.drawRectangle({
    x,
    y: H.Y(top + h),
    width: w,
    height: h,
    color: vacio ? rgb(0.9, 0.9, 0.9) : CREMA,
    borderColor: vacio ? rgb(0.55, 0.55, 0.58) : NARANJA,
    borderWidth: 0.9,
    opacity: 0.95,
  });
  const texto = vacio ? (String(campo.estado_revision) === 'ilegible' ? 'ilegible' : 'vacío') : (campo.valor_corregido ?? '').trim();
  const color = vacio ? GRIS : VALOR;
  const fuente = vacio ? H.fi : H.fb;
  // Se busca el tamaño más grande (hasta 8 pt) con el que el texto entra en el recuadro.
  let tam = 8;
  let lineas: string[] = [];
  for (; tam >= 3.5; tam -= 0.5) {
    lineas = H.envolver(texto, fuente, tam, Math.max(4, w - 3));
    if (lineas.length * tam * 1.15 <= h - 1) break;
  }
  const paso = tam * 1.15;
  lineas.slice(0, Math.max(1, Math.floor((h - 1) / paso))).forEach((l, i) => {
    const base = top + 1 + tam * 0.9 + i * paso + Math.max(0, (h - 1 - lineas.length * paso) / 2);
    H.texto(l, x + 1.5, Math.min(base, top + h - 0.8), tam, fuente, color);
  });
}
