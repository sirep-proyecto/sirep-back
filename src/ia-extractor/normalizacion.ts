import * as fs from 'fs';
import * as path from 'path';
import {
  CampoEsperado,
  CampoLeido,
  ClienteRegistrado,
  ContactoRegistrado,
  ContextoAprendizaje,
  CorreccionAprendida,
} from './types';

/** Texto que se guarda como observación cuando un campo opcional está en blanco en el papel. */
export const OBSERVACION_EN_BLANCO = 'En blanco en el papel';

const AFIRMATIVOS = new Set(['true', 'marcado', 'marcada', 'x', 'si', 'sí', 'yes', '1', 'firmado', 'firmada']);

/** Ruta por defecto del dataset portable que persiste al cambiar de base de datos a la original (RP-TECH). */
export const RUTA_DATASET_POR_DEFECTO = path.resolve(process.cwd(), 'data', 'dataset-clientes.json');

export interface EntradaActualizacionDataset {
  empresa?: string | null;
  direccion?: string | null;
  contacto?: string | null;
  telefono?: string | null;
  tecnico?: string | null;
  equipo?: string | null;
  operador?: string | null;
  correccion?: {
    campo: string;
    valorErroneo?: string | null;
    valorCorregido: string;
  } | null;
}

export interface DatasetPersistente {
  version: number;
  actualizadoEn: string;
  clientes: ClienteRegistrado[];
  contactos: ContactoRegistrado[];
  correcciones: CorreccionAprendida[];
  valoresConocidos: Record<string, string[]>;
}

const SEMILLA_DATASET: DatasetPersistente = {
  version: 1,
  actualizadoEn: '2026-11-12T00:00:00.000Z',
  clientes: [],
  contactos: [],
  correcciones: [],
  valoresConocidos: {},
};

function clonarDataset(ds: DatasetPersistente): DatasetPersistente {
  return JSON.parse(JSON.stringify(ds));
}

let datasetMemoria: DatasetPersistente | null = null;

/**
 * Carga el dataset desde el archivo JSON portable (o inicializa desde la semilla base).
 * Garantiza que al cambiar de base de datos a la original (RP-TECH) todo el aprendizaje siga activo.
 */
export function cargarDatasetPersistente(rutaArchivo = RUTA_DATASET_POR_DEFECTO): DatasetPersistente {
  if (rutaArchivo === RUTA_DATASET_POR_DEFECTO && datasetMemoria) {
    return clonarDataset(datasetMemoria);
  }

  let base = clonarDataset(SEMILLA_DATASET);
  try {
    if (fs.existsSync(rutaArchivo)) {
      const contenido = fs.readFileSync(rutaArchivo, 'utf-8');
      const leido = JSON.parse(contenido) as Partial<DatasetPersistente>;
      base = fusionarDatasets(base, leido);
    }
  } catch {
    // Si el archivo no existe o está bloqueado, se opera con la semilla en memoria sin interrumpir el servicio.
  }

  if (rutaArchivo === RUTA_DATASET_POR_DEFECTO) {
    datasetMemoria = clonarDataset(base);
  }
  return base;
}

/** Reinicia la caché en memoria del dataset (útil para pruebas unitarias aisladas). */
export function reiniciarDatasetEnMemoria(usarSoloSemilla = false) {
  datasetMemoria = usarSoloSemilla ? clonarDataset(SEMILLA_DATASET) : null;
}

function agregarUnicoNormalizado(lista: string[], nuevoValor: string, alInicio = false): string[] {
  const limpio = nuevoValor.trim();
  if (!limpio) return lista;
  const normNuevo = normalizarTexto(limpio);
  const existenteIdx = lista.findIndex((item) => normalizarTexto(item) === normNuevo);

  if (existenteIdx !== -1) {
    // Si el nuevo valor es más descriptivo o se pide moverlo al inicio como dirección más reciente
    const valorCan = limpio.length >= lista[existenteIdx].length ? limpio : lista[existenteIdx];
    if (alInicio && existenteIdx > 0) {
      const copia = lista.filter((_, idx) => idx !== existenteIdx);
      return [valorCan, ...copia];
    }
    lista[existenteIdx] = valorCan;
    return lista;
  }

  return alInicio ? [limpio, ...lista] : [...lista, limpio];
}

function fusionarDatasets(base: DatasetPersistente, extra: Partial<DatasetPersistente>): DatasetPersistente {
  const resultado = clonarDataset(base);

  if (Array.isArray(extra.clientes)) {
    for (const cli of extra.clientes) {
      if (!cli?.nombre?.trim()) continue;
      registrarClienteEnObjeto(resultado, cli.nombre, cli.direcciones ?? [], cli.contactos ?? [], cli.direccionPorContacto ?? {});
    }
  }

  if (Array.isArray(extra.contactos)) {
    for (const cont of extra.contactos) {
      if (!cont?.nombre?.trim()) continue;
      registrarContactoEnObjeto(
        resultado,
        cont.nombre,
        cont.empresa,
        cont.direccionPrincipal,
        cont.direcciones ?? [],
        cont.telefono,
      );
    }
  }

  if (Array.isArray(extra.correcciones)) {
    for (const corr of extra.correcciones) {
      if (!corr?.campo || !corr?.valorErroneo || !corr?.valorCorregido) continue;
      registrarCorreccionEnObjeto(resultado, corr.campo, corr.valorErroneo, corr.valorCorregido);
    }
  }

  if (extra.valoresConocidos && typeof extra.valoresConocidos === 'object') {
    for (const [campo, valores] of Object.entries(extra.valoresConocidos)) {
      if (!Array.isArray(valores)) continue;
      if (!resultado.valoresConocidos[campo]) resultado.valoresConocidos[campo] = [];
      for (const v of valores) {
        if (typeof v === 'string' && v.trim()) {
          resultado.valoresConocidos[campo] = agregarUnicoNormalizado(resultado.valoresConocidos[campo], v);
        }
      }
    }
  }

  return resultado;
}

