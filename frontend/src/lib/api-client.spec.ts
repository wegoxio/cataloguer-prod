import { describe, it, expect } from 'vitest';
import { carriesTenantContext } from './api-client';

/**
 * Which requests carry the "Manage company" tenant context (P5-W5 repair 3).
 *
 * The defect this pins down was published before this campaign: `/auth/me` was
 * excluded along with the rest of `/auth`, so the resolved TenantScope could
 * never describe a managed organization, `isPlatformManagingOrganization`
 * was permanently false, and the sidebar hid every catalogue module while the
 * banner said the owner was managing a company.
 *
 * The rule is tested directly rather than through a mocked `fetch`, because
 * what matters is the DECISION, and a test that asserted a header on a stubbed
 * request would pass just as happily with the decision inverted and the stub
 * adjusted to match.
 */
describe('the tenant-context rule (P5-W5 repair 3)', () => {
  it('carries the context on every ordinary endpoint', () => {
    for (const endpoint of ['/products', '/stores', '/categories/x', '/assets?photoLimit=1', '/import/preview']) {
      expect(carriesTenantContext(endpoint)).toBe(true);
    }
  });

  it('NEVER carries it on a session operation — the session stays the owner own', () => {
    for (const endpoint of ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/reset-password', '/auth']) {
      expect(carriesTenantContext(endpoint)).toBe(false);
    }
  });

  it('DOES carry it on /auth/me, which is a scope question and not a session one', () => {
    expect(carriesTenantContext('/auth/me')).toBe(true);
    expect(carriesTenantContext('/auth/me?fresh=1')).toBe(true);
  });

  it('matches /auth/me exactly, not merely as a prefix', () => {
    // A future `/auth/members` route must not inherit the exception by
    // accident: the whole point is that this is one deliberate endpoint.
    expect(carriesTenantContext('/auth/members')).toBe(false);
    expect(carriesTenantContext('/auth/mentions')).toBe(false);
  });
});
