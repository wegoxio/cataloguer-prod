import { NotFoundException } from '@nestjs/common';
import { ApiKeysController } from '../api-keys.controller';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

/**
 * P1-07 (#162): revocation must be isolated by the actor's explicit
 * TenantScope. Foreign, sibling-branch and unknown key ids must all be the
 * same 404; a legacy storeless key is revocable ONLY by the platform owner
 * acting globally.
 */

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const STORE_A1 = '00000000-0000-4000-8000-0000000000a1';
const STORE_A2 = '00000000-0000-4000-8000-0000000000a2';
const STORE_B1 = '00000000-0000-4000-8000-0000000000b1';
const KEY_ID = '00000000-0000-4000-8000-00000000fee1';

const scopeOf = (overrides: Partial<TenantScope>): TenantScope => ({
  platform: false,
  organizationId: null,
  storeId: null,
  allowedStoreIds: [],
  role: 'ADMIN',
  ...overrides,
});

const adminOfA1 = scopeOf({ organizationId: ORG_A, storeId: STORE_A1, allowedStoreIds: [STORE_A1] });
const globalPlatform = scopeOf({ platform: true, role: 'SUPER_ADMIN' });
const managedPlatform = scopeOf({
  platform: true,
  role: 'SUPER_ADMIN',
  organizationId: ORG_A,
  allowedStoreIds: [STORE_A1, STORE_A2],
});

const keyBoundTo = (storeId: string | null) => ({ id: KEY_ID, store: storeId ? { id: storeId } : null });

describe('ApiKeysController.revoke (#162)', () => {
  const mockEm = { findOne: jest.fn() };
  const mockService = { revoke: jest.fn() };
  const controller = new ApiKeysController(mockService as any, mockEm as any);
  const revoke = (scope: TenantScope | undefined) => controller.revoke({ scope }, KEY_ID);

  beforeEach(() => {
    mockEm.findOne.mockReset();
    mockService.revoke.mockReset();
    mockService.revoke.mockResolvedValue({ id: KEY_ID, name: 'k', prefix: 'ck_xxxxxx', revokedAt: new Date() });
  });

  it('lets a store admin revoke a key of their own store', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_A1));
    const res = await revoke(adminOfA1);
    expect(mockService.revoke).toHaveBeenCalledWith(KEY_ID);
    expect(res.data.id).toBe(KEY_ID);
  });

  it('404s a key belonging to another organization without revoking', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_B1));
    await expect(revoke(adminOfA1)).rejects.toThrow(NotFoundException);
    expect(mockService.revoke).not.toHaveBeenCalled();
  });

  it('404s a sibling-branch key of the same organization (branch-strict scope)', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_A2));
    await expect(revoke(adminOfA1)).rejects.toThrow(NotFoundException);
    expect(mockService.revoke).not.toHaveBeenCalled();
  });

  it('404s a missing key', async () => {
    mockEm.findOne.mockResolvedValue(null);
    await expect(revoke(adminOfA1)).rejects.toThrow(NotFoundException);
  });

  it('answers foreign and missing keys with the identical message (no enumeration)', async () => {
    mockEm.findOne.mockResolvedValueOnce(keyBoundTo(STORE_B1));
    const foreign = await revoke(adminOfA1).catch((e: Error) => e.message);
    mockEm.findOne.mockResolvedValueOnce(null);
    const missing = await revoke(adminOfA1).catch((e: Error) => e.message);
    expect(foreign).toBe(missing);
  });

  it('passes an already-revoked in-scope key through to the idempotent service', async () => {
    mockEm.findOne.mockResolvedValue({ ...keyBoundTo(STORE_A1), revokedAt: new Date() });
    await revoke(adminOfA1);
    expect(mockService.revoke).toHaveBeenCalledWith(KEY_ID);
  });

  it('404s a legacy storeless key for a tenant admin (fail closed)', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(null));
    await expect(revoke(adminOfA1)).rejects.toThrow(NotFoundException);
    expect(mockService.revoke).not.toHaveBeenCalled();
  });

  it('lets ONLY the globally-acting platform owner revoke a legacy storeless key', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(null));
    await revoke(globalPlatform);
    expect(mockService.revoke).toHaveBeenCalledWith(KEY_ID);
  });

  it('404s a legacy storeless key for the platform owner while managing a company', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(null));
    await expect(revoke(managedPlatform)).rejects.toThrow(NotFoundException);
    expect(mockService.revoke).not.toHaveBeenCalled();
  });

  it('allows the managed platform owner to revoke keys of the managed organization only', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_A2));
    await revoke(managedPlatform);
    expect(mockService.revoke).toHaveBeenCalledWith(KEY_ID);
    mockService.revoke.mockClear();
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_B1));
    await expect(revoke(managedPlatform)).rejects.toThrow(NotFoundException);
    expect(mockService.revoke).not.toHaveBeenCalled();
  });

  it('404s when the request carries no scope at all (fail closed)', async () => {
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_A1));
    await expect(revoke(undefined)).rejects.toThrow(NotFoundException);
    expect(mockService.revoke).not.toHaveBeenCalled();
  });
});

