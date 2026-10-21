import { describe, it, expect } from 'vitest';
import { canManageCatalogue } from '../../lib/permissions';

/**
 * ONE permission model for grouping, wherever grouping is offered.
 *
 * The Items page derives a single `canManage` from `canManageCatalogue` and
 * hands the SAME value to the bulk actions bar (which owns the PR B grouping
 * button) and to the suggestions banner. That is what stops the two surfaces
 * drifting into different ideas of who may group, which is exactly how the
 * suggestions page and Items diverged in the first place.
 *
 * This pins the model against the server's own list. `CATALOGUE_ADMIN_ROLES`
 * in `products.controller.ts` gates `POST families`, `POST families/validate`
 * and `POST family-suggestions/dismiss`, and reads:
 *
 *   ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN']
 *
 * If the two ever disagree the interface offers a button the server refuses,
 * or hides one it would have accepted.
 */
const scope = (over: Record<string, unknown> = {}) =>
  ({
    platform: false,
    role: 'ORGANIZATION_MANAGER',
    organizationId: 'org-1',
    storeId: null,
    allowedStoreIds: [],
    ...over,
  }) as never;

/** The backend's gate on dismiss, validate and create, transcribed. */
const SERVER_CATALOGUE_ADMIN_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'];

describe('who the interface offers grouping and dismissal to', () => {
  describe('agrees with the server, role for role', () => {
    for (const role of SERVER_CATALOGUE_ADMIN_ROLES) {
      it(`${role} is offered the controls`, () => {
        expect(canManageCatalogue(scope({ role, platform: role === 'SUPER_ADMIN' }))).toBe(true);
      });
    }

    for (const role of ['EDITOR', 'VIEWER']) {
      it(`${role} is offered none`, () => {
        expect(canManageCatalogue(scope({ role }))).toBe(false);
      });
    }
  });

  describe('and refuses what a scope cannot support', () => {
    it('an actor with no company at all', () => {
      expect(canManageCatalogue(scope({ organizationId: null }))).toBe(false);
    });

    it('no scope resolved yet — fail closed rather than guess', () => {
      expect(canManageCatalogue(null as never)).toBe(false);
      expect(canManageCatalogue(undefined as never)).toBe(false);
    });

    /** The platform owner working outside any company still administers. */
    it('an unscoped platform owner keeps it', () => {
      expect(canManageCatalogue(scope({ role: 'SUPER_ADMIN', platform: true, organizationId: null }))).toBe(true);
    });

    it('a branch-narrowed manager keeps it — grouping is per product, not per company', () => {
      expect(canManageCatalogue(scope({ role: 'ADMIN', storeId: 'store-a' }))).toBe(true);
    });
  });

  /**
   * The frontend gate is a COURTESY, never the boundary. Every one of these
   * roles is refused by the server too — see the role matrix in
   * `backend/src/modules/products/suggestion-wire.http.spec.ts`, which drives
   * the real `RolesGuard` and asserts the 403.
   */
  it('never claims to be the security boundary', () => {
    const readOnly = ['EDITOR', 'VIEWER'];
    for (const role of readOnly) {
      expect(canManageCatalogue(scope({ role }))).toBe(false);
      expect(SERVER_CATALOGUE_ADMIN_ROLES).not.toContain(role);
    }
  });
});
