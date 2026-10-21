import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Poor man's APM: logs any request slower than SLOW_REQUEST_MS
 * (default 750ms) with its route and duration, so hot spots show up
 * in container logs before clients notice them.
 */
@Injectable()
export class HttpPerformanceInterceptor implements NestInterceptor {
  private readonly logger = new Logger('SlowRequest');
  private readonly thresholdMs = parseInt(process.env.SLOW_REQUEST_MS || '750', 10);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const started = Date.now();
    const request = context.switchToHttp().getRequest();
    return next.handle().pipe(
      tap({
        next: () => {
          const elapsed = Date.now() - started;
          if (elapsed >= this.thresholdMs) {
            this.logger.warn(
              `${request.method} ${request.route?.path ?? String(request.url).split('?')[0]} took ${elapsed}ms`,
            );
          }
        },
        error: (err) => {
          // Expected HTTP errors (validation, 401/403...) are not incidents
          if (process.env.SENTRY_DSN && !(err instanceof HttpException)) {
            Sentry.captureException(err);
          }
        },
      }),
    );
  }
}
