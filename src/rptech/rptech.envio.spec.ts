import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { CampoGuardado, FilaReporte } from '../reportes/reportes.mapper';
import {
  armarRepuestos,
  construirEnvio,
  fechaIso,
  horaHHMM,
  numeroLeido,
  opcion,
  sistemaProteccion,
  tipoDeArchivo,
} from './rptech.envio';

const ESCANEO = { tipo: 'application/pdf' as const, sha256: 'a'.repeat(64), paginas: 1, contenido_base64: 'JVBERi0=' };

function fila(valores: Record<string, unknown>, extra: Partial<FilaReporte> = {}): FilaReporte {
  const campos: Record<string, CampoGuardado> = Object.fromEntries(
    IDS_CAMPOS_FORMULARIO.map((id) => [id, { clave: id, valor: valores[id] ?? null, confianza: 'alta', noLeido: false, dudoso: false }]),
  );
  return {
    id: 'sirep-1',
    numero_talonario: '004512',
    origen: 'historico',
    cliente: null,
    fecha: null,
    serie_equipo: null,
    tecnico_asignado: null,
    campos_extraidos: campos,
    creado_en: '2026-11-16T10:00:00Z',
    actualizado_en: '2026-11-16T10:00:00Z',
    corregido_por: 'Miguel',
    fecha_correccion: '2026-11-16T15:30:00Z',
    ...extra,
  };
}

