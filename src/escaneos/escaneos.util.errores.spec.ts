import { BadRequestException } from '@nestjs/common';
import { validarImagen } from './escaneos.util';

describe('errores de escaneos.util con codigo estable', () => {
  it('validarImagen rechaza un Word con formato_no_admitido', async () => {
    const err = await validarImagen(Buffer.from('PK\x03\x04 docx')).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ statusCode: 400, codigo: 'formato_no_admitido' });
  });
});
