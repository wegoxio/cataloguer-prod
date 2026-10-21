import { ForbiddenException } from '@nestjs/common';
import { CatalogueLiveController } from '../catalogue-live.controller';

/**
 * #175 (P2-12): the panel's live-counts endpoint must be tenant-safe. It reads
 * only within the request's VALIDATED scope (built upstream by
 * TenantScopeService), and fails closed for any actor — SUPER_ADMIN included —
 * that has no organization or store in scope, without ever touching the
 * catalogue service.
 */
describe('CatalogueLiveController', () => {
  const build = () => {
    const service = {
      getProducts: jest.fn().mockResolvedValue({ total: 7 }),
      getCategories: jest.fn().mockResolvedValue({ total: 3 }),
    };
    return { controller: new CatalogueLiveController(service as any), service };
  };

  it('store-bound scope: queries the actor’s own store AND organization', async () => {
    const { controller, service } = build();
    const res = await controller.liveCounts({
      scope: { platform: false, organizationId: 'org-1', storeId: 'store-1', role: 'ADMIN' },
    });
    expect(service.getProducts).toHaveBeenCalledWith({ organizationId: 'org-1', storeId: 'store-1', limit: 1 });
    expect(service.getCategories).toHaveBeenCalledWith({ organizationId: 'org-1', storeId: 'store-1', limit: 1 });
    expect(res).toEqual({ data: { products: 7, categories: 3 } });
  });

  it('organization-level scope with no store: confines the query to that organization', async () => {
    const { controller, service } = build();
    await controller.liveCounts({
      scope: { platform: false, organizationId: 'org-2', storeId: null, role: 'ORGANIZATION_MANAGER' },
    });
    expect(service.getProducts).toHaveBeenCalledWith({ organizationId: 'org-2', storeId: undefined, limit: 1 });
    expect(service.getCategories).toHaveBeenCalledWith({ organizationId: 'org-2', storeId: undefined, limit: 1 });
  });

  it('managed SUPER_ADMIN: uses only the validated managed organization/store', async () => {
    const { controller, service } = build();
    // TenantScopeService already validated & resolved the managed context
    await controller.liveCounts({
      scope: { platform: true, organizationId: 'org-managed', storeId: 'store-managed', role: 'SUPER_ADMIN' },
    });
    expect(service.getProducts).toHaveBeenCalledWith({
      organizationId: 'org-managed',
      storeId: 'store-managed',
      limit: 1,
    });
  });

  it('unmanaged SUPER_ADMIN (platform, no org/store): 403 and no catalogue query', async () => {
    const { controller, service } = build();
    await expect(
      controller.liveCounts({ scope: { platform: true, organizationId: null, storeId: null, role: 'SUPER_ADMIN' } }),
    ).rejects.toThrow(ForbiddenException);
    expect(service.getProducts).not.toHaveBeenCalled();
    expect(service.getCategories).not.toHaveBeenCalled();
  });

  it('missing scope entirely: 403 and no catalogue query', async () => {
    const { controller, service } = build();
    await expect(controller.liveCounts({})).rejects.toThrow(ForbiddenException);
    expect(service.getProducts).not.toHaveBeenCalled();
    expect(service.getCategories).not.toHaveBeenCalled();
  });
});