function registrarClienteEnObjeto(
  ds: DatasetPersistente,
  nombreCliente: string,
  direcciones: string[],
  contactos: string[],
  direccionPorContacto: Record<string, string>,
  alInicio = false,
) {
  const limpio = nombreCliente.trim();
  if (!limpio) return;
  const norm = normalizarTexto(limpio);

  let cliente = ds.clientes.find((c) => normalizarTexto(c.nombre) === norm);
  if (!cliente) {
    cliente = {
      nombre: limpio,
      direcciones: [],
      contactos: [],
      direccionPorContacto: {},
    };
    ds.clientes.push(cliente);
  }

  for (const dir of direcciones) {
    if (typeof dir === 'string' && dir.trim()) {
      cliente.direcciones = agregarUnicoNormalizado(cliente.direcciones, dir, alInicio);
      ds.valoresConocidos.direccion = agregarUnicoNormalizado(ds.valoresConocidos.direccion ?? [], dir, alInicio);
    }
  }

  for (const cont of contactos) {
    if (typeof cont === 'string' && cont.trim()) {
      cliente.contactos = agregarUnicoNormalizado(cliente.contactos, cont, alInicio);
      ds.valoresConocidos.contacto = agregarUnicoNormalizado(ds.valoresConocidos.contacto ?? [], cont, alInicio);
    }
  }

  if (!cliente.direccionPorContacto) cliente.direccionPorContacto = {};
  for (const [k, dir] of Object.entries(direccionPorContacto)) {
    const kNorm = normalizarTexto(k);
    if (kNorm && typeof dir === 'string' && dir.trim()) {
      cliente.direccionPorContacto[kNorm] = dir.trim();
    }
  }

  ds.valoresConocidos.empresa = agregarUnicoNormalizado(ds.valoresConocidos.empresa ?? [], limpio, alInicio);
}

function registrarContactoEnObjeto(
  ds: DatasetPersistente,
  nombreContacto: string,
  empresa?: string | null,
  direccionPrincipal?: string | null,
  direccionesExtra: string[] = [],
  telefono?: string | null,
  alInicio = false,
) {
  const limpio = nombreContacto.trim();
  if (!limpio) return;
  const norm = normalizarTexto(limpio);

  let contacto = ds.contactos.find((c) => normalizarTexto(c.nombre) === norm);
  if (!contacto) {
    contacto = {
      nombre: limpio,
      empresa: empresa?.trim() || null,
      direccionPrincipal: direccionPrincipal?.trim() || null,
      direcciones: [],
      telefono: telefono?.trim() || null,
    };
    ds.contactos.push(contacto);
  } else {
    if (empresa?.trim()) contacto.empresa = empresa.trim();
    if (direccionPrincipal?.trim()) contacto.direccionPrincipal = direccionPrincipal.trim();
    if (telefono?.trim()) contacto.telefono = telefono.trim();
  }

  const todasDirecciones = [
    ...(direccionPrincipal?.trim() ? [direccionPrincipal.trim()] : []),
    ...direccionesExtra,
  ];
  for (const dir of todasDirecciones) {
    if (typeof dir === 'string' && dir.trim()) {
      contacto.direcciones = agregarUnicoNormalizado(contacto.direcciones, dir, alInicio);
    }
  }
  if (!contacto.direccionPrincipal && contacto.direcciones.length > 0) {
    contacto.direccionPrincipal = contacto.direcciones[0];
  }

  ds.valoresConocidos.contacto = agregarUnicoNormalizado(ds.valoresConocidos.contacto ?? [], limpio, alInicio);
}

function registrarCorreccionEnObjeto(
  ds: DatasetPersistente,
  campo: string,
  valorErroneo: string,
  valorCorregido: string,
) {
  const errLimpio = valorErroneo.trim();
  const corrLimpio = valorCorregido.trim();
  if (!errLimpio || !corrLimpio) return;
  if (normalizarTexto(errLimpio) === normalizarTexto(corrLimpio)) return;

  const idx = ds.correcciones.findIndex(
    (c) => c.campo === campo && normalizarTexto(c.valorErroneo) === normalizarTexto(errLimpio),
  );
  if (idx !== -1) {
    ds.correcciones[idx].valorCorregido = corrLimpio;
  } else {
    ds.correcciones.unshift({
      campo,
      valorErroneo: errLimpio,
      valorCorregido: corrLimpio,
    });
  }

  if (!ds.valoresConocidos[campo]) ds.valoresConocidos[campo] = [];
  ds.valoresConocidos[campo] = agregarUnicoNormalizado(ds.valoresConocidos[campo], corrLimpio, true);
}

