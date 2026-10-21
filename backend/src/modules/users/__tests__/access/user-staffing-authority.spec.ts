import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UsersController } from '../../users.controller';
import { UsersService } from '../../users.service';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * P5-A2 family 6 — team and staffing authority.
 *
 * ADR 014 gives ORGANIZATION_MANAGER users and store assignments inside its own
 * company. Two things had to change together, and both are pinned here:
 *
 *   1. the ROLE LISTS — every route carries a complete explicit list, because
 *      an absent list admits every authenticated role;
 *   2. the TENANT WALL — `getManagedUser` walled targets with
 *      `actor.store && user.store?.id !== actor.store.id`, which walled nothing
 *      at all for a store-less actor. Widening the routes without fixing that
 *      would have handed the manager every company's users.
 */

const STAFFING = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'];
const ORGANIZATION_ONLY = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER'];

const admits = (handler: (...args: any[]) => unknown, roleName: string): boolean => {
  const guard = new RolesGuard(new Reflector());
  try {
    return (
      guard.canActivate({
        getHandler: () => handler,
        getClass: () => UsersController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: roleName } } }) }),
      } as any) === true
    );
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
};

describe('staffing route authority', () => {
  const P = UsersController.prototype;

  it('every staffing route carries the complete explicit list', () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController)).toEqual(STAFFING);
    expect(Reflect.getMetadata(ROLES_KEY, P.create)).toEqual(STAFFING);
    expect(Reflect.getMetadata(ROLES_KEY, P.resendInvite)).toEqual(STAFFING);
  });

  it('store assignment is organization authority — ADMIN excluded (D-6.2)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, P.setStore)).toEqual(ORGANIZATION_ONLY);
    expect(admits(P.setStore, 'ADMIN')).toBe(false);
    for (const role of ORGANIZATION_ONLY) expect(admits(P.setStore, role)).toBe(true);
  });

  it.each([
    ['create', () => UsersController.prototype.create],
    ['setStore', () => UsersController.prototype.setStore],
    ['resendInvite', () => UsersController.prototype.resendInvite],
    ['updateRole', () => UsersController.prototype.updateRole],
    ['deactivate', () => UsersController.prototype.deactivate],
    ['reactivate', () => UsersController.prototype.reactivate],
    ['resetPassword', () => UsersController.prototype.resetPassword],
  ])('%s admits no role outside the staffing list', (_name, handler) => {
    for (const role of ['EDITOR', 'VIEWER']) {
      expect(admits(handler(), role)).toBe(false);
    }
  });
});

/**
 * The tenant wall itself, exercised through the real service against mocked
 * repositories. `getManagedUser` is private, so every case runs through a
 * public method that funnels into it.
 */
describe('the managed-user wall is the resolved scope, not the actor binding', () => {
  const ORG_A = 'org-a';
  const ORG_B = 'org-b';
  const STORE_A1 = 'store-a1';
  const STORE_A2 = 'store-a2';

  const scopeOf = (over: Partial<TenantScope>): TenantScope => ({
    platform: false,
    role: 'ORGANIZATION_MANAGER',
    organizationId: ORG_A,
    storeId: null,
    allowedStoreIds: [STORE_A1, STORE_A2],
    ...over,
  });

  // The actor carries a DECOY binding: any read of it breaks these cases.
  const actor: any = { id: 'om-1', email: 'om@alpha.com', role: { name: 'ORGANIZATION_MANAGER' }, store: null };

  const build = (target: any) => {
    // `transactional` runs the callback against this same mock: the service
    // now performs its lockout checks and its write in ONE transaction, so a
    // mock without it would model an entity manager the service never uses.
    // The transaction-bound manager now does three more things the service
    // depends on: it takes advisory and row locks (`execute`), it RELOADS the
    // target so no decision rests on a pre-lock snapshot (`findOne`), and it
    // writes the audit through the caller's transaction.
    const em: Record<string, unknown> = {
      persistAndFlush: jest.fn(),
      flush: jest.fn(),
      nativeUpdate: jest.fn(),
      execute: jest.fn().mockResolvedValue([{ c: 2 }]),
      findOne: jest.fn().mockResolvedValue(target),
    };
    em.transactional = jest.fn((callback: (tem: unknown) => unknown) => callback(em));
    const userRepository = {
      findOne: jest.fn().mockResolvedValue(target),
      getEntityManager: () => em,
      count: jest.fn().mockResolvedValue(0),
    };
    const auditLogService = { recordAuditEntry: jest.fn(), recordAuditEntryIn: jest.fn() };
    // Named, minimal doubles in the real constructor order:
    // users, roles, reset tokens, audit, mail, config.
    const roleRepository = { findOne: jest.fn().mockResolvedValue({ name: 'EDITOR' }) };
    const resetTokenRepository = { getEntityManager: () => ({ nativeDelete: jest.fn(), persistAndFlush: jest.fn() }) };
    const mailService = { send: jest.fn() };
    const configService = { get: jest.fn() };
    const service = new UsersService(
      userRepository as any,
      roleRepository as any,
      resetTokenRepository as any,
      auditLogService as any,
      mailService as any,
      configService as any,
    );
    return { service, em, auditLogService };
  };

  const foreignTarget = {
    id: 'u-foreign',
    email: 'x@beta.com',
    role: { name: 'EDITOR' },
    organization: { id: ORG_B },
    store: { id: 'store-b1', organization: { id: ORG_B } },
    deletedAt: null,
  };
  const siblingTarget = {
    id: 'u-sibling',
    email: 'y@alpha.com',
    role: { name: 'EDITOR' },
    organization: { id: ORG_A },
    store: { id: STORE_A2, organization: { id: ORG_A } },
    deletedAt: null,
  };

  it("refuses another company's user, and writes nothing", async () => {
    const { service, em, auditLogService } = build(foreignTarget);
    await expect(service.deactivate(scopeOf({}), actor, 'u-foreign')).rejects.toThrow(NotFoundException);
    expect(em.flush).not.toHaveBeenCalled();
    expect(em.nativeUpdate).not.toHaveBeenCalled();
    expect(auditLogService.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses a SIBLING branch user for a narrowed actor', async () => {
    const { service, em } = build(siblingTarget);
    await expect(service.deactivate(scopeOf({ storeId: STORE_A1 }), actor, 'u-sibling')).rejects.toThrow(
      NotFoundException,
    );
    expect(em.flush).not.toHaveBeenCalled();
  });

  it('refuses the unscoped platform owner — staffing is a tenant mutation', async () => {
    const { service, em } = build(siblingTarget);
    const unscoped = scopeOf({ platform: true, role: 'SUPER_ADMIN', organizationId: null, allowedStoreIds: [] });
    await expect(service.deactivate(unscoped, actor, 'u-sibling')).rejects.toThrow(ForbiddenException);
    expect(em.flush).not.toHaveBeenCalled();
  });

  it('refuses a request carrying no resolved scope at all', async () => {
    const { service } = build(siblingTarget);
    await expect(service.deactivate(undefined, actor, 'u-sibling')).rejects.toThrow(ForbiddenException);
  });

  it('admits an un-narrowed manager on any branch of its own company', async () => {
    const { service } = build(siblingTarget);
    await expect(service.deactivate(scopeOf({}), actor, 'u-sibling')).resolves.toBeDefined();
  });
});
