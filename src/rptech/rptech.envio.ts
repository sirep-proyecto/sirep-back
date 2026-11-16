/**
 * Arma el JSON que SIREP envía a RP-TECH por cada reporte histórico revisado.
 * Contrato: docs/contrato-historico.md (versión 1). RP-TECH fija el contrato y
 * SIREP adapta su salida: los nombres y valores son los de la tabla `reportes`
 * de RP-TECH, no los del formulario de SIREP.
 *
 * Regla general: ante la duda el campo va vacío y lo leído queda en
 * `datos_originales`. RP-TECH rechaza un valor fuera de su lista; no lo adivina.
 *
 * Funciones puras (sin red ni base) para probarlas sin servicios.
 */
import {
  casillaMarcada,
  normalizarFechaEvaluacion,
  normalizarHoraEvaluacion,
  normalizarTexto,
} from '../ia-extractor/normalizacion';
import { CampoContrato, FilaReporte, construirCampos, valorVigente } from '../reportes/reportes.mapper';

export type TipoEscaneo = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface EscaneoEnvio {
  tipo: TipoEscaneo;
  sha256: string;
  paginas: number | null;
  contenido_base64: string;
}

export interface RepuestoEnvio {
  codigo: string | null;
  descripcion: string;
  cantidad: number;
  tipo: 'venta' | 'descarte' | 'garantia';
}

/** Clave del formulario de SIREP → nombre en el contrato (para `revision_campos`). */
export const NOMBRE_EN_CONTRATO: Record<string, string> = {
  tecnico: 'tecnico_texto',
  empresa: 'cliente_texto',
  fecha: 'fecha',
  telefono: 'telefono_texto',
  direccion: 'direccion_texto',
  contacto: 'contacto_texto',
  equipo: 'equipo_texto',
  motivo: 'motivo',
  estado_del_equipo: 'estado_equipo',
  ultimo_mantenimiento: 'ultimo_mantenimiento',
  limpieza_equipo: 'limpieza',
  cabezales: 'estado_cabezales',
  sistema_proteccion: 'sistema_proteccion',
  tinta: 'tinta',
  revision_linea_ln: 'voltaje_ln',
  revision_linea_lt: 'voltaje_lt',
  revision_linea_nt: 'voltaje_nt',
  operador: 'operador',
  procedimiento: 'procedimiento',
  conclusion: 'conclusion',
  recomendaciones: 'recomendaciones',
  repuestos_tipo: 'repuestos.tipo',
  codigo_repuesto: 'repuestos.codigo',
  repuestos_descripcion: 'repuestos.descripcion',
  repuestos_cantidad: 'repuestos.cantidad',
  hora_llegada: 'hora_llegada',
  hora_salida: 'hora_salida',
  garantia: 'garantia',
  facturado: 'facturado',
  firma_operador: 'firma_operador_presente',
  firma_cliente: 'firma_cliente_presente',
};

/** Detecta el tipo real del archivo por sus primeros bytes (RP-TECH también lo revisa). */
export function tipoDeArchivo(bytes: Uint8Array): TipoEscaneo | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

/** Opción del formulario a uno de los valores permitidos (sin tildes ni mayúsculas). */
export function opcion<T extends string>(valor: string | null, permitidos: readonly T[]): T | null {
  const v = normalizarTexto(valor);
  return (permitidos as readonly string[]).includes(v) ? (v as T) : null;
}

/** «Estab.», «UPS», «estabilizador y UPS», etc. Lo que no encaja va como `otro` con su texto. */
export function sistemaProteccion(valor: string | null): { valor: 'estabilizador' | 'ups' | 'otro' | null; otro: string | null } {
  const texto = (valor ?? '').trim();
  if (!texto) return { valor: null, otro: null };
  const v = normalizarTexto(texto);
  const estab = v.includes('estab');
  const ups = /\bups\b/.test(v);
  if (estab && !ups) return { valor: 'estabilizador', otro: null };
  if (ups && !estab) return { valor: 'ups', otro: null };
  return { valor: 'otro', otro: texto };
}

