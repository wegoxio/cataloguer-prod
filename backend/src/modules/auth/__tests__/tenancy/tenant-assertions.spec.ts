import { NotFoundException } from '@nestjs/common';
import {
  assertCategoryInOrganization,
  assertProductInOrganization,
  assertStoreInOrganization,
} from '../../tenancy/tenant-assertions';
import { TenantScope } from '../../tenancy/tenant-scope';

/**
 * P0-07: an actor of organization A must not even RESOLVE organization B's
 * UUIDs. Every controller guard funnels through these three helpers, so this
 * is the cross-tenant suite for products, categories, images, variants
 * (guarded via their product), api keys and sales/invoice store narrowing.
 */
describe('tenant assertions (P0-07)', () => {
  const ENTITIES: Record<string, any> = {
    'store-a': { id: 'store-a', organization: { id: 'org-acme' } },
    'store-b': { id: 'store-b', organization: { id: 'org-rival' } },
    'product-a': { id: 'product-a', organization: { id: 'org-acme' } },
    'product-b': { id: 'product-b', organization: { id: 'org-rival' } },
    'category-a': { id: 'category-a', organization: { id: 'org-acme' } },
    'category-b': { id: 'category-b', organization: { id: 'org-rival' } },
  };
  const em: any = { findOne: jest.fn(async (_e: any, where: any) => ENTITIES[where.id] ?? null) };

  const acme: TenantScope = {
    platform: false,
    organizationId: 'org-acme',
    storeId: 'store-a',
    allowedStoreIds: ['store-a'],
    role: 'ADMIN',
  };
  const platform: TenantScope = {
    platform: true,
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
    role: 'SUPER_ADMIN',
  };

  const table = [
    ['store', assertStoreInOrganization, 'store-a', 'store-b'],
    ['product', assertProductInOrganization, 'product-a', 'product-b'],
    ['category', assertCategoryInOrganization, 'category-a', 'category-b'],
  ] as const;

  describe.each(table)('%s', (_label, assertFn, ownId, foreignId) => {
    it('passes for an id of the own organization', async () => {
      await expect(assertFn(em, acme, ownId)).resolves.toBeUndefined();
    });

    it("refuses another organization's id with 404, not 403", async () => {
      // 404 on purpose: a foreign id must look identical to a nonexistent one
      await expect(assertFn(em, acme, foreignId)).rejects.toThrow(NotFoundException);
    });

    it('refuses an id that does not exist at all — indistinguishably', async () => {
      await expect(assertFn(em, acme, 'ghost')).rejects.toThrow(NotFoundException);
    });

    it('lets the global platform owner through', async () => {
      await expect(assertFn(em, platform, foreignId)).resolves.toBeUndefined();
    });

    it('refuses everything when the request has no scope at all', async () => {
      await expect(assertFn(em, undefined, ownId)).rejects.toThrow(NotFoundException);
    });
  });
});