/**
 * Actualiza el dataset cada vez que se edita o confirma un reporte (o se registra un nuevo usuario en `contacto`).
 * Guarda los cambios tanto en memoria como en el archivo JSON portable (`data/dataset-clientes.json`)
 * para que persistan al cambiar a la base de datos original.
 */
export function registrarEdicionEnDataset(
  entrada: EntradaActualizacionDataset,
  opciones: { rutaArchivo?: string; persistirEnDisco?: boolean } = {},
): DatasetPersistente {
  const rutaArchivo = opciones.rutaArchivo ?? RUTA_DATASET_POR_DEFECTO;
  const ds = cargarDatasetPersistente(rutaArchivo);

  const empresa = entrada.empresa?.trim() || null;
  const direccion = entrada.direccion?.trim() || null;
  const contacto = entrada.contacto?.trim() || null;
  const telefono = entrada.telefono?.trim() || null;

  if (empresa) {
    const mapaDirContacto: Record<string, string> = {};
    if (contacto && direccion) {
      mapaDirContacto[normalizarTexto(contacto)] = direccion;
    }
    registrarClienteEnObjeto(
      ds,
      empresa,
      direccion ? [direccion] : [],
      contacto ? [contacto] : [],
      mapaDirContacto,
      true,
    );
  }

  if (contacto) {
    registrarContactoEnObjeto(
      ds,
      contacto,
      empresa,
      direccion,
      direccion ? [direccion] : [],
      telefono,
      true,
    );
  }

  if ( direccion && !empresa && !contacto ) {
    ds.valoresConocidos.direccion = agregarUnicoNormalizado(ds.valoresConocidos.direccion ?? [], direccion, true);
  }

  if (entrada.tecnico?.trim()) {
    ds.valoresConocidos.tecnico = agregarUnicoNormalizado(ds.valoresConocidos.tecnico ?? [], entrada.tecnico.trim(), true);
  }
  if (entrada.equipo?.trim()) {
    ds.valoresConocidos.equipo = agregarUnicoNormalizado(ds.valoresConocidos.equipo ?? [], entrada.equipo.trim(), true);
  }
  if (entrada.operador?.trim()) {
    ds.valoresConocidos.operador = agregarUnicoNormalizado(ds.valoresConocidos.operador ?? [], entrada.operador.trim(), true);
  }

  if (entrada.correccion?.campo && entrada.correccion?.valorCorregido) {
    const { campo, valorErroneo, valorCorregido } = entrada.correccion;
    if (valorErroneo?.trim()) {
      registrarCorreccionEnObjeto(ds, campo, valorErroneo, valorCorregido);
    } else {
      if (!ds.valoresConocidos[campo]) ds.valoresConocidos[campo] = [];
      ds.valoresConocidos[campo] = agregarUnicoNormalizado(ds.valoresConocidos[campo], valorCorregido, true);
    }
  }

  ds.actualizadoEn = new Date().toISOString();

  if (rutaArchivo === RUTA_DATASET_POR_DEFECTO) {
    datasetMemoria = clonarDataset(ds);
  }

  // En pruebas de Jest no se ensucia el archivo de producción salvo que el test indique explícitamente la ruta o persistirEnDisco
  const enJest = Boolean(process.env.JEST_WORKER_ID);
  const debeGuardar = opciones.persistirEnDisco ?? (!enJest || rutaArchivo !== RUTA_DATASET_POR_DEFECTO);

  if (debeGuardar) {
    try {
      fs.mkdirSync(path.dirname(rutaArchivo), { recursive: true });
      fs.writeFileSync(rutaArchivo, JSON.stringify(ds, null, 2), 'utf-8');
    } catch {
      // Si el entorno es de solo lectura, continúa operando con el dataset en memoria.
    }
  }

  return ds;
}

/**
 * Convierte lo que devolvió el modelo para una casilla en booleano. Antes solo se aceptaban
 * "true/marcado/x/si" y un "Sí" con tilde se leía como "No".
 */
export function casillaMarcada(valor: unknown): boolean {
  if (typeof valor === 'boolean') return valor;
  return AFIRMATIVOS.has(String(valor ?? '').toLowerCase().trim());
}

/**
 * Un campo opcional que el modelo declara en blanco ("vacio": true) o que omite del JSON por no
 * tener tinta en el papel no es un fallo de lectura: el papel simplemente no lo trae.
 * Si el modelo indica explícitamente que sí había tinta pero no pudo leerla (noLeido: true o vacio: false),
 * entonces NO está en blanco y debe pasar a revisión.
 */
export function esCampoEnBlanco(esperado: CampoEsperado, extraido: any): boolean {
  if (esperado.opcional !== true) return false;
  if (extraido === undefined || extraido === null) return true;
  const sinValor = extraido.valor === undefined || extraido.valor === null || extraido.valor === '';
  if (!sinValor) return false;
  if (extraido.vacio === false || extraido.noLeido === true) return false;
  return true;
}

