import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotConfigService, limpiarDireccion } from './bot-config.service';

const ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_WEBHOOK_SECRET: 'secreto_webhook',
  PUBLIC_URL: 'https://sirep.example.com',
};

const servicio = (env: Record<string, string> = ENV) =>
  new BotConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);

/**
 * Telegram y la red simulados. `llegaAqui` decide si la dirección escrita llega a
 * este backend: si es true, el eco responde con lo que contesta el propio servicio.
 */
function red(svc: BotConfigService, opciones: { webhook?: string; llegaAqui?: boolean; caida?: boolean } = {}) {
  let webhook = opciones.webhook ?? 'https://viejo.ngrok-free.dev/telegram/webhook';
  const llamadas: { url: string; cuerpo: any }[] = [];
  const fetchFalso = jest.fn(async (url: string, init?: any) => {
    const cuerpo = init?.body ? JSON.parse(init.body) : null;
    llamadas.push({ url, cuerpo });
    const eco = url.match(/\/configuracion\/bot\/eco\/(\w+)$/);
    if (eco) {
      if (opciones.caida) throw new Error('getaddrinfo ENOTFOUND');
      const ok = opciones.llegaAqui !== false && svc.responderEco(eco[1]);
      return new Response(JSON.stringify(ok ? { ok: true } : { message: 'Not Found' }), { status: ok ? 200 : 404 });
    }
    if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'SirepBot', first_name: 'SIREP reportes' } });
    if (url.endsWith('/getWebhookInfo')) {
      return Response.json({ ok: true, result: { url: webhook, pending_update_count: 3, last_error_message: 'Connection refused', last_error_date: 1794850000 } });
    }
    if (url.endsWith('/setWebhook')) {
      webhook = cuerpo.url;
      return Response.json({ ok: true, result: true });
    }
    if (url.endsWith('/deleteWebhook')) {
      webhook = '';
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: 'no simulado' });
  });
  return { fetchFalso, llamadas };
}

describe('Configuración del bot', () => {
  it('limpia la dirección escrita', () => {
    expect(limpiarDireccion(' https://nuevo.ngrok-free.dev/ ')).toBe('https://nuevo.ngrok-free.dev');
    expect(limpiarDireccion('https://nuevo.ngrok-free.dev/telegram/webhook')).toBe('https://nuevo.ngrok-free.dev');
  });

  it('muestra el bot, a qué dirección envía, la cola y el último error', async () => {
    const svc = servicio();
    const { fetchFalso } = red(svc);
    const e = await svc.estado('revisor', fetchFalso as any);
    expect(e).toMatchObject({
      configurado: true,
      bot: { usuario: '@SirepBot', nombre: 'SIREP reportes' },
      conectado: true,
      direccion_actual: 'https://viejo.ngrok-free.dev',
      direccion_sugerida: 'https://sirep.example.com',
      mensajes_pendientes: 3,
      ultimo_error: 'Connection refused',
      puede_cambiar: false,
    });
  });

  it('el operador escribe la nueva dirección y vuelve a conectar, sin perder la cola', async () => {
    const svc = servicio();
    const { fetchFalso, llamadas } = red(svc);
    const e = await svc.conectar('https://nuevo.ngrok-free.dev/', 'operador', 'David', fetchFalso as any);
    const set = llamadas.find((l) => l.url.endsWith('/setWebhook'))!;
    expect(set.cuerpo).toMatchObject({
      url: 'https://nuevo.ngrok-free.dev/telegram/webhook',
      secret_token: 'secreto_webhook',
      drop_pending_updates: false,
    });
    expect(e.direccion_actual).toBe('https://nuevo.ngrok-free.dev');
  });

  it('no conecta a una dirección que no llega a este backend', async () => {
    const svc = servicio();
    const { fetchFalso, llamadas } = red(svc, { llegaAqui: false });
    await expect(svc.conectar('https://servidor-ajeno.com', 'operador', 'D', fetchFalso as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(llamadas.some((l) => l.url.endsWith('/setWebhook'))).toBe(false);
  });

  it('si el túnel está caído avisa y no cambia nada', async () => {
    const svc = servicio();
    const { fetchFalso, llamadas } = red(svc, { caida: true });
    await expect(svc.conectar('https://apagado.ngrok-free.dev', 'operador', 'D', fetchFalso as any)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(llamadas.some((l) => l.url.endsWith('/setWebhook'))).toBe(false);
  });

  it('exige https', async () => {
    const svc = servicio();
    const { fetchFalso } = red(svc);
    await expect(svc.conectar('http://localhost:3000', 'operador', 'D', fetchFalso as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el revisor no puede conectar ni desconectar', async () => {
    const svc = servicio();
    const { fetchFalso } = red(svc);
    await expect(svc.conectar('https://nuevo.ngrok-free.dev', 'revisor', 'V', fetchFalso as any)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.desconectar('revisor', 'V', fetchFalso as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('desconectar quita la dirección sin borrar la cola', async () => {
    const svc = servicio();
    const { fetchFalso, llamadas } = red(svc);
    const e = await svc.desconectar('admin', 'A', fetchFalso as any);
    expect(llamadas.find((l) => l.url.endsWith('/deleteWebhook'))!.cuerpo).toEqual({ drop_pending_updates: false });
    expect(e.conectado).toBe(false);
  });

  it('el eco solo responde a un código que este backend generó', () => {
    expect(servicio().responderEco('inventado')).toBe(false);
  });

  it('sin token del bot no rompe: avisa que no está configurado', async () => {
    const e = await servicio({ ...ENV, TELEGRAM_BOT_TOKEN: '' }).estado('operador');
    expect(e.configurado).toBe(false);
  });
});
