import { CampoEsperado } from '../ia-extractor/types';

/**
 * Campos del formulario físico de GO Service Latam que se le piden al modelo.
 * Vive aparte del servicio porque lo usan tres piezas que deben coincidir: lo que
 * se le pide al modelo, lo que se guarda en `reportes` y lo que la bandeja de
 * revisión muestra y recorta. Agregar un campo aquí obliga a agregarlo también en
 * el inventario del frontend (`campos-formulario.ts`) y en su mapa de regiones.
 */
export const CAMPOS_FORMULARIO: readonly CampoEsperado[] = [
  { clave: 'tecnico', tipo: 'texto', descripcion: 'Nombre del técnico' },
  { clave: 'empresa', tipo: 'texto', descripcion: 'Nombre del cliente o empresa atendida' },
  { clave: 'fecha', tipo: 'fecha', descripcion: 'Fecha de atención en el reporte' },
  { clave: 'direccion', tipo: 'texto', descripcion: 'Dirección de la empresa' },
  { clave: 'equipo', tipo: 'texto', descripcion: 'Modelo y marca del equipo técnico' },
  { clave: 'motivo', tipo: 'texto', descripcion: 'Motivo de la orden de servicio' },
  { clave: 'estado_del_equipo', tipo: 'casilla', descripcion: 'Operativo o Inoperativo' },
  { clave: 'procedimiento', tipo: 'texto', descripcion: 'Descripción detallada del trabajo realizado' },
  { clave: 'conclusion', tipo: 'texto', descripcion: 'Conclusión técnica final' },
  { clave: 'recomendaciones', tipo: 'texto', descripcion: 'Recomendaciones para el cliente' },
  { clave: 'codigo_repuesto', tipo: 'texto', descripcion: 'Código o número de parte de repuestos usados' },
  { clave: 'hora_llegada', tipo: 'hora', descripcion: 'Hora de ingreso del técnico' },
  { clave: 'hora_salida', tipo: 'hora', descripcion: 'Hora de salida del técnico' },
];

export const IDS_CAMPOS_FORMULARIO: readonly string[] = CAMPOS_FORMULARIO.map((c) => c.clave);
