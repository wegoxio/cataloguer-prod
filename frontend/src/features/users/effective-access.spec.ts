import { describe, it, expect } from 'vitest';
import { effectiveAccessPreview, hypotheticalScope, roleNeedsStore } from './effective-access';

/**
 * The preview must be the SAME truth the screens gate on (Phase 8 B). These
 * cases pin the distinctions the workflow turns on — above all the store-less
 * organization manager against the single-store administrator.
 */
const allowedOf = (role: string, storeId: string | null) =>
  new Map(effectiveAccessPreview(role, storeId).map((line) => [line.label, line.allowed]));

describe('effectiveAccessPreview', () => {
  it('organization manager: the whole company, commands included', () => {
    const access = allowedOf('ORGANIZATION_MANAGER', null);
    expect(access.get('Edit the catalogue')).toBe(true);
    expect(access.get('Issue company-wide stock commands')).toBe(true);
    expect(access.get('Invite people and change roles')).toBe(true);
    expect(access.get('See company-wide metrics')).toBe(true);
  });

  it('single-store administrator: its branch, never the company commands', () => {
    const access = allowedOf('ADMIN', 'store-1');
    expect(access.get('See stock and movements')).toBe(true);
    expect(access.get('Count stock in their own branch')).toBe(true);
    // The exact line that separates the two personas (ADR 014).
    expect(access.get('Issue company-wide stock commands')).toBe(false);
    expect(access.get('See company-wide metrics')).toBe(false);
  });

  it('viewer: read-only means no operational surface at all', () => {
    const access = allowedOf('VIEWER', 'store-1');
    expect(Array.from(access.values()).every((allowed) => allowed === false)).toBe(true);
  });

  it('the hypothetical scope is shaped exactly like a resolved session scope', () => {
    expect(hypotheticalScope('ADMIN', 'store-1')).toEqual({
      platform: false,
      role: 'ADMIN',
      organizationId: 'preview-organization',
      storeId: 'store-1',
      allowedStoreIds: ['store-1'],
    });
    expect(hypotheticalScope('ORGANIZATION_MANAGER', null).allowedStoreIds).toEqual([]);
  });

  it('branch roles need a store; organization roles must not have one', () => {
    expect(roleNeedsStore('ADMIN')).toBe(true);
    expect(roleNeedsStore('EDITOR')).toBe(true);
    expect(roleNeedsStore('VIEWER')).toBe(true);
    expect(roleNeedsStore('ORGANIZATION_MANAGER')).toBe(false);
    expect(roleNeedsStore('SUPER_ADMIN')).toBe(false);
  });
});
