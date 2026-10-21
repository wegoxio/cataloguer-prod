import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IMPORT_COMMIT_BODY_LIMIT } from './common/http/body-limits';
import helmet from 'helmet';
import { requestIdMiddleware } from './common/observability/request-id';
import { scrubSentryEvent } from './common/observability/sentry-scrub';
import * as Sentry from '@sentry/node';
import { corsOptionsFor, CorsDelegateOptions } from './config/cors.options';

async function bootstrap() {
  // Error monitoring: inert until SENTRY_DSN is configured
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,
      // Extracted and tested: the inline version missed `x-api-key`, so a 500
      // on a /public route would have shipped the caller's plaintext key.
      beforeSend: (event) => scrubSentryEvent(event),
    });
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Explicit body limit. Before Phase 9 nothing was configured, so every JSON
  // route silently ran under Express's 100 kB default — which contradicted the
  // importer's advertised 500-row cap (a real 45-column export serializes 500
  // rows to 569 kB, so the cap was unreachable and the true ceiling was ~76
  // rows). Nest's own useBodyParser is used rather than app.use(json()) because
  // it re-registers the parser Nest installed for `rawBody: true`, keeping the
  // Stripe webhook's raw buffer intact.
  app.useBodyParser('json', { limit: IMPORT_COMMIT_BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: IMPORT_COMMIT_BODY_LIMIT });

  // Caddy sits in front of the backend as exactly one proxy hop: trust it so req.ip (and
  // therefore rate limiting) sees the real client IP, not the proxy's.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Request identity first, so every later layer (guards included) can log an
  // id the response also carries.
  app.use(requestIdMiddleware);

  // Standard security headers; the API serves no HTML so defaults are safe
  app.use(helmet());
  app.use(cookieParser());

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 3001;

  // Global validation pipe as required by manual (Use DTO validation everywhere)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  /**
   * #292: the lifecycle triggers' SQLSTATE becomes a stable domain error rather
   * than a driver message. Registered globally because the protected tables are
   * written from services, raw SQL and the import runner alike — see
   * `LifecycleConstraintFilter`.
   */

  // Set global API prefix
  app.setGlobalPrefix('api/v1');

  // Configure CORS. Panel routes stay locked to our own origins (with
  // credentials); the public catalogue API and the embed widget must work
  // from ANY client website, so those paths allow every origin — they are
  // read-mostly and always require an X-Api-Key, never cookies. The per-path
  // policy lives in config/cors.options.ts (#175).
  const corsAllowedOrigins = configService.get<string>('CORS_ALLOWED_ORIGINS') || '';
  const origins = corsAllowedOrigins.split(',').map((origin) => origin.trim());

  app.enableCors((req: { url: string }, callback: (err: Error | null, options: CorsDelegateOptions) => void) => {
    callback(null, corsOptionsFor(req.url, origins));
  });

  // Run OnModuleDestroy hooks (e.g. the distributed rate-limit Redis client, #181)
  // on SIGTERM from Docker, not only on an explicit app.close().
  app.enableShutdownHooks();

  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}/api/v1`);
}
bootstrap();
