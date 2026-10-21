import { describe, it, expect } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  NEVER_ASSIGNABLE,
  accessBody,
  accessSelectionProblem,
  describeAccess,
  isEscalation,
  rolesForShape,
  shapeOfRole,
} from './platform-access';
import { roleNeedsStore } from './effective-access';

/**
 * THE ROLE/BINDING CONTRACT, MIRRORED — and the mirror checked (#275).
 *
 * These assertions are deliberately about the CONTRACT rather than about the
 * component: if the panel's copy of the assignable roles drifts from
 * `ORGANIZATION_ASSIGNABLE_ROLES`, the screen starts offering something the
 * endpoint refuses, and no amount of component testing would notice.
 */
const t = (key: string) => key;

describe('#275 · what the panel may offer', () => {
  it('offers exactly the four roles the access contract accepts', () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(['ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER']);
  });

  it('NEVER offers SUPER_ADMIN or STORE_ADMIN, and records why', () => {
    expect(ASSIGNABLE_ROLES).not.toContain('SUPER_ADMIN' as never);
    expect(ASSIGNABLE_ROLES).not.toContain('STORE_ADMIN' as never);
    expect(Object.keys(NEVER_ASSIGNABLE).sort()).toEqual(['STORE_ADMIN', 'SUPER_ADMIN']);
  });

  it('derives the role list FROM the binding, so an illegal pair cannot be held', () => {
    expect([...rolesForShape('ORGANIZATION')]).toEqual(['ORGANIZATION_MANAGER']);
    expect([...rolesForShape('BRANCH')]).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);
    // The two lists are disjoint and together cover everything assignable.
    expect([...rolesForShape('ORGANIZATION'), ...rolesForShape('BRANCH')].sort()).toEqual([...ASSIGNABLE_ROLES].sort());
  });

  it('reads a role back to its shape', () => {
    expect(shapeOfRole('ORGANIZATION_MANAGER')).toBe('ORGANIZATION');
    for (const role of ['ADMIN', 'EDITOR', 'VIEWER']) expect(shapeOfRole(role)).toBe('BRANCH');
  });
});

describe('#275 · the body that goes on the wire', () => {
  it('sends storeId: null for the organization-wide role — a value, not an omission', () => {
    const body = accessBody('ORGANIZATION_MANAGER', 'store-1');
    expect(body).toEqual({ role: 'ORGANIZATION_MANAGER', storeId: null });
    // Present, because the DTO requires the key: "I forgot the branch" and
    // "I mean no branch" must not be the same request.
    expect('storeId' in body).toBe(true);
  });

  it('sends the chosen branch for a branch role', () => {
    expect(accessBody('ADMIN', 'store-1')).toEqual({ role: 'ADMIN', storeId: 'store-1' });
  });

  it('a stale branch selection cannot ride along with an organization-wide role', () => {
    // The operator picked a branch, then switched to company-wide. The branch
    // must not survive into the body — the endpoint would refuse it, and the
    // refusal would look like a bug rather than a contradiction.
    expect(accessBody('ORGANIZATION_MANAGER', 'left-over-store').storeId).toBeNull();
  });
});

describe('#275 · what cannot be submitted, and why', () => {
  it.each([
    ['ADMIN', null, /choose the branch/i],
    ['EDITOR', null, /choose the branch/i],
    ['VIEWER', null, /choose the branch/i],
  ])('%s without a branch is refused before the request', (role, storeId, message) => {
    expect(accessSelectionProblem(role as never, storeId)).toMatch(message);
  });

  it.each([
    ['ORGANIZATION_MANAGER', null],
    ['ORGANIZATION_MANAGER', 'store-1'],
    ['ADMIN', 'store-1'],
    ['EDITOR', 'store-1'],
    ['VIEWER', 'store-1'],
  ])('%s with %s is submittable', (role, storeId) => {
    expect(accessSelectionProblem(role as never, storeId)).toBeNull();
  });

  it('no role at all is a problem, not a silent no-op', () => {
    expect(accessSelectionProblem(null, 'store-1')).toMatch(/choose a role/i);
  });

  it('mirrors roleNeedsStore rather than restating the rule', () => {
    for (const role of ASSIGNABLE_ROLES) {
      const needsBranch = roleNeedsStore(role);
      expect(accessSelectionProblem(role, null) !== null).toBe(needsBranch);
    }
  });
});

describe('#275 · escalation and description', () => {
  it('promotion to company-wide authority is an escalation; nothing else is', () => {
    expect(isEscalation('ADMIN', 'ORGANIZATION_MANAGER')).toBe(true);
    expect(isEscalation('VIEWER', 'ORGANIZATION_MANAGER')).toBe(true);
    expect(isEscalation('ORGANIZATION_MANAGER', 'ORGANIZATION_MANAGER')).toBe(false);
    expect(isEscalation('ORGANIZATION_MANAGER', 'ADMIN')).toBe(false);
    expect(isEscalation('VIEWER', 'ADMIN')).toBe(false);
  });

  it('states access as a sentence, not a code', () => {
    expect(describeAccess('ORGANIZATION_MANAGER', 'Acme', null, t)).toBe('Company-wide in Acme');
    expect(describeAccess('ADMIN', 'Acme', 'Centro', t)).toBe('Branch: Acme · Centro');
  });

  it('says what is missing rather than rendering an empty gap', () => {
    expect(describeAccess('ORGANIZATION_MANAGER', null, null, t)).toBe('Company-wide in no company');
    expect(describeAccess('ADMIN', 'Acme', null, t)).toBe('Branch: Acme · no branch');
  });
});