/**
 * Campos de texto corto / entidades donde una corrección previa exacta (ej. "Imprenta S0l" -> "Imprenta Sol",
 * "UV DTE" -> "UV DTF") se puede aplicar automáticamente si el modelo vuelve a cometer el mismo error.
 */
const CAMPOS_AUTOCORREGIBLES = new Set([
  'tecnico',
  'empresa',
  'direccion',
  'contacto',
  'equipo',
  'operador',
  'tinta',
  'sistema_proteccion',
]);

/**
 * Busca cuál de las direcciones almacenadas coincide mejor con un fragmento o lectura borrosa
 * (ej. "Av. Industrial 120", "Taller Norte"). Si ninguna coincide, retorna null.
 */
function buscarMejorDireccionAlmacenada(fragmento: string, direcciones: string[]): string | null {
  const fragNorm = normalizarTexto(fragmento);
  if (!fragNorm || direcciones.length === 0) return null;

  // 1. Coincidencia exacta normalizada
  const exacta = direcciones.find((d) => normalizarTexto(d) === fragNorm);
  if (exacta) return exacta;

  // 2. Inclusión directa o por palabras significativas (>= 4 letras o números de 3+ dígitos)
  const palabrasFrag = fragNorm
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 4 || /^\d{3,}$/.test(p))
    .filter((p) => !['jiron', 'avenida', 'calle', 'galeria', 'puerta', 'victoria'].includes(p));

  let mejorCandidata: string | null = null;
  let mejorPuntaje = 0;

  for (const dir of direcciones) {
    const dirNorm = normalizarTexto(dir);
    if (dirNorm.includes(fragNorm) || fragNorm.includes(dirNorm)) {
      return dir;
    }

    let coincidenciasPalabras = 0;
    for (const palabra of palabrasFrag) {
      if (dirNorm.includes(palabra)) {
        coincidenciasPalabras += 1;
      }
    }

    const sim = similitudTexto(fragNorm, dirNorm);
    const puntaje = coincidenciasPalabras > 0 ? Math.max(sim, 0.55 + coincidenciasPalabras * 0.15) : sim;

    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejorCandidata = dir;
    }
  }

  return mejorPuntaje >= 0.45 ? mejorCandidata : null;
}

function buscarContactoEnContexto(
  nombreContacto: string,
  contexto?: ContextoAprendizaje,
): ContactoRegistrado | null {
  const norm = normalizarTexto(nombreContacto);
  if (!norm || !contexto?.contactos?.length) return null;

  const exacto = contexto.contactos.find((c) => normalizarTexto(c.nombre) === norm);
  if (exacto) return exacto;

  let mejor: ContactoRegistrado | null = null;
  let mejorSim = 0;
  for (const c of contexto.contactos) {
    const sim = similitudTexto(norm, c.nombre);
    if (sim >= 0.80 && sim > mejorSim) {
      mejorSim = sim;
      mejor = c;
    }
  }
  return mejor;
}

function buscarClienteEnContexto(
  nombreEmpresa: string,
  contexto?: ContextoAprendizaje,
): ClienteRegistrado | null {
  const norm = normalizarTexto(nombreEmpresa);
  if (!norm || !contexto?.clientes?.length) return null;

  const exacto = contexto.clientes.find((c) => normalizarTexto(c.nombre) === norm);
  if (exacto) return exacto;

  let mejor: ClienteRegistrado | null = null;
  let mejorSim = 0;
  for (const c of contexto.clientes) {
    const sim = similitudTexto(norm, c.nombre);
    if (sim >= 0.80 && sim > mejorSim) {
      mejorSim = sim;
      mejor = c;
    }
  }
  return mejor;
}

/**
 * Aplica las correcciones aprendidas de revisiones humanas anteriores sobre los campos leídos
 * y resuelve la `direccion` del local cuando no se ve bien en la boleta utilizando el `contacto`
 * (para saber a cuál dirección almacenada concurre ese contacto) y/o el nombre del cliente (`empresa`).
 */
