import { CampoEsperado } from './types';

/** Texto que se guarda como observación cuando un campo opcional está en blanco en el papel. */
export const OBSERVACION_EN_BLANCO = 'En blanco en el papel';

const AFIRMATIVOS = new Set(['true', 'marcado', 'marcada', 'x', 'si', 'sí', 'yes', '1', 'firmado', 'firmada']);

/**
 * Convierte lo que devolvió el modelo para una casilla en booleano. Antes solo se aceptaban
 * "true/marcado/x/si" y un "Sí" con tilde se leía como "No".
 */
export function casillaMarcada(valor: unknown): boolean {
    if (typeof valor === 'boolean') return valor;
    return AFIRMATIVOS.has(String(valor ?? '').toLowerCase().trim());
}

/**
 * Un campo opcional que el modelo declara en blanco ("vacio": true) no es un fallo de lectura:
 * el papel simplemente no lo trae (teléfono, tinta, casillas sin marcar...). Si no se distingue,
 * la bandeja se llena de "no leído" que no hay nada que corregir.
 */
export function esCampoEnBlanco(esperado: CampoEsperado, extraido: any): boolean {
    const sinValor = extraido?.valor === undefined || extraido?.valor === null || extraido?.valor === '';
    return esperado.opcional === true && sinValor && extraido?.vacio === true;
}