import { productImageAuthorityOf } from '../../authorization/product-image-authority';
import { TenantScope } from '../../tenancy/tenant-scope';

/**
 * THE AUTHORITY COMES FROM THE RESOLVED SCOPE, AND NAMES ONE OF THREE THINGS.
 *
 * The bug this replaces: `req.scope?.storeId ?? null` was handed to the URL
 * policy, where null meant "any bank" — so a store-less ORGANIZATION_MANAGER
 * (whose `storeId` is legitimately null) could attach ANOTHER COMPANY's
 * `assets/<store>/…` URL to its own product.
 */
const scope = (over: Partial<TenantScope>): TenantScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-a',
  storeId: null,
  allowedStoreIds: ['store-a1', 'store-a2'],
  ...over,
});

describe('productImageAuthorityOf', () => {
  it('an unscoped platform owner acts globally', () => {
    expect(
      productImageAuthorityOf({
        platform: true,
        role: 'SUPER_ADMIN',
        organizationId: null,
        storeId: null,
        allowedStoreIds: [],
      }),
    ).toEqual({ kind: 'platform' });
  });

  it('a store-less manager gets its OWN COMPANY’s branches — never "any bank"', () => {
    expect(productImageAuthorityOf(scope({}))).toEqual({
      kind: 'organization',
      allowedStoreIds: ['store-a1', 'store-a2'],
    });
  });

  it('a SUPER_ADMIN managing a company is an organization actor, not a global one', () => {
    expect(productImageAuthorityOf(scope({ platform: true, role: 'SUPER_ADMIN' }))).toEqual({
      kind: 'organization',
      allowedStoreIds: ['store-a1', 'store-a2'],
    });
  });

  it('narrowing to a branch wins over the company list, whatever the role', () => {
    expect(productImageAuthorityOf(scope({ storeId: 'store-a1' }))).toEqual({
      kind: 'store',
      storeId: 'store-a1',
    });
    expect(
      productImageAuthorityOf(scope({ role: 'ADMIN', storeId: 'store-a1', allowedStoreIds: ['store-a1'] })),
    ).toEqual({ kind: 'store', storeId: 'store-a1' });
  });

  it('copies the list rather than aliasing the live scope', () => {
    const live = scope({});
    const authority = productImageAuthorityOf(live) as { allowedStoreIds: string[] };
    live.allowedStoreIds.push('store-z');
    expect(authority.allowedStoreIds).toEqual(['store-a1', 'store-a2']);
  });

  it('a scope that resolved to nothing grants nothing', () => {
    expect(productImageAuthorityOf(undefined)).toEqual({ kind: 'organization', allowedStoreIds: [] });
    expect(productImageAuthorityOf(scope({ organizationId: null, allowedStoreIds: [] }))).toEqual({
      kind: 'organization',
      allowedStoreIds: [],
    });
  });
});