export function aplicarCorreccionesAprendidas(
  campos: CampoLeido[],
  contexto?: ContextoAprendizaje,
): CampoLeido[] {
  if (!contexto) return campos;
  const correcciones = contexto.correcciones ?? [];

  // 1. Correcciones directas de palabras/OCR (ej. "Imprenta S0l" -> "Imprenta Sol")
  const corregidos = campos.map((campo) => {
    if (
      campo.noLeido ||
      typeof campo.valor !== 'string' ||
      !campo.valor.trim() ||
      !CAMPOS_AUTOCORREGIBLES.has(campo.clave)
    ) {
      return campo;
    }

    const valorNorm = normalizarTexto(campo.valor);
    const coincidencia = correcciones.find(
      (c) => c.campo === campo.clave && normalizarTexto(c.valorErroneo) === valorNorm,
    );
    if (!coincidencia) return campo;

    return {
      ...campo,
      valor: coincidencia.valorCorregido,
    };
  });

  // 2. Resolución relacional: Contacto -> Dirección del local y Cliente -> Dirección del local
  const idxDireccion = corregidos.findIndex((c) => c.clave === 'direccion');
  const idxContacto = corregidos.findIndex((c) => c.clave === 'contacto');
  const idxEmpresa = corregidos.findIndex((c) => c.clave === 'empresa');

  const campoContacto = idxContacto !== -1 ? corregidos[idxContacto] : undefined;
  const valorContacto =
    campoContacto && !campoContacto.noLeido && typeof campoContacto.valor === 'string'
      ? campoContacto.valor.trim()
      : '';
  const contactoReg = valorContacto ? buscarContactoEnContexto(valorContacto, contexto) : null;

  // Si el nombre del contacto se leyó con una leve variación, normalizarlo al nombre registrado
  if (contactoReg && idxContacto !== -1 && normalizarTexto(valorContacto) !== normalizarTexto(contactoReg.nombre)) {
    corregidos[idxContacto] = {
      ...corregidos[idxContacto],
      valor: contactoReg.nombre,
    };
  }

  // Si la empresa no se pudo leer o está dudosa, pero tenemos un contacto registrado que pertenece a una empresa:
  if (idxEmpresa !== -1 && contactoReg?.empresa) {
    const empActual = corregidos[idxEmpresa];
    const empVaciaODudosa =
      empActual.noLeido ||
      !empActual.valor ||
      String(empActual.valor).trim() === '' ||
      empActual.dudoso ||
      empActual.confianza === 'baja';
    if (empVaciaODudosa) {
      corregidos[idxEmpresa] = {
        ...empActual,
        valor: contactoReg.empresa,
        noLeido: false,
        dudoso: false,
        confianza: empActual.noLeido ? 'media' : empActual.confianza,
        observacion: `Cliente asociado al contacto registrado "${contactoReg.nombre}"`,
      };
    }
  }

  if (idxDireccion === -1) return corregidos;

  const campoEmpresa = idxEmpresa !== -1 ? corregidos[idxEmpresa] : undefined;
  const valorEmpresa =
    campoEmpresa && !campoEmpresa.noLeido && typeof campoEmpresa.valor === 'string'
      ? campoEmpresa.valor.trim()
      : '';
  const clienteReg =
    buscarClienteEnContexto(valorEmpresa, contexto) ||
    (contactoReg?.empresa ? buscarClienteEnContexto(contactoReg.empresa, contexto) : null);

  const dirActual = corregidos[idxDireccion];
  const textoDirLeido =
    !dirActual.noLeido && typeof dirActual.valor === 'string' ? dirActual.valor.trim() : '';

  const direccionNoSeVeBien =
    dirActual.noLeido ||
    !textoDirLeido ||
    Boolean(dirActual.dudoso) ||
    dirActual.confianza === 'baja' ||
    dirActual.confianza === 'media';

  // Prioridad A: Resolver dirección usando el CONTACTO registrado (a cuál dirección concurre este contacto)
  if (contactoReg) {
    const dirDelClienteParaContacto =
      clienteReg?.direccionPorContacto?.[normalizarTexto(contactoReg.nombre)];
    const candidatosContacto = [
      ...(dirDelClienteParaContacto ? [dirDelClienteParaContacto] : []),
      ...(contactoReg.direccionPrincipal ? [contactoReg.direccionPrincipal] : []),
      ...(contactoReg.direcciones ?? []),
      ...(clienteReg?.direcciones ?? []),
    ];

    if (textoDirLeido) {
      // Si hay un trazo parcial en dirección, desempata entre las direcciones del contacto
      const coincidenciaParcial = buscarMejorDireccionAlmacenada(textoDirLeido, candidatosContacto);
      if (coincidenciaParcial && (direccionNoSeVeBien || normalizarTexto(coincidenciaParcial) !== normalizarTexto(textoDirLeido))) {
        corregidos[idxDireccion] = {
          ...dirActual,
          valor: coincidenciaParcial,
          noLeido: false,
          dudoso: false,
          confianza: dirActual.confianza === 'baja' ? 'media' : dirActual.confianza,
          observacion: `Dirección completada según local al que concurre el contacto "${contactoReg.nombre}"`,
        };
        return corregidos;
      }
    }

    if (direccionNoSeVeBien) {
      const dirPreferidaContacto =
        dirDelClienteParaContacto || contactoReg.direccionPrincipal || contactoReg.direcciones?.[0];
      if (dirPreferidaContacto) {
        corregidos[idxDireccion] = {
          ...dirActual,
          valor: dirPreferidaContacto,
          noLeido: false,
          dudoso: false,
          confianza: dirActual.noLeido || dirActual.confianza === 'baja' ? 'media' : dirActual.confianza,
          observacion: `Dirección inferida por contacto registrado "${contactoReg.nombre}"`,
        };
        return corregidos;
      }
    }
  }

  // Prioridad B: Resolver dirección usando el CLIENTE (`empresa`) cuando no hay contacto o el contacto es nuevo
  if (clienteReg && clienteReg.direcciones.length > 0) {
    if (textoDirLeido) {
      const coincidenciaCliente = buscarMejorDireccionAlmacenada(textoDirLeido, clienteReg.direcciones);
      if (
        coincidenciaCliente &&
        (direccionNoSeVeBien ||
          (textoDirLeido.length < coincidenciaCliente.length &&
            normalizarTexto(coincidenciaCliente).includes(normalizarTexto(textoDirLeido))))
      ) {
        corregidos[idxDireccion] = {
          ...dirActual,
          valor: coincidenciaCliente,
          noLeido: false,
          dudoso: false,
          confianza: dirActual.confianza === 'baja' ? 'media' : dirActual.confianza,
          observacion: `Dirección completada según local registrado del cliente "${clienteReg.nombre}"`,
        };
        return corregidos;
      }
    }

    if (direccionNoSeVeBien && (!textoDirLeido || dirActual.noLeido || dirActual.confianza === 'baja')) {
      corregidos[idxDireccion] = {
        ...dirActual,
        valor: clienteReg.direcciones[0],
        noLeido: false,
        dudoso: false,
        confianza: 'media',
        observacion: `Dirección sugerida según local principal del cliente "${clienteReg.nombre}"`,
      };
    }
  }

  return corregidos;
}

