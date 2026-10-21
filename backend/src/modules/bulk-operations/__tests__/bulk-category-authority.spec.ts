import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BulkOperationsController } from '../bulk-operations.controller';
import { BulkOperationsService } from '../bulk-operations.service';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { ProductStatus } from '../../products/catalogue/product-status.enum';
import { ProductsService } from '../../products/catalogue/products.service';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { Action, EntityType } from '../../audit-log/entities/audit-log.entity';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { InventoryStockService } from '../../inventory/ledger/inventory-stock.service';
import { stockDouble } from '../../../../test/inventory-stock-support';

/**
 * P5-A0: POST /bulk/products/category shipped with no @Roles at all, so any
 * authenticated role — including VIEWER — could bulk re-categorize the
 * organization's catalogue (issue #157's surviving remnant). The route
 * mutates organization-owned shared data with no enforceable own-store
 * restriction, so under the approved authority model it belongs to
 * SUPER_ADMIN (explicitly scoped) and ORGANIZATION_MANAGER only.
 */

/** Minimal stand-in for MikroORM's Collection: only what bulkCategory touches. */
function folders(initial: any[] = []) {
  let items = [...initial];
  return {
    getItems: () => items,
    set: jest.fn((next: any[]) => {
      items = [...next];
    }),
  };
}

const emptyResult = { successCount: 0, failedCount: 0, successes: [], failures: [] };

function guardContextFor(roleName: string): any {
  return {
    getHandler: () => BulkOperationsController.prototype.bulkCategory,
    getClass: () => BulkOperationsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: roleName } } }) }),
  };
}

