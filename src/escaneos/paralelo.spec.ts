import { enParalelo, paginasEnParalelo } from './paralelo';

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('enParalelo', () => {
  it('respeta el orden aunque terminen en otro orden', async () => {
    const r = await enParalelo([30, 5, 15, 1], 3, async (ms, i) => {
      await esperar(ms);
      return i;
    });
    expect(r).toEqual([0, 1, 2, 3]);
  });

  it('nunca supera el límite de tareas a la vez', async () => {
    let enCurso = 0;
    let maximo = 0;
    await enParalelo([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await esperar(5);
      enCurso--;
    });
    expect(maximo).toBe(3);
  });

  it('falla con el error de la página que falló y no empieza más', async () => {
    const empezadas: number[] = [];
    await expect(
      enParalelo([0, 1, 2, 3, 4, 5], 2, async (_, i) => {
        empezadas.push(i);
        await esperar(2);
        if (i === 1) throw new Error('página 2 mal');
      }),
    ).rejects.toThrow('página 2 mal');
    expect(empezadas.length).toBeLessThan(6);
  });

  it('lee el límite de la variable de entorno', () => {
    process.env.IA_PAGINAS_EN_PARALELO = '5';
    expect(paginasEnParalelo()).toBe(5);
    process.env.IA_PAGINAS_EN_PARALELO = 'x';
    expect(paginasEnParalelo()).toBe(3);
    delete process.env.IA_PAGINAS_EN_PARALELO;
  });
});