/**
 * Extrae correcciones aprendidas, clientes, direcciones de locales y contactos registrados
 * combinando el dataset portable (`data/dataset-clientes.json`) con las filas de `reportes`
 * (y `dataset_clientes` si existe) de la base de datos conectada.
 */
export function construirContextoDesdeReportes(
  filas: Array<{
    cliente?: string | null;
    tecnico_asignado?: string | null;
    serie_equipo?: string | null;
    direccion?: string | null;
    contacto?: string | null;
    telefono?: string | null;
    operador?: string | null;
    campos_extraidos?: Record<string, any> | null;
  }> = [],
  filasDatasetTabla: Array<{
    nombre_cliente?: string | null;
    direcciones?: string[] | null;
    contactos?: string[] | null;
    direccion_por_contacto?: Record<string, string> | null;
    correcciones?: CorreccionAprendida[] | null;
  }> = [],
): ContextoAprendizaje {
  const ds = cargarDatasetPersistente();

  // 1. Incorporar filas de la tabla `dataset_clientes` si existen en la BD conectada
  for (const filaCat of filasDatasetTabla) {
    if (filaCat?.nombre_cliente) {
      const dirs = Array.isArray(filaCat.direcciones) ? filaCat.direcciones : [];
      const conts = Array.isArray(filaCat.contactos) ? filaCat.contactos : [];
      const mapa =
        filaCat.direccion_por_contacto && typeof filaCat.direccion_por_contacto === 'object'
          ? filaCat.direccion_por_contacto
          : {};
      registrarClienteEnObjeto(ds, filaCat.nombre_cliente, dirs, conts, mapa);
      for (const c of conts) {
        const dirAsoc = mapa[normalizarTexto(c)] || dirs[0] || null;
        registrarContactoEnObjeto(ds, c, filaCat.nombre_cliente, dirAsoc, dirs);
      }
    }
    if (Array.isArray(filaCat?.correcciones)) {
      for (const corr of filaCat.correcciones) {
        if (corr?.campo && corr?.valorErroneo && corr?.valorCorregido) {
          registrarCorreccionEnObjeto(ds, corr.campo, corr.valorErroneo, corr.valorCorregido);
        }
      }
    }
  }

  // 2. Incorporar el historial vivo de `reportes` (recorriendo del más antiguo al más reciente para que lo último mande)
  const filasOrdenadas = [...filas].reverse();
  for (const fila of filasOrdenadas) {
    const extraidos = fila.campos_extraidos && typeof fila.campos_extraidos === 'object' ? fila.campos_extraidos : {};

    const obtenerValorCampo = (clave: string, valorColumna?: string | null): string | null => {
      if (typeof valorColumna === 'string' && valorColumna.trim()) return valorColumna.trim();
      const dato = extraidos[clave];
      if (!dato || typeof dato !== 'object') return null;
      if (dato.revision?.estado === 'ilegible' || dato.revision?.estado === 'omitido') return null;
      if (typeof dato.revision?.valor_corregido === 'string' && dato.revision.valor_corregido.trim()) {
        return dato.revision.valor_corregido.trim();
      }
      if (!dato.noLeido && typeof dato.valor === 'string' && dato.valor.trim()) {
        return dato.valor.trim();
      }
      return null;
    };

    const empresaVig = obtenerValorCampo('empresa', fila.cliente);
    const direccionVig = obtenerValorCampo('direccion', fila.direccion);
    const contactoVig = obtenerValorCampo('contacto', fila.contacto);
    const telefonoVig = obtenerValorCampo('telefono', fila.telefono);
    const tecnicoVig = obtenerValorCampo('tecnico', fila.tecnico_asignado);
    const equipoVig = obtenerValorCampo('equipo', fila.serie_equipo);
    const operadorVig = obtenerValorCampo('operador', fila.operador);

    if (empresaVig) {
      const mapa: Record<string, string> = {};
      if (contactoVig && direccionVig) {
        mapa[normalizarTexto(contactoVig)] = direccionVig;
      }
      registrarClienteEnObjeto(
        ds,
        empresaVig,
        direccionVig ? [direccionVig] : [],
        contactoVig ? [contactoVig] : [],
        mapa,
        true,
      );
    }

    if (contactoVig) {
      registrarContactoEnObjeto(
        ds,
        contactoVig,
        empresaVig,
        direccionVig,
        direccionVig ? [direccionVig] : [],
        telefonoVig,
        true,
      );
    }

    if (direccionVig) {
      ds.valoresConocidos.direccion = agregarUnicoNormalizado(ds.valoresConocidos.direccion ?? [], direccionVig, true);
    }
    if (tecnicoVig) {
      ds.valoresConocidos.tecnico = agregarUnicoNormalizado(ds.valoresConocidos.tecnico ?? [], tecnicoVig, true);
    }
    if (equipoVig) {
      ds.valoresConocidos.equipo = agregarUnicoNormalizado(ds.valoresConocidos.equipo ?? [], equipoVig, true);
    }
    if (operadorVig) {
      ds.valoresConocidos.operador = agregarUnicoNormalizado(ds.valoresConocidos.operador ?? [], operadorVig, true);
    }

    // Extraer correcciones puntuales humano vs modelo de `campos_extraidos`
    for (const [clave, datos] of Object.entries(extraidos)) {
      if (!datos || typeof datos !== 'object') continue;
      const rev = datos.revision;
      if (rev?.estado === 'corregido' && typeof rev.valor_corregido === 'string') {
        const corregido = rev.valor_corregido.trim();
        if (corregido) {
          if (!ds.valoresConocidos[clave]) ds.valoresConocidos[clave] = [];
          ds.valoresConocidos[clave] = agregarUnicoNormalizado(ds.valoresConocidos[clave], corregido, true);
          const original = typeof datos.valor === 'string' ? datos.valor.trim() : '';
          if (original && normalizarTexto(original) !== normalizarTexto(corregido)) {
            registrarCorreccionEnObjeto(ds, clave, original, corregido);
          }
        }
      } else if (rev?.estado === 'confirmado' && typeof datos.valor === 'string' && datos.valor.trim()) {
        if (!ds.valoresConocidos[clave]) ds.valoresConocidos[clave] = [];
        ds.valoresConocidos[clave] = agregarUnicoNormalizado(ds.valoresConocidos[clave], datos.valor.trim(), true);
      }
    }
  }

  return {
    correcciones: ds.correcciones.slice(0, 60),
    valoresConocidos: ds.valoresConocidos,
    clientes: ds.clientes,
    contactos: ds.contactos,
  };
}

