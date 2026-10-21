import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from '../api-key.guard';

function requestWith(headers: Record<string, string>) {
  const request: any = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as any;
  return { request, context };
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let mockKeys: any;
  let mockReflector: any;

  beforeEach(() => {
    mockKeys = { verify: jest.fn() };
    // Default: the route declares CATALOGUE_READ, like most of the controller
    mockReflector = { getAllAndOverride: jest.fn().mockReturnValue('CATALOGUE_READ') };
    guard = new ApiKeyGuard(mockKeys, mockReflector);
  });

  it('allows a valid API key and pins the catalogue to its store + organization', async () => {
    mockKeys.verify.mockResolvedValue({
      storeId: 'store-1',
      organizationId: 'org-1',
      capabilities: ['CATALOGUE_READ'],
    });
    const { request, context } = requestWith({ 'x-api-key': 'ck_good' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.catalogueStoreId).toBe('store-1');
    expect(request.catalogueOrganizationId).toBe('org-1');
  });

  it('rejects an invalid or revoked API key', async () => {
    mockKeys.verify.mockResolvedValue(null);
    const { context } = requestWith({ 'x-api-key': 'ck_bad' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  // Phase 6: authorization sits on top of authentication. A real, alive key
  // that lacks the route's capability is a 403, never a 401 — the integrator
  // must be able to tell "bad key" from "key without this grant".
  it('refuses a valid key missing the required capability with a 403', async () => {
    mockKeys.verify.mockResolvedValue({
      storeId: 'store-1',
      organizationId: 'org-1',
      capabilities: ['CATALOGUE_READ'],
    });
    mockReflector.getAllAndOverride.mockReturnValue('ORDER_CREATE');
    const { request, context } = requestWith({ 'x-api-key': 'ck_good' });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(requestWith({ 'x-api-key': 'ck_good' }).context)).rejects.toThrow(
      'This API key does not have the ORDER_CREATE capability',
    );
    // authorization failed before any scope was pinned onto the request
    expect(request.catalogueStoreId).toBeUndefined();
    expect(request.catalogueOrganizationId).toBeUndefined();
  });

  it('fails CLOSED on a route that declares no capability', async () => {
    mockKeys.verify.mockResolvedValue({
      storeId: 'store-1',
      organizationId: 'org-1',
      capabilities: ['CATALOGUE_READ', 'ORDER_CREATE', 'DISCOUNT_VALIDATE'],
    });
    mockReflector.getAllAndOverride.mockReturnValue(undefined);
    const { context } = requestWith({ 'x-api-key': 'ck_good' });
    // even a full-authority key is refused: an unclassified route is a bug
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('checks the bad-key branch BEFORE the capability branch (401 wins over 403)', async () => {
    mockKeys.verify.mockResolvedValue(null);
    mockReflector.getAllAndOverride.mockReturnValue(undefined);
    const { context } = requestWith({ 'x-api-key': 'ck_bad' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  // #175: the admin Bearer path is gone — /public no longer accepts JWTs
  it('rejects an Authorization: Bearer token as if no credential were present', async () => {
    const { context } = requestWith({ authorization: 'Bearer some.jwt.token' });
    await expect(guard.canActivate(context)).rejects.toThrow('API key required (X-Api-Key header)');
    expect(mockKeys.verify).not.toHaveBeenCalled();
  });

  it('rejects a Bearer token even alongside an invalid API key (no JWT fallback)', async () => {
    mockKeys.verify.mockResolvedValue(null);
    const { context } = requestWith({ 'x-api-key': 'ck_bad', authorization: 'Bearer some.jwt.token' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects requests with no credentials', async () => {
    const { context } = requestWith({});
    await expect(guard.canActivate(context)).rejects.toThrow('API key required (X-Api-Key header)');
  });
});
