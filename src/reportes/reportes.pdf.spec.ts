import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { IDS_CAMPOS_FORMULARIO } from '../escaneos/campos-formulario';
import { CampoGuardado, construirCampos } from './reportes.mapper';
import {
  casillasProteccion,
  derivarRevision,
  elegirOpcion,
  esCorreccion,
  fechaParaPdf,
  generarPdfReporte,
  horaParaPdf,
  parsearRepuestos,
  recortarFirma,
  regionDeCampo,
  valorParaPdf,
  valoresDelReporte,
} from './reportes.pdf';

const ok = (valor: unknown): CampoGuardado => ({ clave: 'x', valor, confianza: 'alta', noLeido: false, dudoso: false });

/** Reporte de ejemplo: todos los campos leídos; `cambios` pisa campos concretos. */
function guardados(cambios: Record<string, CampoGuardado> = {}): Record<string, CampoGuardado> {
  const base: Record<string, unknown> = {
    tecnico: 'Orlando',
    empresa: 'Abregu',
    fecha: '2024-02-09',
    estado_del_equipo: 'Operativo',
    limpieza_equipo: 'Sucio',
    cabezales: 'Regular',
    sistema_proteccion: 'UPS',
    repuestos_tipo: 'Garantía',
    codigo_repuesto: 'A1\nB2',
    repuestos_descripcion: 'Damper\nCabezal',
    repuestos_cantidad: '1\n2',
    procedimiento: 'Se cambió el damper',
    garantia: true,
    facturado: false,
    firma_operador: false,
    firma_cliente: false,
  };
  return {
    ...Object.fromEntries(IDS_CAMPOS_FORMULARIO.map((id) => [id, { ...ok(base[id] ?? null), clave: id }])),
    ...cambios,
  };
}

const conRevision = (c: CampoGuardado, estado: string, extra: Record<string, unknown> = {}): CampoGuardado => ({
  ...c,
  revision: {
    estado,
    valor_corregido: null,
    revisado_por: 'Ana',
    revisado_en: '2026-11-16T15:20:00Z',
    corregido_por: null,
    corregido_en: null,
    ...extra,
  } as any,
});

async function escaneoDePrueba(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 780, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
}

async function paginas(pdf: Uint8Array): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

