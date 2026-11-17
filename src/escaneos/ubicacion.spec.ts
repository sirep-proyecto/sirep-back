import { ETIQUETAS_ANCLA } from '../ia-extractor/etiquetas-ancla';
import type { CampoLeido } from '../ia-extractor/types';
import { REGIONES_TALONARIO } from '../reportes/talonario.regiones';
import { Afin, aplicarAfin, calcularUbicacion, EtiquetaEncontrada, ubicarCampos } from './ubicacion';

/** Etiquetas como las daría la IA si la hoja estuviera movida con la transformación `t`. */
function etiquetasCon(t: Afin): EtiquetaEncontrada[] {
  return Object.keys(ETIQUETAS_ANCLA).map((campo) => {
    const r = REGIONES_TALONARIO[campo];
    const ancla = aplicarAfin(t, { x: r.x, y: r.y + r.alto / 2 });
    const ancho = 0.06;
    const alto = 0.012;
    return { campo, caja: { x: ancla.x - ancho, y: ancla.y - alto / 2, ancho, alto } };
  });
}

const campo = (clave: string): CampoLeido => ({ clave, valor: null, confianza: 'alta', noLeido: false });

describe('ubicación de campos por etiquetas impresas', () => {
  const corrida: Afin = { a: 1.02, b: 0.01, c: 0.015, d: -0.008, e: 0.98, f: 0.04 };

  it('recupera la transformación de una hoja corrida, escalada y algo girada', () => {
    const r = calcularUbicacion(etiquetasCon(corrida));
    expect(r).not.toBeNull();
    expect(r!.errorMedio).toBeLessThan(0.001);
    expect(r!.transformacion.c).toBeCloseTo(0.015, 3);
    expect(r!.transformacion.f).toBeCloseTo(0.04, 3);
  });

  it('coloca también un campo vacío sin etiqueta propia (último mant. y procedimiento)', () => {
    const { campos, ubicacion } = ubicarCampos(
      [campo('ultimo_mantenimiento'), campo('procedimiento')],
      etiquetasCon(corrida),
      1,
    );
    expect(ubicacion).not.toBeNull();
    const t = REGIONES_TALONARIO.procedimiento;
    const esperado = aplicarAfin(corrida, { x: t.x, y: t.y });
    const proc = campos.find((c) => c.clave === 'procedimiento')!.caja!;
    expect(Math.abs(proc.y - esperado.y)).toBeLessThan(0.01);
    expect(proc.pagina).toBe(1);
    expect(campos.find((c) => c.clave === 'ultimo_mantenimiento')!.caja).toBeTruthy();
  });

  it('descarta una etiqueta mal ubicada por la IA sin estropear el resto', () => {
    const etiquetas = etiquetasCon(corrida);
    const mala = etiquetas.find((e) => e.campo === 'fecha')!;
    mala.caja = { ...mala.caja, y: mala.caja.y + 0.2 };
    const r = calcularUbicacion(etiquetas);
    expect(r).not.toBeNull();
    expect(r!.anclasUsadas).not.toContain('fecha');
    expect(r!.errorMedio).toBeLessThan(0.002);
  });

  it('respeta la caja de tinta de la IA si cae en la zona, y la reemplaza si cae lejos', () => {
    const cerca: CampoLeido = { ...campo('firma_cliente'), caja: { x: 0.7, y: 0.95, ancho: 0.2, alto: 0.04, pagina: 1 } };
    const lejos: CampoLeido = { ...campo('empresa'), caja: { x: 0.1, y: 0.6, ancho: 0.2, alto: 0.02, pagina: 1 } };
    const { campos } = ubicarCampos([cerca, lejos], etiquetasCon(corrida), 1);
    expect(campos[0].caja).toEqual(cerca.caja);
    expect(campos[1].caja!.y).toBeLessThan(0.3);
  });

  it('no toca nada con pocas etiquetas', () => {
    const pocas = etiquetasCon(corrida).slice(0, 3);
    const entrada = [campo('empresa')];
    const { campos, ubicacion } = ubicarCampos(entrada, pocas, 1);
    expect(ubicacion).toBeNull();
    expect(campos[0]).toEqual(entrada[0]);
  });

  it('rechaza una transformación absurda (etiquetas desordenadas)', () => {
    const etiquetas = etiquetasCon({ a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 }).map((e, i, todas) => ({
      ...e,
      caja: todas[(i * 7) % todas.length].caja,
    }));
    expect(calcularUbicacion(etiquetas)).toBeNull();
  });
});
