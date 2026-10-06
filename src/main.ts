import * as Sentry from '@sentry/node';
import { NestFactory } from '@nestjs/core';
import { env } from './config/env';
import { AppModule } from './app.module';
import { createApp } from './app.factory';
import { serveMetrics } from './infra/metrics';

async function bootstrap() {
  if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE });

  if (env.APP_ROLE !== 'api') {
    const ctx = await NestFactory.createApplicationContext(AppModule.forRole(env.APP_ROLE));
    ctx.enableShutdownHooks();
    if (env.METRICS_PORT) serveMetrics(env.METRICS_PORT);
    console.log(`WeHum ${env.APP_ROLE} started`);
    return;
  }
  const app = await createApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`WeHum API on http://localhost:${env.PORT}  (docs: /docs)`);
}
bootstrap();
