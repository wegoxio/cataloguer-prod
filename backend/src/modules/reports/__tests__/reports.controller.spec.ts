import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReportsController } from '../reports.controller';

/** P0-08 acceptance: who may aggregate which branches. */
describe('ReportsController', () => {
  let controller: ReportsController;
  let service: any;

  beforeEach(() => {
    service = { summary: jest.fn().mockResolvedValue({ ok: true }) };
    controller = new ReportsController(service);
  });

  it('an ORGANIZATION_MANAGER aggregates one or several of its branches', async () => {
    const scope = {
      platform: false,
      organizationId: 'org-acme',
      storeId: null,
      allowedStoreIds: ['store-a1', 'store-a2'],
      role: 'ORGANIZATION_MANAGER',
    };

    await controller.summary({ scope }, 'store-a1,store-a2');

    expect(service.summary).toHaveBeenCalledWith('org-acme', ['store-a1', 'store-a2']);
  });

  it('with no selection, a company-level actor reports on the whole organization', async () => {
    const scope = {
      platform: false,
      organizationId: 'org-acme',
      storeId: null,
      allowedStoreIds: ['store-a1', 'store-a2'],
      role: 'ORGANIZATION_MANAGER',
    };

    await controller.summary({ scope }, undefined);

    expect(service.summary).toHaveBeenCalledWith('org-acme', []);
  });

  it('a STORE_ADMIN with no selection reports on its own branch only', async () => {
    const scope = {
      platform: false,
      organizationId: 'org-acme',
      storeId: 'store-a1',
      allowedStoreIds: ['store-a1'],
      role: 'STORE_ADMIN',
    };

    await controller.summary({ scope }, undefined);

    expect(service.summary).toHaveBeenCalledWith('org-acme', ['store-a1']);
  });

  it('a STORE_ADMIN naming a sibling branch is refused with 404', async () => {
    const scope = {
      platform: false,
      organizationId: 'org-acme',
      storeId: 'store-a1',
      allowedStoreIds: ['store-a1'],
      role: 'STORE_ADMIN',
    };

    await expect(controller.summary({ scope }, 'store-a2')).rejects.toThrow(NotFoundException);
    expect(service.summary).not.toHaveBeenCalled();
  });

  it('a batch mixing a foreign store is refused entirely', async () => {
    const scope = {
      platform: false,
      organizationId: 'org-acme',
      storeId: null,
      allowedStoreIds: ['store-a1', 'store-a2'],
      role: 'ORGANIZATION_MANAGER',
    };

    await expect(controller.summary({ scope }, 'store-a1,store-rival')).rejects.toThrow(NotFoundException);
    expect(service.summary).not.toHaveBeenCalled();
  });

  it('the platform owner outside any company gets no report at all', async () => {
    const scope = { platform: true, organizationId: null, storeId: null, allowedStoreIds: [], role: 'SUPER_ADMIN' };

    await expect(controller.summary({ scope }, undefined)).rejects.toThrow(BadRequestException);
  });
});
