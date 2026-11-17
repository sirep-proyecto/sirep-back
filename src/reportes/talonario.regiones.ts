/**
 * Responsabilidad: mapa fijo de regiones del talonario "Reporte técnico" de GO Service
 * Latam (carta, una cara) para el backend.
 * Existe para recortar la firma y dibujar las correcciones sobre el escaneo en el PDF
 * cuando el modelo no informó la zona de un campo (`campo.region`). Es una copia de
 * `sirep-front/app/src/config/regiones/talonario-go-service-carta.ts`: si se recalibra
 * allá, se debe actualizar aquí también.
 *
 * Coordenadas normalizadas 0–1 sobre un escaneo plano y completo de 1275 × 1650 px.
 * LIMITACIÓN: son fijas; con fotos inclinadas o mal encuadradas el recorte se desplaza.
 */
import { RegionContrato } from './reportes.mapper';

const r = (x: number, y: number, ancho: number, alto: number): RegionContrato => ({ x, y, ancho, alto, pagina: 1 });

export const REGIONES_TALONARIO: Readonly<Record<string, RegionContrato>> = {
  tecnico: r(0.7, 0.145, 0.228, 0.023),
  empresa: r(0.152, 0.2085, 0.43, 0.0215),
  fecha: r(0.64, 0.2085, 0.115, 0.0215),
  direccion: r(0.158, 0.236, 0.536, 0.0215),
  equipo: r(0.762, 0.236, 0.166, 0.0215),
  motivo: r(0.561, 0.262, 0.368, 0.0205),
  estado_del_equipo: r(0.075, 0.347, 0.345, 0.021),
  procedimiento: r(0.065, 0.423, 0.862, 0.183),
  conclusion: r(0.065, 0.617, 0.862, 0.054),
  recomendaciones: r(0.065, 0.683, 0.862, 0.054),
  codigo_repuesto: r(0.065, 0.7985, 0.122, 0.0625),
  hora_llegada: r(0.812, 0.782, 0.112, 0.022),
  hora_salida: r(0.812, 0.809, 0.112, 0.022),
  telefono: r(0.804, 0.2085, 0.122, 0.0215),
  contacto: r(0.156, 0.262, 0.32, 0.0205),
  ultimo_mantenimiento: r(0.513, 0.345, 0.112, 0.022),
  limpieza_equipo: r(0.631, 0.345, 0.297, 0.022),
  cabezales: r(0.075, 0.369, 0.295, 0.022),
  sistema_proteccion: r(0.436, 0.369, 0.312, 0.022),
  tinta: r(0.8, 0.369, 0.126, 0.022),
  revision_linea_ln: r(0.258, 0.397, 0.078, 0.021),
  revision_linea_lt: r(0.366, 0.397, 0.08, 0.021),
  revision_linea_nt: r(0.475, 0.397, 0.08, 0.021),
  operador: r(0.64, 0.397, 0.285, 0.021),
  repuestos_tipo: r(0.235, 0.743, 0.275, 0.024),
  repuestos_descripcion: r(0.19, 0.791, 0.29, 0.095),
  repuestos_cantidad: r(0.478, 0.791, 0.064, 0.095),
  garantia: r(0.705, 0.859, 0.095, 0.026),
  facturado: r(0.815, 0.859, 0.112, 0.026),
  firma_operador: r(0.075, 0.925, 0.38, 0.055),
  firma_cliente: r(0.685, 0.895, 0.24, 0.09),
};
