import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from '../api-key.guard';
import { ApiKeysService } from '../api-keys.service';

/**
 * Every rejection leaves an attributable record; no record leaks the secret.
 *
 * The requirement this closes: a revoked or unknown key hitting /public must
 * produce a log an operator can correlate — request id, endpoint, reason, and
 * a safe key identifier — without the raw key or header ever appearing. Before
 * this, rejections produced NOTHING: no logger existed in the module and no
 * request id existed in the codebase.
 */
const FULL_KEY = 'ck_test_abcdefghijklmnopqrstuvwxyz123456789';
const PREFIX = FULL_KEY.slice(0, 10);

function contextFor(headers: Record<string, string>, capability?: string) {
  const request = {
    headers,
    method: 'POST',
    originalUrl: '/api/v1/public/orders',
    requestId: 'req-under-test-001',
  };
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({ capability }),
      getClass: () => ({}),
    } as never,
  };
}

describe('API-key rejections are logged, attributably and safely', () => {
  let warns: string[];
  let guard: ApiKeyGuard;
  let verify: jest.Mock;

  beforeEach(() => {
    warns = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warns.push(String(message));
    });
    verify = jest.fn();
    const reflector = {
      getAllAndOverride: (_meta: unknown, [handler]: [{ capability?: string }]) => handler.capability,
    } as unknown as Reflector;
    guard = new ApiKeyGuard({ verify } as unknown as ApiKeysService, reflector);
  });

  afterEach(() => jest.restoreAllMocks());

  const record = () => {
    expect(warns).toHaveLength(1);
    return JSON.parse(warns[0]) as Record<string, unknown>;
  };

  it('records an unknown or revoked key with request id, route, reason and display prefix', async () => {
    verify.mockResolvedValue(null);
    const { ctx } = contextFor({ 'x-api-key': FULL_KEY }, 'ORDER_CREATE');
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid or revoked API key');
    expect(record()).toEqual({
      event: 'api_key_rejected',
      requestId: 'req-under-test-001',
      clientRequestId: null,
      method: 'POST',
      path: '/api/v1/public/orders',
      reason: 'invalid_or_revoked',
      keyPrefix: PREFIX,
    });
  });

  it('records a capability refusal with the capability named', async () => {
    verify.mockResolvedValue({ storeId: 's1', organizationId: 'o1', capabilities: ['CATALOGUE_READ'] });
    const { ctx } = contextFor({ 'x-api-key': FULL_KEY }, 'ORDER_CREATE');
    await expect(guard.canActivate(ctx)).rejects.toThrow(/ORDER_CREATE/);
    expect(record().reason).toBe('capability_missing:ORDER_CREATE');
    expect(record().keyPrefix).toBe(PREFIX);
  });

  it('records a missing credential with no key identifier at all', async () => {
    const { ctx } = contextFor({}, 'CATALOGUE_READ');
    await expect(guard.canActivate(ctx)).rejects.toThrow('API key required');
    expect(record().reason).toBe('missing_credential');
    expect(record().keyPrefix).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('records the fail-closed unclassified-route branch', async () => {
    verify.mockResolvedValue({ storeId: 's1', organizationId: 'o1', capabilities: ['CATALOGUE_READ'] });
    const { ctx } = contextFor({ 'x-api-key': FULL_KEY }, undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow('not available to API keys');
    expect(record().reason).toBe('route_declares_no_capability');
  });

  it('NEVER logs the key itself — only its ten-character display prefix', async () => {
    verify.mockResolvedValue(null);
    const { ctx } = contextFor({ 'x-api-key': FULL_KEY }, 'CATALOGUE_READ');
    await expect(guard.canActivate(ctx)).rejects.toThrow();
    expect(warns[0]).toContain(PREFIX);
    expect(warns[0]).not.toContain(FULL_KEY);
    // The prefix must be strictly shorter than the secret's entropy.
    expect(PREFIX.length).toBeLessThan(FULL_KEY.length / 2);
  });

  it('never records a query string — the path only, even when a key is misplaced there', async () => {
    verify.mockResolvedValue(null);
    const { ctx, request } = contextFor({ 'x-api-key': FULL_KEY }, 'CATALOGUE_READ');
    (request as { originalUrl: string }).originalUrl = '/api/v1/public/products?api_key=ck_MISPLACED_SECRET&x=1';
    await expect(guard.canActivate(ctx)).rejects.toThrow();
    expect(record().path).toBe('/api/v1/public/products');
    expect(warns[0]).not.toContain('MISPLACED');
  });

  it('records "malformed" — not ten characters of whatever was pasted — when the value is not key-shaped', async () => {
    verify.mockResolvedValue(null);
    for (const pasted of ['Bearer eyJhbGciOiJIUzI1NiJ9.SECRET', 'hunter2-password!', 'refresh_token=SECRETCOOKIE']) {
      warns = [];
      const { ctx } = contextFor({ 'x-api-key': pasted }, 'CATALOGUE_READ');
      await expect(guard.canActivate(ctx)).rejects.toThrow();
      expect(record().keyPrefix).toBe('malformed');
      expect(warns[0]).not.toContain(pasted.slice(0, 10));
    }
  });

  it('logs NOTHING on an accepted request', async () => {
    verify.mockResolvedValue({ storeId: 's1', organizationId: 'o1', capabilities: ['CATALOGUE_READ'] });
    const { ctx, request } = contextFor({ 'x-api-key': FULL_KEY }, 'CATALOGUE_READ');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(warns).toHaveLength(0);
    expect((request as { catalogueStoreId?: string }).catalogueStoreId).toBe('s1');
  });
});
