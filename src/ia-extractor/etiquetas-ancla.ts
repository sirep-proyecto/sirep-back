/**
 * Responsabilidad: textos impresos del talonario que el modelo debe ubicar en la imagen
 * para que el backend coloque cada campo en su sitio real (ver escaneos/ubicacion.ts).
 * Vive en el paquete de IA, sin dependencias, porque el prompt los necesita.
 */
/**
 * Etiqueta impresa que está a la IZQUIERDA del recuadro de cada campo, en la misma fila,
 * tal como se lee en el papel. Solo campos cuyo recuadro del mapa empieza donde termina
 * la etiqueta (los de casillas incluyen su etiqueta en la región y no sirven de ancla).
 */
export const ETIQUETAS_ANCLA: Readonly<Record<string, string>> = {
  tecnico: 'TECNICO:',
  empresa: 'EMPRESA:',
  fecha: 'FECHA:',
  telefono: 'TELF:',
  direccion: 'DIRECCION:',
  equipo: 'EQUIPO:',
  contacto: 'CONTACTO:',
  motivo: 'MOTIVO:',
  ultimo_mantenimiento: 'ULTIMO MANT.:',
  tinta: 'TINTA:',
  operador: 'OPERADOR:',
  revision_linea_ln: 'L+N',
  revision_linea_lt: 'L+T',
  revision_linea_nt: 'N+T',
  repuestos_tipo: 'REPUESTOS REQUERIDOS:',
  hora_llegada: 'HORA DE LLEGADA CLIENTE',
  hora_salida: 'HORA DE SALIDA CLIENTE',
};
