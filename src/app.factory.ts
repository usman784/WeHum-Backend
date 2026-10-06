import 'reflect-metadata';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { AppErrorFilter } from './common/error.filter';
import { EnvelopeInterceptor } from './common/envelope.interceptor';
import { env, isProd } from './config/env';
import { metrics } from './infra/metrics';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

/** Builds the HTTP app (used by main.ts and by e2e tests). */
export async function createApp(opts: { logger?: boolean } = {}) {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 100 * 1024,
    keepAliveTimeout: 65_000,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => (req.headers['x-request-id'] as string) || randomUUID(),
    logger: opts.logger === false ? false : {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.refreshToken', 'req.body.email', 'req.body.text'],
      ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { singleLine: true, ignore: 'pid,hostname' } } }),
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRole('api'), adapter, { logger: opts.logger === false ? false : ['error', 'warn', 'log'] });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(compress, { encodings: ['br', 'gzip'], threshold: 1024 });
  await app.register(cookie);
  const io = new RedisIoAdapter(app);
  await io.connectToRedis(env.REDIS_URL);
  app.useWebSocketAdapter(io);
  // @fastify/cors allows only GET, HEAD and POST by default; the CMS also sends PUT, PATCH and DELETE.
  app.enableCors({
    origin: env.CMS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    exposedHeaders: ['ETag', 'x-request-id', 'x-trace-id'],
  });
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new AppErrorFilter());
  app.getHttpAdapter().getInstance().addHook('onSend', async (req, reply) => { reply.header('x-request-id', String(req.id)); });
  // spec §11: http_request_duration_seconds{route,method,status} (the route pattern, never the raw URL)
  app.getHttpAdapter().getInstance().addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    if (route === '/metrics') return;
    metrics.httpDuration.observe({ route, method: req.method, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  if (!isProd) {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder()
      .setTitle('WeHum API').setVersion('1.0').addBearerAuth().build());
    SwaggerModule.setup('docs', app, doc);
  }
  app.enableShutdownHooks();
  return app;
}