/**
 * P5-A2 family 3: API keys are store credentials. The target is named by the
 * REQUEST and validated against the resolved scope — never taken from the
 * actor's own binding — ORGANIZATION_MANAGER holds them organization-wide, and
 * narrowing binds every store-specific operation.
 */
describe('ApiKeysController target resolution (P5-A2 family 3)', () => {
  const orgManager = scopeOf({
    role: 'ORGANIZATION_MANAGER',
    organizationId: ORG_A,
    allowedStoreIds: [STORE_A1, STORE_A2],
  });
  const narrowedManager = { ...orgManager, storeId: STORE_A1 };

  // A decoy binding on the user: if create ever prefers it again, these fail.
  const decoyUser = { id: 'u1', store: { id: STORE_B1 } };

  const build = () => {
    const mockEm = { findOne: jest.fn().mockResolvedValue({ id: STORE_A2, organization: { id: ORG_A } }) };
    const mockService = { create: jest.fn().mockResolvedValue({ id: 'k1' }), revoke: jest.fn(), findAll: jest.fn() };
    return { controller: new ApiKeysController(mockService as any, mockEm as any), mockService, mockEm };
  };

  it('creates against the store named in the body, not the actor binding', async () => {
    const { controller, mockService } = build();
    await controller.create({ scope: orgManager, user: decoyUser }, { name: 'k', storeId: STORE_A2 } as any);
    // fourth argument = the requested capability grant; omitted here, so the
    // service applies its own read-only default (Phase 6)
    expect(mockService.create).toHaveBeenCalledWith('k', STORE_A2, 'u1', undefined);
  });

  it('refuses a store outside the organization, creating nothing', async () => {
    const { controller, mockService } = build();
    await expect(
      controller.create({ scope: orgManager, user: decoyUser }, { name: 'k', storeId: STORE_B1 } as any),
    ).rejects.toThrow(NotFoundException);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it('binds a narrowed manager to its selected branch', async () => {
    const { controller, mockService } = build();
    await expect(
      controller.create({ scope: narrowedManager, user: decoyUser }, { name: 'k', storeId: STORE_A2 } as any),
    ).rejects.toThrow(NotFoundException);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it('refuses an unscoped platform owner: credentials need a tenant context', async () => {
    const { controller, mockService } = build();
    await expect(
      controller.create({ scope: globalPlatform, user: {} }, { name: 'k', storeId: STORE_A1 } as any),
    ).rejects.toThrow(/organization context/);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it('revoke binds a narrowed manager to its branch (sibling refused)', async () => {
    const { controller, mockService, mockEm } = build();
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_A2));
    await expect(controller.revoke({ scope: narrowedManager }, KEY_ID)).rejects.toThrow(NotFoundException);
    expect(mockService.revoke).not.toHaveBeenCalled();
  });

  it('an un-narrowed manager may revoke any branch key of its organization', async () => {
    const { controller, mockService, mockEm } = build();
    mockEm.findOne.mockResolvedValue(keyBoundTo(STORE_A2));
    await controller.revoke({ scope: orgManager }, KEY_ID);
    expect(mockService.revoke).toHaveBeenCalledWith(KEY_ID);
  });
});