/**
 * Normaliza un texto para comparación:
 * - Convierte a minúsculas
 * - Remueve tildes y diacríticos
 * - Colapsa espacios múltiples y quita espacios en extremos
 */
export function normalizarTexto(texto: unknown): string {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Normaliza una fecha al formato estándar AAAA-MM-DD.
 * Soporta formatos: DD/MM/AAAA, DD-MM-AAAA, AAAA-MM-DD, DD/MM/AA, etc.
 */
export function normalizarFechaEvaluacion(valor: unknown): string {
  if (!valor) return '';
  const str = String(valor).trim();
  if (!str) return '';

  // Formato AAAA-MM-DD
  const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    const [, a, m, d] = isoMatch;
    return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Formato DD/MM/AAAA o DD-MM-AAAA
  const latamMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (latamMatch) {
    const [, d, m, a] = latamMatch;
    return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Formato DD/MM/AA
  const cortoMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (cortoMatch) {
    const [, d, m, yy] = cortoMatch;
    const a = Number(yy) < 50 ? `20${yy}` : `19${yy}`;
    return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return normalizarTexto(str);
}

/**
 * Normaliza una hora al formato estándar HH:MM (24h).
 * Soporta formatos: H:MM, HH:MM, HH:MM:SS, con AM/PM opcional.
 */
export function normalizarHoraEvaluacion(valor: unknown): string {
  if (!valor) return '';
  const str = String(valor).trim();
  if (!str) return '';

  const ampmMatch = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (ampmMatch) {
    let horas = parseInt(ampmMatch[1], 10);
    const minutos = ampmMatch[2];
    const periodo = ampmMatch[3]?.toLowerCase();

    if (periodo) {
      const esPm = periodo.includes('p');
      if (esPm && horas < 12) horas += 12;
      if (!esPm && horas === 12) horas = 0;
    }

    return `${String(horas).padStart(2, '0')}:${minutos}`;
  }

  return normalizarTexto(str);
}

/**
 * Calcula el coeficiente de similitud de Dice / Sørensen entre dos textos.
 * Retorna un valor entre 0 (totalmente diferente) y 1 (idénticos).
 */
export function similitudTexto(a: string, b: string): number {
  const normA = normalizarTexto(a);
  const normB = normalizarTexto(b);

  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;
  if (normA.length < 2 || normB.length < 2) return normA === normB ? 1.0 : 0.0;

  const obtenerBigramas = (str: string): Map<string, number> => {
    const bigramas = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bigrama = str.substring(i, i + 2);
      bigramas.set(bigrama, (bigramas.get(bigrama) || 0) + 1);
    }
    return bigramas;
  };

  const bigramasA = obtenerBigramas(normA);
  const bigramasB = obtenerBigramas(normB);

  let interseccion = 0;
  for (const [bigrama, countA] of bigramasA.entries()) {
    if (bigramasB.has(bigrama)) {
      interseccion += Math.min(countA, bigramasB.get(bigrama)!);
    }
  }

  const total = (normA.length - 1) + (normB.length - 1);
  return total === 0 ? 0 : (2.0 * interseccion) / total;
}

export type ResultadoComparacion =
  | 'correcto'
  | 'error'
  | 'no leído'
  | 'vacío correcto'
  | 'dudoso'
  | 'sin referencia';

export interface EvaluacionCampo {
  resultado: ResultadoComparacion;
  valorEsperado: string;
  valorLeido: string;
  similitud?: number;
}

/**
 * Compara el valor extraído por el modelo contra la plantilla de referencia manual.
 * Aplica las reglas del Sprint 3 (SIREP-S3-T15):
 * - Si falta el valor de control en la plantilla de referencia, el campo se marca "sin referencia"
 *   y NO se usa el valor del modelo como si fuera correcto.
 * - "vacío" o en blanco esperado vs noLeido/vacio => vacío correcto
 * - "ilegible" esperado vs noLeido => correcto
 * - Formatos normalizados para fecha y hora
 * - Similitud de texto con umbral para texto libre (procedimiento, conclusión, recomendaciones)
 */
export function compararCampo(
  clave: string,
  tipo: string,
  valorEsperadoRaw: unknown,
  valorLeidoRaw: unknown,
  noLeido: boolean,
): EvaluacionCampo {
  const valorLeidoStr = valorLeidoRaw === null || valorLeidoRaw === undefined ? '' : String(valorLeidoRaw).trim();
  const leidoNorm = normalizarTexto(valorLeidoRaw);
  const esVacioLeido = noLeido || leidoNorm === '' || leidoNorm === 'null' || leidoNorm === 'undefined';

  // SIREP-S3-T15: Si la plantilla de control no tiene valor (undefined o null), se marca "sin referencia"
  if (valorEsperadoRaw === undefined || valorEsperadoRaw === null) {
    return {
      resultado: 'sin referencia',
      valorEsperado: '(sin referencia)',
      valorLeido: esVacioLeido ? '(vacío)' : valorLeidoStr,
    };
  }

  const esperadoNorm = normalizarTexto(valorEsperadoRaw);
  const esVacioEsperado = esperadoNorm === '' || esperadoNorm === 'vacio' || esperadoNorm === 'vacío' || esperadoNorm === 'n/a';
  const esIlegibleEsperado = esperadoNorm === 'ilegible';

  const valorEsperadoStr = String(valorEsperadoRaw ?? '').trim();

  // Caso 1: Se esperaba vacío en el papel
  if (esVacioEsperado) {
    if (esVacioLeido) {
      return { resultado: 'vacío correcto', valorEsperado: valorEsperadoStr || 'vacío', valorLeido: valorLeidoStr || '(vacío)' };
    }
    return { resultado: 'error', valorEsperado: valorEsperadoStr || 'vacío', valorLeido: valorLeidoStr };
  }

  // Caso 2: Se esperaba ilegible en el papel
  if (esIlegibleEsperado) {
    if (noLeido || esVacioLeido) {
      return { resultado: 'correcto', valorEsperado: valorEsperadoStr, valorLeido: 'no leído' };
    }
    return { resultado: 'dudoso', valorEsperado: valorEsperadoStr, valorLeido: valorLeidoStr };
  }

  // Caso 3: El modelo no leyó pero había un valor esperado
  if (esVacioLeido) {
    return { resultado: 'no leído', valorEsperado: valorEsperadoStr, valorLeido: '(no leído)' };
  }

  // Caso 4: Tipo fecha
  if (tipo === 'fecha') {
    const fEsp = normalizarFechaEvaluacion(valorEsperadoRaw);
    const fLei = normalizarFechaEvaluacion(valorLeidoRaw);
    return {
      resultado: fEsp === fLei ? 'correcto' : 'error',
      valorEsperado: fEsp,
      valorLeido: fLei,
    };
  }

  // Caso 5: Tipo hora
  if (tipo === 'hora') {
    const hEsp = normalizarHoraEvaluacion(valorEsperadoRaw);
    const hLei = normalizarHoraEvaluacion(valorLeidoRaw);
    return {
      resultado: hEsp === hLei ? 'correcto' : 'error',
      valorEsperado: hEsp,
      valorLeido: hLei,
    };
  }

  // Caso 6: Texto libre extenso (procedimiento, conclusion, recomendaciones)
  const esTextoLibre = ['procedimiento', 'conclusion', 'recomendaciones', 'motivo'].includes(clave);
  if (esTextoLibre) {
    const score = similitudTexto(String(valorEsperadoRaw), String(valorLeidoRaw));
    let res: ResultadoComparacion = 'error';
    if (score >= 0.82) {
      res = 'correcto';
    } else if (score >= 0.50) {
      res = 'dudoso'; // Marcar para revisión humana
    }
    return {
      resultado: res,
      valorEsperado: valorEsperadoStr,
      valorLeido: valorLeidoStr,
      similitud: Math.round(score * 100) / 100,
    };
  }

  // Caso 7: Comparación directa normalizada (sin tildes, minúsculas, espacios colapsados)
  const coincide = normalizarTexto(valorEsperadoRaw) === normalizarTexto(valorLeidoRaw);
  return {
    resultado: coincide ? 'correcto' : 'error',
    valorEsperado: valorEsperadoStr,
    valorLeido: valorLeidoStr,
  };
}
