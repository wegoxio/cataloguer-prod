import { CanActivate, ExecutionContext, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ImportConcurrencySemaphore } from './import-concurrency.semaphore';
import { IMPORT_CONCURRENCY_SEMAPHORE } from './import-upload.constants';

/**
 * Admits at most N concurrent imports per container (#172). Bound to the two
 * import routes at method level; because Nest runs controller-level guards
 * (JwtAuthGuard, RolesGuard) before route-level guards, authentication and
 * role checks already passed here — an unauthenticated/unauthorized request
 * never reaches this guard and never consumes a permit. It also runs before
 * the FileInterceptor (guards precede interceptors), so admission happens
 * BEFORE the multipart body is buffered.
 *
 * The permit is released exactly once when the response finishes or the
 * connection closes/aborts — covering success, controller/parser errors, and
 * client aborts — regardless of what happens downstream.
 */
@Injectable()
export class ImportConcurrencyGuard implements CanActivate {
  constructor(
    @Inject(IMPORT_CONCURRENCY_SEMAPHORE)
    private readonly semaphore: ImportConcurrencySemaphore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: unknown }>();

    // Defensive: never hold a permit for a request that lacks an authenticated
    // user (the auth guard should already have rejected it upstream).
    if (!request.user) return true;

    if (!this.semaphore.tryAcquire()) {
      throw new ServiceUnavailableException(
        'El servidor está procesando otras importaciones en este momento. Inténtalo de nuevo en unos segundos.',
      );
    }

    const response = http.getResponse<Response>();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.semaphore.release();
    };
    // `once` auto-removes the listener after firing; the flag prevents a double
    // release if both events occur.
    response.once('finish', release);
    response.once('close', release);

    return true;
  }
}
