import * as dns from 'node:dns';
import * as net from 'node:net';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { corsOriginCallback } from './common/cors.util';

// Prioriza IPv4 y amplía el timeout de Happy Eyeballs de Node (por defecto 250ms),
// evitando fallos "fetch failed (ETIMEDOUT)" hacia api.telegram.org desde Sudamérica o redes sin IPv6.
dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Hallazgo 37.4-E: antes `origin: true` aceptaba cualquier dominio.
  // Ahora solo se permite el/los dominio(s) en FRONTEND_URL (ver
  // cors.util.ts) + localhost para desarrollo.
  app.enableCors({
    origin: corsOriginCallback,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('SIREP API')
      .setDescription('Endpoints del backend de SIREP (Digitalización de Reportes Técnicos con IA y Telegram)')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  console.log(`Backend corriendo en http://localhost:${port}`);
  console.log(`Documentación Swagger en http://localhost:${port}/docs`);
}
bootstrap();