/** «220», «220V», «220 v», «220,5» → número. Sin número legible, null. */
export function numeroLeido(valor: string | null, min = 0, max = 1000): number | null {
  const m = String(valor ?? '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Fecha real AAAA-MM-DD, o null si el texto no es una fecha («hace 2 meses», «31/02/2025»). */
export function fechaIso(valor: string | null): string | null {
  const f = normalizarFechaEvaluacion(valor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f ? f : null;
}

/** Hora HH:MM de 24 h, o null. */
export function horaHHMM(valor: string | null): string | null {
  const h = normalizarHoraEvaluacion(valor);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(h) ? h : null;
}

/** Casilla de la labor: marcada `si`, sin marcar `no`, ilegible o sin dato `sin_dato`. */
export function siNo(campo: CampoContrato | undefined): 'si' | 'no' | 'sin_dato' {
  if (!campo || campo.estado_revision === 'ilegible') return 'sin_dato';
  const v = valorVigente(campo);
  if (v === null) return 'sin_dato';
  return casillaMarcada(v) ? 'si' : 'no';
}

/** Firma presente: true o false; null si no se pudo saber. */
export function presente(campo: CampoContrato | undefined): boolean | null {
  if (!campo || campo.estado_revision === 'ilegible') return null;
  const v = valorVigente(campo);
  return v === null ? null : casillaMarcada(v);
}

const lineas = (texto: string | null) =>
  String(texto ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, i, todas) => l !== '' || todas.slice(i).some((x) => x.trim() !== ''));

/**
 * La tabla de repuestos del papel: una casilla de tipo para toda la tabla y tres
 * columnas (código, descripción, cantidad) con una línea por fila. La línea N de
 * cada columna forma el repuesto N. Si las columnas no cuadran, no se arma la
 * lista (`ok: false`) y los textos van a `datos_originales`.
 */
export function armarRepuestos(
  tipoTexto: string | null,
  codigos: string | null,
  descripciones: string | null,
  cantidades: string | null,
): { ok: boolean; repuestos: RepuestoEnvio[] } {
  const desc = lineas(descripciones);
  const cods = lineas(codigos);
  const cants = lineas(cantidades);
  if (desc.length === 0 && cods.length === 0 && cants.length === 0) return { ok: true, repuestos: [] };

  const tipo = opcion(tipoTexto, ['venta', 'descarte', 'garantia'] as const);
  if (!tipo || desc.length === 0 || desc.some((d) => d === '')) return { ok: false, repuestos: [] };
  if (cants.length !== desc.length || (cods.length > 0 && cods.length !== desc.length)) return { ok: false, repuestos: [] };

  const repuestos: RepuestoEnvio[] = [];
  for (let i = 0; i < desc.length; i++) {
    const cantidad = numeroLeido(cants[i], 0.001, 1_000_000);
    if (cantidad === null) return { ok: false, repuestos: [] };
    repuestos.push({ codigo: cods[i] || null, descripcion: desc[i], cantidad, tipo });
  }
  return { ok: true, repuestos };
}

/** Arma el envío completo de un reporte histórico ya revisado. */
export function construirEnvio(fila: FilaReporte, escaneo: EscaneoEnvio) {
  const campos = construirCampos(fila.campos_extraidos);
  const porId = new Map(campos.map((c) => [c.id, c]));
  const v = (id: string) => {
    const c = porId.get(id);
    return c ? valorVigente(c) : null;
  };
  const originales: Record<string, string> = {};
  // Guarda lo leído cuando no encaja en el formato del contrato.
  const conRespaldo = <T>(nombre: string, leido: string | null, convertido: T | null): T | null => {
    if (convertido === null && leido !== null && leido.trim() !== '') originales[nombre] = leido;
    return convertido;
  };

  const proteccion = sistemaProteccion(v('sistema_proteccion'));
  const rep = armarRepuestos(v('repuestos_tipo'), v('codigo_repuesto'), v('repuestos_descripcion'), v('repuestos_cantidad'));
  if (!rep.ok) {
    for (const id of ['repuestos_tipo', 'codigo_repuesto', 'repuestos_descripcion', 'repuestos_cantidad']) {
      const leido = v(id);
      if (leido) originales[NOMBRE_EN_CONTRATO[id]] = leido;
    }
  }

  const revision_campos: Record<string, { confianza: string | null; estado: string }> = {};
  for (const c of campos) {
    if (c.estado_revision === 'pendiente') continue;
    revision_campos[NOMBRE_EN_CONTRATO[c.id] ?? c.id] = { confianza: c.confianza, estado: c.estado_revision };
  }

  return {
    version: 1,
    sirep_id: fila.id,
    numero_talonario: fila.numero_talonario ?? null,
    fecha: conRespaldo('fecha', v('fecha'), fechaIso(v('fecha'))),
    cliente_texto: v('empresa'),
    equipo_texto: v('equipo'),
    tecnico_texto: v('tecnico'),
    direccion_texto: v('direccion'),
    contacto_texto: v('contacto'),
    telefono_texto: v('telefono'),
    motivo: v('motivo'),
    estado_equipo: conRespaldo('estado_equipo', v('estado_del_equipo'), opcion(v('estado_del_equipo'), ['operativo', 'inoperativo'] as const)),
    ultimo_mantenimiento: conRespaldo('ultimo_mantenimiento', v('ultimo_mantenimiento'), fechaIso(v('ultimo_mantenimiento'))),
    limpieza: conRespaldo('limpieza', v('limpieza_equipo'), opcion(v('limpieza_equipo'), ['limpio', 'sucio'] as const)),
    estado_cabezales: conRespaldo('estado_cabezales', v('cabezales'), opcion(v('cabezales'), ['bueno', 'regular', 'malo'] as const)),
    sistema_proteccion: proteccion.valor,
    sistema_proteccion_otro: proteccion.otro,
    tinta: v('tinta'),
    voltaje_ln: conRespaldo('voltaje_ln', v('revision_linea_ln'), numeroLeido(v('revision_linea_ln'))),
    voltaje_lt: conRespaldo('voltaje_lt', v('revision_linea_lt'), numeroLeido(v('revision_linea_lt'))),
    voltaje_nt: conRespaldo('voltaje_nt', v('revision_linea_nt'), numeroLeido(v('revision_linea_nt'))),
    operador: v('operador'),
    procedimiento: v('procedimiento'),
    conclusion: v('conclusion'),
    recomendaciones: v('recomendaciones'),
    // El formulario físico no tiene resultado ni requerimiento.
    resultado: null,
    requerimiento: null,
    hora_llegada: conRespaldo('hora_llegada', v('hora_llegada'), horaHHMM(v('hora_llegada'))),
    hora_salida: conRespaldo('hora_salida', v('hora_salida'), horaHHMM(v('hora_salida'))),
    repuestos: rep.repuestos,
    garantia: siNo(porId.get('garantia')),
    facturado: siNo(porId.get('facturado')),
    firma_operador_presente: presente(porId.get('firma_operador')),
    firma_cliente_presente: presente(porId.get('firma_cliente')),
    revision_campos,
    revisado_por: fila.corregido_por ?? null,
    revisado_en: fila.fecha_correccion ?? null,
    datos_originales: originales,
    escaneo,
  };
}

export type EnvioRptech = ReturnType<typeof construirEnvio>;
