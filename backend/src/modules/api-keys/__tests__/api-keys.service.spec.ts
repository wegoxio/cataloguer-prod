import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { createHash } from 'crypto';
import { ApiKeysService } from '../api-keys.service';
import { ApiKey } from '../entities/api-key.entity';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('ApiKeysService', () => {
  let service: ApiKeysService;
  let mockRepo: any;
  let mockEm: any;

  beforeEach(async () => {
    mockEm = {
      // #294: verify() re-reads the company lifecycle with a raw statement; an active company here.
      execute: jest.fn(async () => [{ archivedAt: null, mergedIntoOrganizationId: null, removedAt: null }]),
      persistAndFlush: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue({ id: 'store-1', name: 'Default Store', archivedAt: null }),
    };
    mockRepo = {
      create: jest.fn((data) => ({ id: 'key-1', ...data })),
      findOne: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      getEntityManager: jest.fn().mockReturnValue(mockEm),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiKeysService, { provide: getRepositoryToken(ApiKey), useValue: mockRepo }],
    }).compile();

    service = module.get(ApiKeysService);
  });

  it('creates a key returning the secret once and storing only its hash', async () => {
    const created = await service.create('Client website', 'store-1');

    expect(created.key).toMatch(/^ck_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.key.slice(0, 10));
    const persisted = mockEm.persistAndFlush.mock.calls[0][0];
    expect(persisted.keyHash).toBe(sha256(created.key));
    expect(persisted.keyHash).not.toContain(created.key);
  });

  // Phase 6: capability scoping at issuance
  describe('capabilities', () => {
    it('defaults an omitted grant to CATALOGUE_READ only — never the legacy everything-key', async () => {
      const created = await service.create('Client website', 'store-1');
      expect(created.capabilities).toEqual(['CATALOGUE_READ']);
      expect(mockEm.persistAndFlush.mock.calls[0][0].capabilities).toEqual(['CATALOGUE_READ']);
    });

    it('normalizes an explicit grant: dedupes and returns canonical order', async () => {
      const created = await service.create('Checkout key', 'store-1', undefined, [
        'ORDER_CREATE',
        'CATALOGUE_READ',
        'ORDER_CREATE',
      ]);
      expect(created.capabilities).toEqual(['CATALOGUE_READ', 'ORDER_CREATE']);
    });

    it('refuses unknown capability literals loudly', async () => {
      await expect(
        service.create('Typo key', 'store-1', undefined, ['CATALOGUE_READ', 'ADMIN_EVERYTHING']),
      ).rejects.toThrow(BadRequestException);
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('refuses an explicit empty grant — a key that can do nothing is a mistake', async () => {
      await expect(service.create('Empty key', 'store-1', undefined, [])).rejects.toThrow(
        'An API key needs at least one capability',
      );
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });
  });

  it('verifies a known unrevoked key and refreshes lastUsedAt', async () => {
    const stored: any = {
      keyHash: sha256('ck_valid'),
      revokedAt: null,
      lastUsedAt: null,
      capabilities: ['CATALOGUE_READ'],
    };
    mockRepo.findOne.mockResolvedValue(stored);

    await expect(service.verify('ck_valid')).resolves.toEqual({
      storeId: null,
      organizationId: null,
      capabilities: ['CATALOGUE_READ'],
    });
    expect(stored.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rejects revoked keys', async () => {
    mockRepo.findOne.mockResolvedValue({ keyHash: sha256('ck_revoked'), revokedAt: new Date() });
    await expect(service.verify('ck_revoked')).resolves.toBeNull();
  });

  it('rejects unknown keys and malformed values without a DB hit', async () => {
    mockRepo.findOne.mockResolvedValue(null);
    await expect(service.verify('ck_unknown')).resolves.toBeNull();
    await expect(service.verify('not-a-key')).resolves.toBeNull();
    await expect(service.verify('')).resolves.toBeNull();
    // malformed values never reach the repository
    expect(mockRepo.findOne).toHaveBeenCalledTimes(1);
  });

  it('revoke is idempotent', async () => {
    const stored: any = { id: 'key-1', name: 'x', prefix: 'ck_abc', revokedAt: null };
    mockRepo.findOne.mockResolvedValue(stored);

    await service.revoke('key-1');
    const firstRevokedAt = stored.revokedAt;
    await service.revoke('key-1');

    expect(stored.revokedAt).toBe(firstRevokedAt);
    expect(mockEm.flush).toHaveBeenCalledTimes(1);
  });

  describe('findAll is organization-scoped (Phase 4, C14)', () => {
    beforeEach(() => {
      mockRepo.find = jest.fn().mockResolvedValue([]);
    });

    it('refuses a listing with no organization — confirmed live: the old query returned five foreign tenants', async () => {
      await expect(service.findAll(null)).rejects.toThrow(ForbiddenException);
      expect(mockRepo.find).not.toHaveBeenCalled();
    });

    it("scopes through the key's store to ONE company", async () => {
      await service.findAll('org-1');
      expect(mockRepo.find).toHaveBeenCalledWith({ store: { organization: 'org-1' } }, expect.anything());
    });

    it('an explicit store filter narrows WITHIN the company, never across it', async () => {
      await service.findAll('org-1', 'store-1');
      // The store id alone is not trusted: it must belong to the same company,
      // so a sibling-company store id yields nothing rather than its keys.
      expect(mockRepo.find).toHaveBeenCalledWith(
        { store: { id: 'store-1', organization: 'org-1' } },
        expect.anything(),
      );
    });
  });
});