describe('Conversión al contrato de RP-TECH', () => {
  it('opciones a los valores de RP-TECH', () => {
    expect(opcion('Operativo', ['operativo', 'inoperativo'])).toBe('operativo');
    expect(opcion('Garantía', ['venta', 'descarte', 'garantia'])).toBe('garantia');
    expect(opcion('funciona', ['operativo', 'inoperativo'])).toBeNull();
  });

  it('sistema de protección', () => {
    expect(sistemaProteccion('Estab.')).toEqual({ valor: 'estabilizador', otro: null });
    expect(sistemaProteccion('UPS')).toEqual({ valor: 'ups', otro: null });
    expect(sistemaProteccion('Estab. y UPS')).toEqual({ valor: 'otro', otro: 'Estab. y UPS' });
    expect(sistemaProteccion('pozo a tierra')).toEqual({ valor: 'otro', otro: 'pozo a tierra' });
    expect(sistemaProteccion('')).toEqual({ valor: null, otro: null });
  });

  it('voltajes como número', () => {
    expect(numeroLeido('220')).toBe(220);
    expect(numeroLeido('220V')).toBe(220);
    expect(numeroLeido('1,5 v')).toBe(1.5);
    expect(numeroLeido('sin medir')).toBeNull();
    expect(numeroLeido('5000')).toBeNull();
  });

  it('fechas y horas', () => {
    expect(fechaIso('14/08/2025')).toBe('2025-08-14');
    expect(fechaIso('03/02/26')).toBe('2026-02-03');
    expect(fechaIso('31/02/2025')).toBeNull();
    expect(fechaIso('hace 2 meses')).toBeNull();
    expect(horaHHMM('10:05')).toBe('10:05');
    expect(horaHHMM('2:40 pm')).toBe('14:40');
    expect(horaHHMM('10.05')).toBeNull();
  });

  it('repuestos línea por línea con el tipo de la casilla', () => {
    expect(armarRepuestos('Venta', 'DMP-F9\nCAB-01', 'Damper\nCabezal i3200', '1\n2 und')).toEqual({
      ok: true,
      repuestos: [
        { codigo: 'DMP-F9', descripcion: 'Damper', cantidad: 1, tipo: 'venta' },
        { codigo: 'CAB-01', descripcion: 'Cabezal i3200', cantidad: 2, tipo: 'venta' },
      ],
    });
    expect(armarRepuestos(null, null, null, null)).toEqual({ ok: true, repuestos: [] });
    expect(armarRepuestos('Venta', null, 'Damper', '1')).toEqual({
      ok: true,
      repuestos: [{ codigo: null, descripcion: 'Damper', cantidad: 1, tipo: 'venta' }],
    });
  });

  it('repuestos que no cuadran no se arman', () => {
    expect(armarRepuestos('Venta', 'A\nB', 'Damper', '1').ok).toBe(false); // columnas desparejas
    expect(armarRepuestos(null, null, 'Damper', '1').ok).toBe(false); // sin tipo
    expect(armarRepuestos('Venta', null, 'Damper', 'uno').ok).toBe(false); // cantidad ilegible
  });

  it('tipo real del archivo por sus primeros bytes', () => {
    expect(tipoDeArchivo(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(tipoDeArchivo(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(tipoDeArchivo(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(tipoDeArchivo(Buffer.from('hola'))).toBeNull();
  });
});

describe('construirEnvio', () => {
  it('arma el JSON del contrato con nombres y valores de RP-TECH', () => {
    const e = construirEnvio(
      fila({
        empresa: 'Textiles Andinos SAC', equipo: 'DTG 1000', tecnico: 'J. Quispe', fecha: '14/08/2025',
        estado_del_equipo: 'Inoperativo', limpieza_equipo: 'Sucio', cabezales: 'Regular', sistema_proteccion: 'Estab.',
        revision_linea_ln: '220V', revision_linea_lt: '221', revision_linea_nt: '1,5',
        hora_llegada: '10:05', hora_salida: '12:40',
        repuestos_tipo: 'Venta', codigo_repuesto: 'DMP-F9', repuestos_descripcion: 'Damper', repuestos_cantidad: '1',
        garantia: false, facturado: true, firma_operador: true, firma_cliente: false,
      }),
      ESCANEO,
    );
    expect(e).toMatchObject({
      version: 1, sirep_id: 'sirep-1', numero_talonario: '004512', fecha: '2025-08-14',
      cliente_texto: 'Textiles Andinos SAC', equipo_texto: 'DTG 1000', tecnico_texto: 'J. Quispe',
      estado_equipo: 'inoperativo', limpieza: 'sucio', estado_cabezales: 'regular', sistema_proteccion: 'estabilizador',
      voltaje_ln: 220, voltaje_lt: 221, voltaje_nt: 1.5, hora_llegada: '10:05', hora_salida: '12:40',
      resultado: null, requerimiento: null,
      repuestos: [{ codigo: 'DMP-F9', descripcion: 'Damper', cantidad: 1, tipo: 'venta' }],
      garantia: 'no', facturado: 'si', firma_operador_presente: true, firma_cliente_presente: false,
      revisado_por: 'Miguel', revisado_en: '2026-11-16T15:30:00Z', datos_originales: {}, escaneo: ESCANEO,
    });
    expect(e.revision_campos.voltaje_ln).toEqual({ confianza: 'alta', estado: 'auto' });
  });

  it('nunca envía los ids de SIREP ni la empresa', () => {
    const e = construirEnvio(fila({}, { cliente_id: 'c-sirep', equipo_id: 'e-sirep', tecnico_perfil_id: 't-sirep' }), ESCANEO) as any;
    for (const k of ['cliente_id', 'equipo_id', 'tecnico_id', 'tecnico_perfil_id', 'sede_id', 'empresa_id']) {
      expect(e).not.toHaveProperty(k);
    }
  });

  it('lo que no encaja va vacío y queda en datos_originales', () => {
    const e = construirEnvio(
      fila({ estado_del_equipo: 'funciona', revision_linea_ln: 'sin medir', ultimo_mantenimiento: 'hace 2 meses',
        repuestos_tipo: 'Venta', codigo_repuesto: 'A\nB', repuestos_descripcion: 'Damper', repuestos_cantidad: '1' }),
      ESCANEO,
    );
    expect(e.estado_equipo).toBeNull();
    expect(e.voltaje_ln).toBeNull();
    expect(e.ultimo_mantenimiento).toBeNull();
    expect(e.repuestos).toEqual([]);
    expect(e.datos_originales).toMatchObject({
      estado_equipo: 'funciona', voltaje_ln: 'sin medir', ultimo_mantenimiento: 'hace 2 meses',
      'repuestos.codigo': 'A\nB', 'repuestos.descripcion': 'Damper',
    });
  });

  it('usa la corrección del revisor y deja vacío lo ilegible', () => {
    const f = fila({ empresa: 'Textiles Andinoz', tinta: 'xx' });
    f.campos_extraidos!.empresa.revision = {
      estado: 'corregido', valor_corregido: 'Textiles Andinos SAC', revisado_por: 'M', revisado_en: null, corregido_por: 'M', corregido_en: null,
    };
    f.campos_extraidos!.tinta.revision = {
      estado: 'ilegible', valor_corregido: null, revisado_por: 'M', revisado_en: null, corregido_por: null, corregido_en: null,
    };
    f.campos_extraidos!.garantia.revision = {
      estado: 'ilegible', valor_corregido: null, revisado_por: 'M', revisado_en: null, corregido_por: null, corregido_en: null,
    };
    const e = construirEnvio(f, ESCANEO);
    expect(e.cliente_texto).toBe('Textiles Andinos SAC');
    expect(e.tinta).toBeNull();
    expect(e.garantia).toBe('sin_dato');
    expect(e.revision_campos.cliente_texto).toEqual({ confianza: 'alta', estado: 'corregido' });
  });
});
