import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ProductsService } from '../../catalogue/products.service';
import { FamilyLearningService } from '../../families/family-learning.service';
import { Product } from '../../entities/product.entity';
import { Category } from '../../../categories/entities/category.entity';
import { CategoriesService } from '../../../categories/categories.service';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { InventoryStockService } from '../../../inventory/ledger/inventory-stock.service';
import { stockDouble } from '../../../../../test/inventory-stock-support';
import {
  ambiguousManufacturerCodeMessage,
  manufacturerCodeMatchKey,
  normalizeManufacturerCode,
  resolveByManufacturerCode,
} from '../../shared/manufacturer-code.util';

/**
 * P5-W1 — the manufacturer code, at the level the database is not needed to
 * settle: normalization, comparison, and the SEARCH the panel issues.
 *
 * Everything that depends on real rows — duplicates, cross-tenant identity,
 * ambiguity, the index and the migration — is proven against real PostgreSQL
 * in `manufacturer-code.pg.spec.ts`, because a mocked repository cannot show
 * that two products may legitimately share a code.
 */
describe('manufacturer code normalization (P5-W1)', () => {
  it('treats blank, whitespace-only and absent values as NOT STATED', () => {
    for (const blank of [null, undefined, '', '   ', '\t', '\n  \t ']) {
      expect(normalizeManufacturerCode(blank)).toBeNull();
      expect(manufacturerCodeMatchKey(blank)).toBeNull();
    }
  });

  it('trims and collapses whitespace but never rewrites the supplier value', () => {
    // Case, hyphens and punctuation belong to the supplier (decision 19).
    expect(normalizeManufacturerCode('  KARE-71234  ')).toBe('KARE-71234');
    expect(normalizeManufacturerCode('KARE   71234')).toBe('KARE 71234');
    expect(normalizeManufacturerCode('kA/re_71.234')).toBe('kA/re_71.234');
  });

  it('compares case-insensitively on the stored form', () => {
    expect(manufacturerCodeMatchKey(' KARE-71234 ')).toBe('kare-71234');
    expect(manufacturerCodeMatchKey('kare-71234')).toBe(manufacturerCodeMatchKey('KARE-71234'));
    // Collapsing happens before folding, so the two agree.
    expect(manufacturerCodeMatchKey('KARE   71234')).toBe('kare 71234');
  });

  it('does NOT conflate codes that merely look similar', () => {
    expect(manufacturerCodeMatchKey('KARE-71234')).not.toBe(manufacturerCodeMatchKey('KARE71234'));
    expect(manufacturerCodeMatchKey('KARE-71234')).not.toBe(manufacturerCodeMatchKey('KARE-71235'));
  });

  it('refuses to resolve without a company rather than widening the query', async () => {
    const em: any = { execute: jest.fn() };
    await expect(resolveByManufacturerCode(em, '', 'KARE-1')).rejects.toThrow(
      'resolveByManufacturerCode requires an organization',
    );
    expect(em.execute).not.toHaveBeenCalled();
  });

  it('never queries at all for a blank code', async () => {
    const em: any = { execute: jest.fn() };
    await expect(resolveByManufacturerCode(em, 'org-1', '   ')).resolves.toEqual({ outcome: 'BLANK' });
    expect(em.execute).not.toHaveBeenCalled();
  });

  it('scopes the lookup by organization, excludes archived rows, and folds case', async () => {
    const em: any = { execute: jest.fn().mockResolvedValue([]) };
    await resolveByManufacturerCode(em, 'org-1', ' KARE-71234 ');
    const [sql, params] = em.execute.mock.calls[0];
    expect(sql).toContain('organization_id = ?::uuid');
    expect(sql).toContain('archived_at is null');
    expect(sql).toContain('lower(manufacturer_code) = ?');
    expect(params).toEqual(['org-1', 'kare-71234']);
  });

  it('reports one match as UNIQUE and several as AMBIGUOUS, keeping every candidate', async () => {
    const em: any = { execute: jest.fn().mockResolvedValue([{ id: 'p-1' }]) };
    await expect(resolveByManufacturerCode(em, 'org-1', 'KARE-1')).resolves.toEqual({
      outcome: 'UNIQUE',
      code: 'KARE-1',
      productId: 'p-1',
    });

    em.execute.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }]);
    await expect(resolveByManufacturerCode(em, 'org-1', 'KARE-1')).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      code: 'KARE-1',
      productIds: ['p-1', 'p-2', 'p-3'],
    });
  });

  it('names the code and the count in the refusal message, and never a chosen product', () => {
    const message = ambiguousManufacturerCodeMessage('KARE-1', 3);
    expect(message).toContain("'KARE-1'");
    expect(message).toContain('3 products');
    expect(message).toMatch(/not applied/i);
  });
});

describe('administrative search covers SKU and manufacturer code (P5-W1)', () => {
  let service: ProductsService;
  let mockProductRepo: any;

  beforeEach(async () => {
    mockProductRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn(),
      getEntityManager: jest.fn().mockReturnValue({ find: jest.fn().mockResolvedValue([]) }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: InventoryStockService, useValue: stockDouble() },
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: mockProductRepo },
        {
          provide: getRepositoryToken(Category),
          useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() },
        },
        { provide: CategoriesService, useValue: { findAssignableCategory: jest.fn(), findById: jest.fn() } },
        {
          provide: FamilyLearningService,
          useValue: {
            learnedWordsFor: jest.fn(),
            dismissedSignaturesFor: jest.fn(),
            learnFromAcceptedGroup: jest.fn(),
          },
        },
        { provide: AuditLogService, useValue: { recordAuditEntry: jest.fn() } },
        PublicationGuardService,
        { provide: ProductFieldsService, useValue: { writeCreationValues: jest.fn() } },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  const searchClauses = () => {
    const where = mockProductRepo.findAndCount.mock.calls[0][0];
    const orClause = where.$and.find((clause: any) => Array.isArray(clause.$or) && clause.$or.length > 2);
    return orClause.$or;
  };

  it('searches the manufacturer code ALONGSIDE the SKU, never instead of it', async () => {
    await service.findAll({ organizationId: 'org-1', search: 'KARE-712' });
    const clauses = searchClauses();

    // The pre-existing identity clauses are untouched.
    expect(clauses).toContainEqual({ sku: { $ilike: '%KARE-712%' } });
    expect(clauses).toContainEqual({ name: { $ilike: '%KARE-712%' } });
    expect(clauses).toContainEqual({ slug: { $ilike: '%KARE-712%' } });
    // And the supplier's reference is now searchable too.
    expect(clauses).toContainEqual({ manufacturerCode: { $ilike: '%KARE-712%' } });
  });

  it('surfaces a family card when one of its CHILDREN carries the code', async () => {
    await service.findAll({ organizationId: 'org-1', search: 'KARE-712' });
    expect(searchClauses()).toContainEqual({
      children: { $some: { manufacturerCode: { $ilike: '%KARE-712%' }, archivedAt: null } },
    });
  });

  it('keeps the company predicate on every search', async () => {
    await service.findAll({ organizationId: 'org-1', search: 'KARE-712' });
    const where = mockProductRepo.findAndCount.mock.calls[0][0];
    expect(where.$and).toContainEqual({ organization: 'org-1' });
  });
});