describe('P5-A0 bulk category authority', () => {
  describe('route authority metadata and guard behavior', () => {
    it('pins the handler roles to exactly SUPER_ADMIN + ORGANIZATION_MANAGER', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, BulkOperationsController.prototype.bulkCategory);
      expect(roles).toEqual(['SUPER_ADMIN', 'ORGANIZATION_MANAGER']);
    });

    it('refuses ADMIN, EDITOR and VIEWER through the committed RolesGuard', () => {
      const guard = new RolesGuard(new Reflector());
      for (const role of ['ADMIN', 'EDITOR', 'VIEWER']) {
        expect(() => guard.canActivate(guardContextFor(role))).toThrow(ForbiddenException);
      }
    });

    it('admits SUPER_ADMIN and ORGANIZATION_MANAGER through the committed RolesGuard', () => {
      const guard = new RolesGuard(new Reflector());
      expect(guard.canActivate(guardContextFor('SUPER_ADMIN'))).toBe(true);
      expect(guard.canActivate(guardContextFor('ORGANIZATION_MANAGER'))).toBe(true);
    });
  });

  describe('controller organization-context gate', () => {
    let serviceMock: { bulkCategory: jest.Mock };
    let controller: BulkOperationsController;

    beforeEach(() => {
      serviceMock = { bulkCategory: jest.fn().mockResolvedValue(emptyResult) };
      controller = new BulkOperationsController(serviceMock as any);
    });

    it('refuses a missing organization context for every actor and never reaches the service', async () => {
      const dto: any = { ids: ['11111111-1111-1111-1111-111111111111'], categoryId: null };
      await expect(controller.bulkCategory({ scope: {} } as any, dto)).rejects.toThrow(BadRequestException);
      await expect(controller.bulkCategory({} as any, dto)).rejects.toThrow(BadRequestException);
      expect(serviceMock.bulkCategory).not.toHaveBeenCalled();
    });

    it('passes the explicitly managed organization through for a scoped SUPER_ADMIN', async () => {
      const user = { id: 'u-1', email: 'owner@example.com' };
      const dto: any = { ids: ['p-1'], categoryId: 'c-1' };
      await controller.bulkCategory({ scope: { organizationId: 'org-a' }, user } as any, dto);
      expect(serviceMock.bulkCategory).toHaveBeenCalledWith('org-a', ['p-1'], 'c-1', user);
    });
  });

  describe('service organization pinning and audit context', () => {
    let service: BulkOperationsService;
    let mockProductRepo: any;
    let mockCategoryRepo: any;
    let auditLogServiceMock: { recordAuditEntry: jest.Mock };
    let mockEM: any;

    beforeEach(async () => {
      mockEM = { flush: jest.fn().mockResolvedValue(null) };
      mockProductRepo = {
        findOne: jest.fn(),
        getEntityManager: jest.fn().mockReturnValue(mockEM),
      };
      mockCategoryRepo = { findOne: jest.fn() };
      auditLogServiceMock = { recordAuditEntry: jest.fn().mockResolvedValue(undefined) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BulkOperationsService,
          { provide: InventoryStockService, useValue: stockDouble() },
          { provide: getRepositoryToken(Product), useValue: mockProductRepo },
          { provide: getRepositoryToken(Category), useValue: mockCategoryRepo },
          { provide: ProductsService, useValue: {} },
          { provide: AuditLogService, useValue: auditLogServiceMock },
          { provide: PublicationGuardService, useValue: {} },
        ],
      }).compile();
      service = module.get(BulkOperationsService);
    });

    it('resolves the category only inside the affected organization; a foreign category fails every row with zero mutation', async () => {
      mockCategoryRepo.findOne.mockResolvedValue(null); // org-pinned lookup misses the foreign category
      const categories = folders([{ id: 'cat-old' }]);
      mockProductRepo.findOne.mockResolvedValue({
        id: 'p-1',
        name: 'Chair',
        archivedAt: null,
        status: ProductStatus.PUBLISHED,
        categories,
      });

      const result = await service.bulkCategory('org-a', ['p-1'], 'cat-foreign', {
        id: 'u-1',
        email: 'om@example.com',
      });

      expect(mockCategoryRepo.findOne).toHaveBeenCalledWith({ id: 'cat-foreign', organization: 'org-a' });
      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(categories.set).not.toHaveBeenCalled();
      expect(mockEM.flush).not.toHaveBeenCalled();
      expect(auditLogServiceMock.recordAuditEntry).not.toHaveBeenCalled();
    });

    it('resolves every product only inside the affected organization; foreign ids are tenant-safe not-found with zero mutation', async () => {
      mockCategoryRepo.findOne.mockResolvedValue({ id: 'cat-a', archivedAt: null });
      mockProductRepo.findOne.mockResolvedValue(null); // org-pinned lookup misses the foreign product

      const result = await service.bulkCategory('org-a', ['p-foreign'], 'cat-a', {
        id: 'u-1',
        email: 'owner@example.com',
      });

      expect(mockProductRepo.findOne).toHaveBeenCalledWith({ id: 'p-foreign', organization: 'org-a' });
      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0].id).toBe('p-foreign');
      expect(mockEM.flush).not.toHaveBeenCalled();
      expect(auditLogServiceMock.recordAuditEntry).not.toHaveBeenCalled();
    });

    it('records the affected organization, actor and before/after category on the audit entry', async () => {
      mockCategoryRepo.findOne.mockResolvedValue({ id: 'cat-a', archivedAt: null });
      const categories = folders([{ id: 'cat-old' }]);
      mockProductRepo.findOne.mockResolvedValue({
        id: 'p-1',
        name: 'Chair',
        archivedAt: null,
        status: ProductStatus.PUBLISHED,
        categories,
      });

      const result = await service.bulkCategory('org-a', ['p-1'], 'cat-a', {
        id: 'u-1',
        email: 'om@example.com',
      });

      expect(result.successCount).toBe(1);
      expect(categories.set).toHaveBeenCalled();
      expect(auditLogServiceMock.recordAuditEntry).toHaveBeenCalledWith(
        'u-1',
        'om@example.com',
        EntityType.PRODUCT,
        'p-1',
        Action.BULK_CATEGORY,
        { categoryId: { before: 'cat-old', after: 'cat-a' } },
        expect.stringContaining('Bulk assigned category'),
        { organizationId: 'org-a' },
      );
    });
  });
});