describe('reportes.pdf', () => {
  describe('valor vigente', () => {
    it('la corrección humana manda sobre la lectura de la IA', () => {
      const [c] = construirCampos({ empresa: conRevision(ok('Abregu'), 'corregido', { valor_corregido: 'Abregú SAC' }) }).filter((x) => x.id === 'empresa');
      expect(valorParaPdf(c)).toBe('Abregú SAC');
    });

    it('un campo ilegible u omitido queda vacío aunque la IA haya leído algo', () => {
      const campos = construirCampos({
        empresa: conRevision(ok('Abregu'), 'ilegible'),
        tecnico: conRevision(ok('Orlando'), 'omitido'),
        fecha: ok('2024-02-09'),
      });
      const v = valoresDelReporte(campos);
      expect(v.empresa).toBe('');
      expect(v.tecnico).toBe('');
      expect(v.fecha).toBe('2024-02-09');
    });

    it('esCorreccion distingue corregidos y vacíos de los confirmados', () => {
      const campos = construirCampos({
        empresa: conRevision(ok('A'), 'corregido', { valor_corregido: 'B' }),
        tecnico: conRevision(ok('Orlando'), 'confirmado'),
        tinta: conRevision(ok('x'), 'omitido'),
      });
      const por = Object.fromEntries(campos.map((c) => [c.id, esCorreccion(c)]));
      expect(por.empresa).toBe(true);
      expect(por.tinta).toBe(true);
      expect(por.tecnico).toBe(false);
    });
  });

  describe('mapeo de casillas', () => {
    it('reconoce la opción sin importar mayúsculas ni tildes', () => {
      expect(elegirOpcion('Garantía', ['venta', 'descarte', 'garantia'] as const)).toBe('garantia');
      expect(elegirOpcion(' OPERATIVO ', ['operativo', 'inoperativo'] as const)).toBe('operativo');
      expect(elegirOpcion('a medias', ['operativo', 'inoperativo'] as const)).toBeNull();
      expect(elegirOpcion(null, ['bueno', 'malo'] as const)).toBeNull();
    });

    it('sistema de protección: Estab., UPS, ambas u otro con su texto', () => {
      expect(casillasProteccion('UPS')).toEqual({ estab: false, ups: true, otro: null });
      expect(casillasProteccion('Estab.')).toEqual({ estab: true, ups: false, otro: null });
      expect(casillasProteccion('estabilizador y UPS')).toEqual({ estab: true, ups: true, otro: null });
      expect(casillasProteccion('Regulador solar')).toEqual({ estab: false, ups: false, otro: 'Regulador solar' });
      expect(casillasProteccion('')).toEqual({ estab: false, ups: false, otro: null });
    });

    it('fecha y hora se normalizan solo cuando se pueden y si no se muestran como se leyeron', () => {
      expect(fechaParaPdf('2024-02-09')).toBe('09/02/2024');
      expect(fechaParaPdf('hace 2 meses')).toBe('hace 2 meses');
      expect(horaParaPdf('3:43')).toBe('03:43');
      expect(horaParaPdf('15:20:10')).toBe('15:20');
      expect(horaParaPdf('tarde')).toBe('tarde');
    });
  });

  describe('repuestos', () => {
    it('una línea por repuesto, alineadas por columna', () => {
      expect(parsearRepuestos('A1\nB2', 'Damper\nCabezal', '1\n2')).toEqual([
        { codigo: 'A1', descripcion: 'Damper', cantidad: '1' },
        { codigo: 'B2', descripcion: 'Cabezal', cantidad: '2' },
      ]);
    });

    it('una columna más corta deja ese dato vacío y no descarta la fila; las filas vacías se omiten', () => {
      expect(parsearRepuestos('A1', 'Damper\nCabezal\n\n', '1')).toEqual([
        { codigo: 'A1', descripcion: 'Damper', cantidad: '1' },
        { codigo: '', descripcion: 'Cabezal', cantidad: '' },
      ]);
      expect(parsearRepuestos(null, null, null)).toEqual([]);
      expect(parsearRepuestos('A1\r\nB2', 'x\r\ny', null)).toHaveLength(2);
    });
  });

  describe('revisión', () => {
    it('toma al último que intervino; sin intervención usa el respaldo del reporte', () => {
      const campos = construirCampos({
        empresa: conRevision(ok('A'), 'confirmado', { revisado_por: 'Ana', revisado_en: '2026-11-16T10:00:00Z' }),
        tecnico: conRevision(ok('B'), 'corregido', {
          valor_corregido: 'C',
          revisado_por: 'Luis',
          revisado_en: '2026-11-16T12:00:00Z',
          corregido_por: 'Luis',
          corregido_en: '2026-11-16T12:00:00Z',
        }),
      });
      expect(derivarRevision(campos)).toEqual({ por: 'Luis', en: '2026-11-16T12:00:00Z' });
      expect(derivarRevision(construirCampos({}), { por: 'Marta', en: '2026-01-01T00:00:00Z' })).toEqual({
        por: 'Marta',
        en: '2026-01-01T00:00:00Z',
      });
      expect(derivarRevision(construirCampos({}))).toEqual({ por: null, en: null });
    });

    it('la región de un campo es la del modelo y, sin ella, la del mapa fijo del talonario', () => {
      const propia = { x: 0.1, y: 0.1, ancho: 0.2, alto: 0.05, pagina: 1 };
      expect(regionDeCampo({ id: 'firma_cliente', region: propia })).toEqual(propia);
      expect(regionDeCampo({ id: 'firma_cliente', region: null })).toMatchObject({ pagina: 1, ancho: 0.24 });
      expect(regionDeCampo({ id: 'no_existe', region: null })).toBeNull();
    });
  });

  describe('firma', () => {
    it('recorta la tinta de la firma y descarta una región en blanco', async () => {
      const firma = await sharp({
        create: { width: 400, height: 200, channels: 3, background: '#ffffff' },
      })
        .composite([{ input: await sharp({ create: { width: 200, height: 12, channels: 3, background: '#101030' } }).png().toBuffer(), left: 100, top: 90 }])
        .png()
        .toBuffer();
      const region = { x: 0, y: 0, ancho: 1, alto: 1, pagina: 1 };
      const png = await recortarFirma({ original: firma }, region);
      expect(png).not.toBeNull();
      expect((await sharp(png!).metadata()).hasAlpha).toBe(true);

      const blanco = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
      expect(await recortarFirma({ original: blanco }, region)).toBeNull();
    });
  });

  describe('generación', () => {
    it('sin escaneo produce un PDF válido de una sola página', async () => {
      const pdf = await generarPdfReporte({ numero: '000375', campos: construirCampos(guardados()) });
      expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
      expect(await paginas(pdf)).toBe(1);
    });

    it('con escaneo agrega el anexo con el original (una página por hoja) y pesa poco', async () => {
      const esc = await escaneoDePrueba();
      const pdf = await generarPdfReporte({ numero: '000375', campos: construirCampos(guardados()) }, [esc]);
      expect(await paginas(pdf)).toBe(2);
      expect(pdf.length).toBeLessThan(300_000);
      const dos = await generarPdfReporte({ numero: '000375', campos: construirCampos(guardados()) }, [esc, esc]);
      expect(await paginas(dos)).toBe(3);
    });

    it('con correcciones agrega la versión del escaneo con ellas dibujadas', async () => {
      const esc = await escaneoDePrueba();
      const campos = construirCampos(
        guardados({
          empresa: conRevision(ok('Abregu'), 'corregido', { valor_corregido: 'Abregú SAC' }),
          tinta: conRevision(ok('x'), 'omitido'),
        }),
      );
      const pdf = await generarPdfReporte({ numero: '000375', campos, revisadoPor: 'Ana' }, esc);
      expect(await paginas(pdf)).toBe(3);
    });

    it('pasa con todos los campos vacíos, con firma marcada sin escaneo y con un escaneo dañado', async () => {
      const vacios = construirCampos({});
      expect(await paginas(await generarPdfReporte({ numero: 'SN-a1b2c3d4', campos: vacios }))).toBe(1);

      const conFirma = construirCampos(guardados({ firma_cliente: ok(true) }));
      expect(await paginas(await generarPdfReporte({ numero: '1', campos: conFirma }))).toBe(1);

      const roto = await generarPdfReporte({ numero: '1', campos: conFirma }, [Buffer.from('no soy una imagen')]);
      expect(await paginas(roto)).toBe(1);
    });

    it('el texto que no entra en los recuadros y los repuestos de más van al anexo', async () => {
      const largo = Array.from({ length: 60 }, (_, i) => `Paso ${i + 1}: se revisó y limpió el componente número ${i + 1}.`).join('\n');
      const campos = construirCampos(
        guardados({
          procedimiento: ok(largo),
          repuestos_descripcion: ok('a\nb\nc\nd\ne\nf'),
          repuestos_cantidad: ok('1\n1\n1\n1\n1\n1'),
          codigo_repuesto: ok(''),
        }),
      );
      const pdf = await generarPdfReporte({ numero: '000375', campos });
      expect(await paginas(pdf)).toBeGreaterThanOrEqual(2);
    });

    it('acepta un logo y caracteres fuera de WinAnsi sin fallar', async () => {
      const logo = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#8a3d8f' } }).png().toBuffer();
      const campos = construirCampos(guardados({ empresa: ok('Imprenta 日本 “Sol” ✓') }));
      const pdf = await generarPdfReporte({ numero: '000375', campos }, null, logo);
      expect(await paginas(pdf)).toBe(1);
    });
  });
});
