import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import {
  ALWAYS_ALLOWED_PATHS,
  MAINTENANCE_ENV,
  MAINTENANCE_ON,
  MAINTENANCE_RESPONSE,
  REFUSED_METHODS,
  isMaintenanceMode,
  refusesRequest,
} from './maintenance';
import { MaintenanceGuard } from './maintenance.guard';

/** A minimal ExecutionContext: only what the guard actually reads. */
const httpContext = (method: string, url: string): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: url }) }),
  }) as unknown as ExecutionContext;

describe('P5-X1 maintenance mode', () => {
  describe('the mode literal', () => {
    it('is on only for the exact literal', () => {
      expect(isMaintenanceMode({ [MAINTENANCE_ENV]: MAINTENANCE_ON })).toBe(true);
      for (const value of ['off', 'ON', 'On', 'true', '1', 'yes', '', ' on', 'on ']) {
        expect(isMaintenanceMode({ [MAINTENANCE_ENV]: value })).toBe(false);
      }
      expect(isMaintenanceMode({})).toBe(false);
    });

    it('refuses nothing while off', () => {
      for (const method of [...REFUSED_METHODS, 'GET']) {
        expect(refusesRequest({}, method, '/api/v1/products')).toBe(false);
      }
    });
  });

  describe('while on', () => {
    const env = { [MAINTENANCE_ENV]: MAINTENANCE_ON };

    it('refuses every mutating method', () => {
      for (const method of REFUSED_METHODS) {
        expect(refusesRequest(env, method, '/api/v1/products')).toBe(true);
        // Case is not a bypass.
        expect(refusesRequest(env, method.toLowerCase(), '/api/v1/products')).toBe(true);
      }
    });

    it('admits safe methods, so reads and diagnostics keep working', () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        expect(refusesRequest(env, method, '/api/v1/products')).toBe(false);
      }
    });

    it('always admits health, with or without a query string', () => {
      for (const path of ALWAYS_ALLOWED_PATHS) {
        expect(refusesRequest(env, 'GET', path)).toBe(false);
        expect(refusesRequest(env, 'POST', `${path}?probe=1`)).toBe(false);
      }
    });

    it('does not treat a path that merely CONTAINS an allowed path as allowed', () => {
      // `/api/v1/health-check` and `/x/api/v1/health` are different routes.
      expect(refusesRequest(env, 'POST', '/api/v1/health-check')).toBe(true);
      expect(refusesRequest(env, 'POST', '/x/api/v1/health')).toBe(true);
    });
  });

  describe('the guard', () => {
    const guard = new MaintenanceGuard();
    const original = process.env[MAINTENANCE_ENV];

    afterEach(() => {
      if (original === undefined) delete process.env[MAINTENANCE_ENV];
      else process.env[MAINTENANCE_ENV] = original;
    });

    it('lets everything through when maintenance is off', () => {
      delete process.env[MAINTENANCE_ENV];
      expect(guard.canActivate(httpContext('POST', '/api/v1/products'))).toBe(true);
    });

    it('throws 503 with the stable body when maintenance is on', () => {
      process.env[MAINTENANCE_ENV] = MAINTENANCE_ON;
      try {
        guard.canActivate(httpContext('POST', '/api/v1/products'));
        throw new Error('the guard did not refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect((error as HttpException).getResponse()).toEqual(MAINTENANCE_RESPONSE);
      }
    });

    it('still serves reads and health while on', () => {
      process.env[MAINTENANCE_ENV] = MAINTENANCE_ON;
      expect(guard.canActivate(httpContext('GET', '/api/v1/products'))).toBe(true);
      expect(guard.canActivate(httpContext('GET', '/api/v1/health'))).toBe(true);
    });

    it('ignores non-HTTP contexts rather than guessing', () => {
      process.env[MAINTENANCE_ENV] = MAINTENANCE_ON;
      const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;
      expect(guard.canActivate(rpc)).toBe(true);
    });
  });
});
