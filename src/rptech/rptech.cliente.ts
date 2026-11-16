/**
 * Envía un reporte histórico revisado a RP-TECH (función importar-historico) y
 * deja el resultado en `reportes` de SIREP. Sin NestJS a propósito: lo usan el
 * servicio (bandeja) y el script de lote (scripts/migrar-revisados-rptech.mjs).
 *
 * Regla clave: `aprobado_rptech` solo se marca cuando RP-TECH confirma que lo
 * guardó (201 creado o 200 ya_existia). Antes se marcaba sin enviar nada.
 */
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FilaReporte } from '../reportes/reportes.mapper';
import { EscaneoEnvio, construirEnvio, tipoDeArchivo } from './rptech.envio';

export const BUCKET_ESCANEOS = 'escaneos-originales';

export interface ConfigRptech {
  url: string;
  clave: string;
}

export type ResultadoEnvio =
  | { estado: 'importado'; rptechId: string; yaExistia: boolean }
  | { estado: 'observado'; codigo: string; detalle: unknown }
  | { estado: 'reintentar'; detalle: string }
  | { estado: 'clave_invalida' };

/** Lee RPTECH_URL y RPTECH_CLAVE. Sin las dos, no se envía nada. */
export function configDesdeEntorno(env: Record<string, string | undefined> = process.env): ConfigRptech | null {
  const url = env.RPTECH_URL?.trim();
  const clave = env.RPTECH_CLAVE?.trim();
  return url && clave ? { url, clave } : null;
}

async function leerEscaneo(client: SupabaseClient, fila: FilaReporte): Promise<EscaneoEnvio | string> {
  const ruta = fila.escaneo?.ruta_original;
  if (!ruta) return 'El reporte no tiene escaneo original';
  const { data, error } = await client.storage.from(BUCKET_ESCANEOS).download(ruta);
  if (error || !data) return `No se pudo descargar el escaneo: ${error?.message ?? 'sin datos'}`;
  const bytes = Buffer.from(await data.arrayBuffer());
  const tipo = tipoDeArchivo(bytes);
  if (!tipo) return 'El escaneo no es PDF, JPG ni PNG';
  return {
    tipo,
    // Se calcula sobre lo que se envía, así coincide siempre con lo que RP-TECH recibe.
    sha256: createHash('sha256').update(bytes).digest('hex'),
    paginas: fila.escaneo?.paginas ?? null,
    contenido_base64: bytes.toString('base64'),
  };
}

/** Hace el POST e interpreta la respuesta según el contrato (sección 6). */
export async function postear(
  cfg: ConfigRptech,
  cuerpo: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<ResultadoEnvio> {
  let res: Response;
  try {
    res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sirep-clave': cfg.clave },
      body: JSON.stringify(cuerpo),
    });
  } catch (e) {
    // Si el archivo pasa de 10 MB, RP-TECH puede cerrar la conexión sin leerlo.
    return { estado: 'reintentar', detalle: `Sin respuesta de RP-TECH: ${(e as Error).message}` };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* respuesta sin JSON */
  }
  if ((res.status === 201 || res.status === 200) && json?.id) {
    return { estado: 'importado', rptechId: String(json.id), yaExistia: res.status === 200 };
  }
  if (res.status === 401) return { estado: 'clave_invalida' };
  if (res.status === 409 || res.status === 422 || res.status === 413) {
    return { estado: 'observado', codigo: json?.codigo ?? `http_${res.status}`, detalle: json?.campos ?? json?.motivo ?? null };
  }
  return { estado: 'reintentar', detalle: `RP-TECH respondió ${res.status} ${json?.codigo ?? ''}`.trim() };
}

/**
 * Envía un reporte y guarda el resultado en SIREP:
 * - importado: aprobado_rptech, bloqueado, importado_en y rptech_id;
 * - observado: estado observado con el motivo en rptech_error, para corregirlo;
 * - reintentar: queda como estaba, con el error en rptech_error;
 * - clave_invalida: no toca el reporte (el problema es la configuración).
 */
export async function enviarReporte(
  client: SupabaseClient,
  fila: FilaReporte,
  cfg: ConfigRptech,
  fetchImpl: typeof fetch = fetch,
): Promise<ResultadoEnvio> {
  const escaneo = await leerEscaneo(client, fila);
  const ahora = new Date().toISOString();
  if (typeof escaneo === 'string') {
    const r: ResultadoEnvio = { estado: 'observado', codigo: 'escaneo', detalle: escaneo };
    await client.from('reportes').update({
      estado_reporte: 'observado',
      rptech_error: { codigo: r.codigo, detalle: r.detalle },
      rptech_enviado_en: ahora,
    }).eq('id', fila.id);
    return r;
  }

  const resultado = await postear(cfg, construirEnvio(fila, escaneo), fetchImpl);

  if (resultado.estado === 'importado') {
    await client.from('reportes').update({
      estado_reporte: 'aprobado_rptech',
      bloqueado: true,
      importado_en: ahora,
      rptech_id: resultado.rptechId,
      rptech_error: null,
      rptech_enviado_en: ahora,
      // Respaldo local de lo leído, como hacía el cierre anterior.
      ...(fila.datos_originales && Object.keys(fila.datos_originales).length > 0
        ? {}
        : { datos_originales: fila.campos_extraidos ?? {} }),
    }).eq('id', fila.id);
    if (fila.escaneo?.id) await client.from('escaneos').update({ estado: 'completo' }).eq('id', fila.escaneo.id);
  } else if (resultado.estado === 'observado') {
    await client.from('reportes').update({
      estado_reporte: 'observado',
      rptech_error: { codigo: resultado.codigo, detalle: resultado.detalle },
      rptech_enviado_en: ahora,
    }).eq('id', fila.id);
  } else if (resultado.estado === 'reintentar') {
    await client.from('reportes').update({
      rptech_error: { codigo: 'reintentar', detalle: resultado.detalle },
      rptech_enviado_en: ahora,
    }).eq('id', fila.id);
  }
  return resultado;
}

/** ¿Este reporte está listo para enviar? Histórico, sin pendientes y aún no importado. */
export function listoParaEnviar(fila: FilaReporte, tienePendientes: boolean): boolean {
  return (
    fila.origen === 'historico' &&
    !tienePendientes &&
    !fila.bloqueado &&
    fila.estado_reporte !== 'aprobado_rptech' &&
    fila.estado_reporte !== 'cerrado'
  );
}
