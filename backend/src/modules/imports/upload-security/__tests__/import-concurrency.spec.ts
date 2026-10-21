import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { ImportConcurrencySemaphore } from '../import-concurrency.semaphore';
import { ImportConcurrencyGuard } from '../import-concurrency.guard';

describe('ImportConcurrencySemaphore', () => {
  it('hands out exactly `permits` tokens then fails fast', () => {
    const s = new ImportConcurrencySemaphore(2);
    expect(s.free).toBe(2);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false); // exhausted, non-blocking
    expect(s.free).toBe(0);
  });

  it('release restores a permit but never exceeds the ceiling', () => {
    const s = new ImportConcurrencySemaphore(1);
    s.tryAcquire();
    s.release();
    expect(s.free).toBe(1);
    s.release(); // extra release is a no-op — cannot inflate the pool
    expect(s.free).toBe(1);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
  });
});

describe('ImportConcurrencyGuard', () => {
  // A minimal Express-response stand-in: EventEmitter gives us real once/emit.
  const makeCtx = (request: Record<string, unknown>) => {
    const response = new EventEmitter();
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    return { ctx, response };
  };

  it('admits an authenticated request and consumes one permit', () => {
    const s = new ImportConcurrencySemaphore(1);
    const guard = new ImportConcurrencyGuard(s);
    const { ctx } = makeCtx({ user: { id: 'u1' } });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(s.free).toBe(0);
  });

  it('rejects with 503 when no permit is free', () => {
    const s = new ImportConcurrencySemaphore(1);
    const guard = new ImportConcurrencyGuard(s);
    guard.canActivate(makeCtx({ user: { id: 'u1' } }).ctx); // take the only permit

    expect(() => guard.canActivate(makeCtx({ user: { id: 'u2' } }).ctx)).toThrow(ServiceUnavailableException);
    expect(s.free).toBe(0); // the rejected request took nothing
  });

  it('releases the permit when the response finishes', () => {
    const s = new ImportConcurrencySemaphore(1);
    const guard = new ImportConcurrencyGuard(s);
    const { ctx, response } = makeCtx({ user: { id: 'u1' } });
    guard.canActivate(ctx);
    expect(s.free).toBe(0);

    response.emit('finish');
    expect(s.free).toBe(1);
  });

  it('releases the permit when the connection closes/aborts', () => {
    const s = new ImportConcurrencySemaphore(1);
    const guard = new ImportConcurrencyGuard(s);
    const { ctx, response } = makeCtx({ user: { id: 'u1' } });
    guard.canActivate(ctx);

    response.emit('close');
    expect(s.free).toBe(1);
  });

  it('releases exactly once even if both finish and close fire', () => {
    const s = new ImportConcurrencySemaphore(2);
    const guard = new ImportConcurrencyGuard(s);
    const { ctx, response } = makeCtx({ user: { id: 'u1' } });
    guard.canActivate(ctx);
    expect(s.free).toBe(1);

    response.emit('finish');
    response.emit('close'); // second event must NOT double-release
    expect(s.free).toBe(2);
  });

  it('lets an unauthenticated request pass without consuming a permit (defensive)', () => {
    const s = new ImportConcurrencySemaphore(1);
    const guard = new ImportConcurrencyGuard(s);
    const { ctx } = makeCtx({}); // no `user`

    expect(guard.canActivate(ctx)).toBe(true);
    expect(s.free).toBe(1);
  });

  it('recovers a permit after each request so the pool is reusable', () => {
    const s = new ImportConcurrencySemaphore(1);
    const guard = new ImportConcurrencyGuard(s);

    for (let i = 0; i < 5; i += 1) {
      const { ctx, response } = makeCtx({ user: { id: `u${i}` } });
      expect(guard.canActivate(ctx)).toBe(true);
      response.emit('finish');
      expect(s.free).toBe(1);
    }
  });
});
