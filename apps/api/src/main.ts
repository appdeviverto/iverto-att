import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import { AppModule } from './app.module';
import { redisOptions } from './common/redis.service';
import { isPublicApiUrl, registerPublicApiHooks } from './public-api/request-log';
import { SharedHttpIoAdapter } from './common/socket-io.adapter';
import { M50Server } from './terminals/m50.server';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Base64 JSON uploads (5 MB file → ~7 MB body) are the largest requests.
    new FastifyAdapter({
      logger: false,
      bodyLimit: 10 * 1024 * 1024,
      // Only the local reverse proxy (Caddy) may set X-Forwarded-For; `true` let any client spoof its IP.
      trustProxy: process.env.TRUST_PROXY || 'loopback',
    }),
    // req.rawBody: optional Ed25519 request signatures cover the exact body bytes (public-api/signing.ts).
    { rawBody: true },
  );

  // The app serves `/v1/...`; the public `/att` prefix belongs to the proxy, which strips it.
  const apiPrefix = process.env.API_PREFIX || 'v1';
  app.setGlobalPrefix(apiPrefix);

  await app.register(helmet, { contentSecurityPolicy: false });
  // Tighter on the mobile surface and on password changes/resets (§17).
  await app.register(rateLimit, {
    global: true,
    max: (req) => (req.url.includes('/mobile/') ? 120 : req.url.includes('/auth/') ? 10 : 600),
    timeWindow: '1 minute',
    // Shared across instances (in-memory counters multiplied with every replica); fails open if Redis is down.
    redis: new Redis({ ...redisOptions(), connectTimeout: 500, maxRetriesPerRequest: 1 }),
    nameSpace: 'rl:app:',
    skipOnError: true,
    // Public auth routes key by IP: a junk Authorization header must not buy a fresh bucket.
    keyGenerator: (req) =>
      /\/auth\/(forgot|reset)-password/.test(req.url) ? req.ip : (req.headers.authorization ?? req.ip).slice(-64),
    // The developer API has its own key/org limiter (public-api/limiter.ts).
    allowList: (req) => req.url.includes('/health/') || isPublicApiUrl(req.url),
  });
  registerPublicApiHooks(app);

  // Not the stock IoAdapter: M50 terminals share this HTTP server with a raw
  // WebSocket handshake, which Engine.IO would otherwise reap as a foreign upgrade.
  app.useWebSocketAdapter(new SharedHttpIoAdapter(app));

  app.enableCors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : true,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, Idempotency-Key, X-Tenant-Id',
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Iverto Attendance API')
      .setDescription('Face-recognition workforce attendance. See docs/api.md and docs/mobile_api.md.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(process.env.SWAGGER_PREFIX || 'docs', app, SwaggerModule.createDocument(app, config), {
      jsonDocumentUrl: 'docs/openapi.json',
    });
  }

  app.enableShutdownHooks();
  const port = Number(process.env.PORT || 8040);
  await app.listen(port, '0.0.0.0');

  // Terminals speak raw WebSocket XML and cannot handshake with Socket.IO; they get
  // their own listener on the same HTTP server. Attached after listen() so it exists.
  app.get(M50Server).attach(app.getHttpAdapter().getHttpServer());

  Logger.log(`Iverto Attendance API on :${port} under /${apiPrefix}`, 'Bootstrap');
}
bootstrap();
