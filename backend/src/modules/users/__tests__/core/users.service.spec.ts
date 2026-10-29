import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UsersService } from '../../users.service';
import { UsersController } from '../../users.controller';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';
import { User } from '../../entities/user.entity';
import { Role } from '../../entities/role.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { MailService } from '../../../mail/mail.service';
import { RefreshToken } from '../../../auth/entities/refresh-token.entity';
import { PasswordResetToken } from '../../../auth/entities/password-reset-token.entity';

describe('UsersService', () => {
  let service: UsersService;
  let mockUserRepo: any;
  let mockRoleRepo: any;
  let mockResetRepo: any;
  let mockEm: any;
  const createdUsers = new Map<string, any>();
  let mockTokenEm: any;
  let mockAudit: any;
  let mockMail: any;

  const superAdmin: any = { id: 'sa-1', email: 'sa@x.com', role: { name: 'SUPER_ADMIN' } };
  const admin: any = { id: 'ad-1', email: 'ad@x.com', role: { name: 'ADMIN' } };

  /**
   * P5-A2 family 6: these methods take the RESOLVED SCOPE first. The spec's
   * actors stand in for real sessions, so the scope is derived from the actor
   * exactly as the resolver would: its company, and its branch when it has one.
   */
  const scopeOf = (a: any, allowedStoreIds?: string[]): any => ({
    platform: a.role?.name === 'SUPER_ADMIN',
    role: a.role?.name,
    organizationId: a.organization?.id ?? a.store?.organization?.id ?? 'org-1',
    storeId: a.store?.id ?? null,
    allowedStoreIds: allowedStoreIds ?? (a.store?.id ? [a.store.id] : ['store-1', 'store-2']),
  });

  beforeEach(async () => {
    mockEm = {
      persistAndFlush: jest.fn(),
      persist: jest.fn(),
      flush: jest.fn(),
      execute: jest.fn().mockResolvedValue([{ c: 2 }]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((_entity: any, data: any) => {
        const created = { id: 'new-user', createdAt: new Date(), ...data };
        createdUsers.set(created.id, created);
        return created;
      }),
      nativeUpdate: jest.fn(),
      // P0-04: store lookups now resolve the owning organization
      findOne: jest.fn().mockResolvedValue(null),
    };
    // #274: the hardened writers RELOAD the target inside the transaction, so
    // the transactional manager must answer with the same user the repository
    // does — otherwise the mock models a database where the row vanished
    // between the pre-flight and the lock.
    mockEm.transactional = jest.fn((callback: any) => callback(mockEm));
    // #274: the hardened writers RELOAD the target through the TRANSACTIONAL
    // manager, so a User lookup there must answer with the same row the
    // repository does — otherwise the mock describes a database in which the
    // user vanished between the pre-flight and the lock. Every other entity
    // (Store, Organization) keeps the existing null default.
    mockEm.findOne = jest.fn((entity: any, where: any, options?: any) =>
      entity === User ? mockUserRepo.findOne(where, options) : Promise.resolve(null),
    );
    // #276: the invitation token is now created through the ENTITY MANAGER, so
    // it can be issued inside a caller's transaction (`issueInviteTokenIn`)
    // rather than committing separately after the user. The mock models the
    // manager the service actually uses.
    createdUsers.clear();
    mockTokenEm = {
      persistAndFlush: jest.fn(),
      nativeDelete: jest.fn(),
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'token-1', ...data })),
      persist: jest.fn(),
      flush: jest.fn(),
      getReference: jest.fn((_entity: unknown, id: string) => ({ id })),
      // #277 P2: an invitation is issued inside a transaction, under
      // org-access and the member row, after the company's lifecycle is
      // re-read under lock; an ACTIVE company answers here.
      execute: jest.fn(async (sql: string) =>
        String(sql).includes('merged_into_organization_id')
          ? [{ archivedAt: null, mergedIntoOrganizationId: null, removedAt: null }]
          : [],
      ),
      // the cleared-fork reload reads through the same mock
      fork: jest.fn(function (this: unknown) {
        return this;
      }),
      // #277 P2: issuance RELOADS the member under the row lock; the mock
      // answers with the user the repository just created, or would find.
      findOne: jest.fn(
        async (_entity: unknown, where: { id: string }) =>
          createdUsers.get(where.id) ?? (await mockUserRepo.findOne(where)),
      ),
    };
    mockTokenEm.transactional = jest.fn((callback: any) => callback(mockTokenEm));
    mockUserRepo = {
      findOne: jest.fn(),
      // A store is now always present on invite, so the plan seat check runs
      count: jest.fn().mockResolvedValue(0),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn((data) => {
        const created = { id: 'new-user', createdAt: new Date(), ...data };
        createdUsers.set(created.id, created);
        return created;
      }),
      getEntityManager: jest.fn().mockReturnValue(mockEm),
    };
    mockRoleRepo = {
      findOne: jest.fn(),
    };
    mockResetRepo = {
      create: jest.fn((data) => data),
      getEntityManager: jest.fn().mockReturnValue(mockTokenEm),
    };
    mockAudit = { recordAuditEntry: jest.fn(), recordAuditEntryIn: jest.fn() };
    mockMail = {
      send: jest.fn().mockResolvedValue(true),
      // Mirrors the real renderer closely enough for link assertions
      renderTemplate: jest.fn(
        (_name: string, heading: string, vars: Record<string, string>) =>
          `<html>${heading}${Object.values(vars).join(' ')}</html>`,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Role), useValue: mockRoleRepo },
        { provide: getRepositoryToken(PasswordResetToken), useValue: mockResetRepo },
        { provide: AuditLogService, useValue: mockAudit },
        { provide: MailService, useValue: mockMail },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'FRONTEND_URL' ? 'https://app.example.com' : undefined) },
        },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  describe('inviteUser', () => {
    // P0-04: a branch-level role must name its branch, which supplies the company
    const invite = { email: 'new@x.com', roleName: 'EDITOR', company: 'Acme C.A.', storeId: 'store-1' };
    const storeWithOrg = { id: 'store-1', name: 'Acme', plan: 'BASICO', organization: { id: 'org-1' } };

    it('creates a passwordless pending user and emails the onboarding link', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });
      mockEm.findOne.mockResolvedValue(storeWithOrg);

      const result = await service.inviteUser(scopeOf(superAdmin), superAdmin, invite);

      expect(result.email).toBe('new@x.com');
      expect(result.company).toBe('Acme C.A.');
      expect(result.pendingInvite).toBe(true);
      const persisted = mockEm.persistAndFlush.mock.calls[0][0];
      expect(persisted.passwordHash).toBeNull();

      // Onboarding email carries a /welcome link, never a password
      expect(mockMail.send).toHaveBeenCalledTimes(1);
      const [to, subject, html] = mockMail.send.mock.calls[0];
      expect(to).toBe('new@x.com');
      expect(subject).toContain('invited');
      expect(html).toContain('https://app.example.com/welcome?token=');
      expect(html).toContain('Acme C.A.');

      // Token stored hashed with a 7-day expiry. #276: created through the
      // ENTITY MANAGER now, so the assertion reads the manager's call — the
      // token must be able to join a caller's transaction.
      const tokenRow = mockTokenEm.create.mock.calls[0][1];
      expect(html).not.toContain(tokenRow.tokenHash);
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(tokenRow.expiresAt.getTime() - Date.now()).toBeGreaterThan(sevenDays - 60_000);

      expect(mockAudit.recordAuditEntry).toHaveBeenCalledWith(
        'sa-1',
        'sa@x.com',
        'USER',
        'new-user',
        'CREATE',
        expect.anything(),
        expect.stringContaining('new@x.com'),
        // P5-A1: affected-resource context — the invited user's own bindings
        { organizationId: 'org-1', storeId: 'store-1' },
      );
    });

    it('rejects duplicate emails', async () => {
      mockUserRepo.findOne.mockResolvedValue({ id: 'existing' });
      await expect(service.inviteUser(scopeOf(superAdmin), superAdmin, invite)).rejects.toThrow(BadRequestException);
    });

    it('forbids an ADMIN from inviting another ADMIN', async () => {
      await expect(service.inviteUser(scopeOf(admin), admin, { ...invite, roleName: 'ADMIN' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('forbids a SUPER_ADMIN from inviting another SUPER_ADMIN (no peer management)', async () => {
      await expect(
        service.inviteUser(scopeOf(superAdmin), superAdmin, { ...invite, roleName: 'SUPER_ADMIN' }),
      ).rejects.toThrow(ForbiddenException);
    });
    it('refuses a branch-level invite with no store (P0-04)', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });

      // P5-A2 family 6: the target branch is validated against the resolved
      // scope FIRST, so a missing store is refused before the role-binding
      // rule is reached. Both refuse; the earlier one now speaks.
      await expect(
        service.inviteUser(scopeOf(superAdmin), superAdmin, { email: 'x@x.com', roleName: 'EDITOR', company: 'Acme' }),
      ).rejects.toThrow(/target storeId is required/);
    });

    it("binds the invited user to the store's organization", async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });
      mockEm.findOne.mockResolvedValue(storeWithOrg);

      await service.inviteUser(scopeOf(superAdmin), superAdmin, invite);

      const persisted = mockEm.persistAndFlush.mock.calls[0][0];
      expect(persisted.organization).toEqual({ id: 'org-1' });
    });
  });

  describe('resendInvite', () => {
    it('re-issues the link for a pending user and invalidates old tokens', async () => {
      const pending: any = {
        id: 'u-9',
        email: 'p@x.com',
        company: 'Acme C.A.',
        role: { name: 'EDITOR' },
        // The managed-user wall reads the target's company (family 6).
        organization: { id: 'org-1' },
        passwordHash: null,
        deletedAt: null,
      };
      mockUserRepo.findOne.mockResolvedValue(pending);

      const result = await service.resendInvite(scopeOf(superAdmin), superAdmin, 'u-9');

      expect(result.pendingInvite).toBe(true);
      expect(mockTokenEm.nativeDelete).toHaveBeenCalledWith(PasswordResetToken, { user: 'u-9', usedAt: null });
      expect(mockMail.send).toHaveBeenCalledTimes(1);
    });

    it('rejects users who already finished onboarding', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'u-9',
        email: 'p@x.com',
        role: { name: 'EDITOR' },
        organization: { id: 'org-1' },
        passwordHash: 'set',
        deletedAt: null,
      });
      await expect(service.resendInvite(scopeOf(superAdmin), superAdmin, 'u-9')).rejects.toThrow('already finished');
      expect(mockMail.send).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('soft deletes the user and revokes their sessions', async () => {
      const target: any = {
        id: 'u-2',
        email: 'e@x.com',
        role: { name: 'EDITOR' },
        organization: { id: 'org-1' },
        deletedAt: null,
      };
      mockUserRepo.findOne.mockResolvedValue(target);

      const result = await service.deactivate(scopeOf(admin), admin, 'u-2');

      expect(result.deactivatedAt).toBeInstanceOf(Date);
      expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
        RefreshToken,
        { user: 'u-2', revokedAt: null },
        { revokedAt: expect.any(Date) },
      );
    });

    it('refuses to deactivate yourself', async () => {
      await expect(service.deactivate(scopeOf(admin), admin, admin.id)).rejects.toThrow(
        'You cannot manage your own account from here',
      );
    });

    it('forbids an ADMIN from deactivating a SUPER_ADMIN', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'sa-9',
        email: 's@x.com',
        role: { name: 'SUPER_ADMIN' },
        organization: { id: 'org-1' },
      });
      await expect(service.deactivate(scopeOf(admin), admin, 'sa-9')).rejects.toThrow(ForbiddenException);
    });

    it('rejects double deactivation', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'u-2',
        email: 'e@x.com',
        role: { name: 'EDITOR' },
        organization: { id: 'org-1' },
        deletedAt: new Date(),
      });
      await expect(service.deactivate(scopeOf(admin), admin, 'u-2')).rejects.toThrow('already deactivated');
    });
  });

  describe('updateRole', () => {
    // #156: role changes validate against the target's COMMITTED bindings
    const boundTarget = (role: string): any => ({
      id: 'u-2',
      email: 'e@x.com',
      role: { name: role },
      organization: { id: 'org-1' },
      store: { id: 'store-1', archivedAt: null, organization: { id: 'org-1' } },
    });

    it('changes the role and audits before/after (valid store-role transition)', async () => {
      mockUserRepo.findOne.mockResolvedValue(boundTarget('VIEWER'));
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });

      const result = await service.updateRole(scopeOf(admin), admin, 'u-2', 'EDITOR');

      expect(result.role).toBe('EDITOR');
      // #274: a role change is a MATERIAL authority change, so it is audited
      // through the TRANSACTIONAL writer — `recordAuditEntryIn`, whose first
      // argument is the caller's entity manager — rather than the forgiving
      // `recordAuditEntry` that swallows its own failures. An unrecorded
      // privilege change must not be allowed to commit.
      expect(mockAudit.recordAuditEntry).not.toHaveBeenCalled();
      expect(mockAudit.recordAuditEntryIn).toHaveBeenCalledWith(
        mockEm,
        'ad-1',
        'ad@x.com',
        'USER',
        'u-2',
        'UPDATE',
        // The revocation count travels with the change: the trail says whether
        // anyone was actually signed out, not merely that we meant to. The
        // count itself comes from `nativeUpdate`, which this mock does not
        // simulate, so only its presence is asserted here — the real number is
        // asserted against a real database in `organization-access.pg.spec.ts`.
        expect.objectContaining({ role: { before: 'VIEWER', after: 'EDITOR' } }),
        expect.any(String),
        // P5-A1: affected-resource context — the target user's own bindings
        { organizationId: 'org-1', storeId: 'store-1' },
      );
    });

    it('a role change to the SAME role writes nothing at all', async () => {
      mockUserRepo.findOne.mockResolvedValue(boundTarget('EDITOR'));
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });

      const result = await service.updateRole(scopeOf(admin), admin, 'u-2', 'EDITOR');

      expect(result.role).toBe('EDITOR');
      expect(mockAudit.recordAuditEntryIn).not.toHaveBeenCalled();
      expect(mockEm.nativeUpdate).not.toHaveBeenCalled();
    });

    it('forbids elevating a user to the actor level', async () => {
      mockUserRepo.findOne.mockResolvedValue(boundTarget('EDITOR'));
      await expect(service.updateRole(scopeOf(admin), admin, 'u-2', 'ADMIN')).rejects.toThrow(ForbiddenException);
    });

    it('an unbound user cannot become any tenant role (#156)', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'u-2',
        email: 'e@x.com',
        role: { name: 'VIEWER' },
        organization: null,
        store: null,
      });
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });

      // Family 6: a user row belonging to NO company is not in the caller's
      // company either, so the tenant wall refuses it before the binding rule
      // is consulted. (The binding rule itself is still pinned by the
      // organization-only and organization/store-mismatch cases below.)
      await expect(service.updateRole(scopeOf(superAdmin), superAdmin, 'u-2', 'EDITOR')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('an organization-only user cannot become a store role (#156)', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'u-2',
        email: 'e@x.com',
        role: { name: 'ORGANIZATION_MANAGER' },
        organization: { id: 'org-1' },
        store: null,
      });
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });

      await expect(service.updateRole(scopeOf(superAdmin), superAdmin, 'u-2', 'EDITOR')).rejects.toThrow(
        /must belong to a store/,
      );
    });

    it('a store-bound user cannot become ORGANIZATION_MANAGER (#156)', async () => {
      mockUserRepo.findOne.mockResolvedValue(boundTarget('EDITOR'));
      mockRoleRepo.findOne.mockResolvedValue({ name: 'ORGANIZATION_MANAGER' });

      await expect(service.updateRole(scopeOf(superAdmin), superAdmin, 'u-2', 'ORGANIZATION_MANAGER')).rejects.toThrow(
        /cannot be pinned to a store/,
      );
    });

    it('an organization/store mismatch is rejected (#156)', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'u-2',
        email: 'e@x.com',
        role: { name: 'VIEWER' },
        organization: { id: 'org-1' },
        store: { id: 'store-1', archivedAt: null, organization: { id: 'org-OTHER' } },
      });
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });

      await expect(service.updateRole(scopeOf(superAdmin), superAdmin, 'u-2', 'EDITOR')).rejects.toThrow(
        /different organization/,
      );
    });

    it('a rejected change neither flushes nor audits a success (#156)', async () => {
      const target = {
        id: 'u-2',
        email: 'e@x.com',
        role: { name: 'VIEWER' },
        organization: null,
        store: null,
      };
      mockUserRepo.findOne.mockResolvedValue(target);
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });

      // Refused by the tenant wall now (see above); the assertion that matters
      // here is that NOTHING was flushed or audited.
      await expect(service.updateRole(scopeOf(superAdmin), superAdmin, 'u-2', 'EDITOR')).rejects.toThrow(
        NotFoundException,
      );

      expect((target.role as any).name).toBe('VIEWER'); // nothing mutated
      expect(mockEm.flush).not.toHaveBeenCalled();
      expect(mockAudit.recordAuditEntry).not.toHaveBeenCalled();
    });
  });

  // #156 (adjacent D3): the complete hierarchy — no more level-0 holes
  describe('management hierarchy (ROLE_LEVEL)', () => {
    const target = (role: string): any => ({
      id: 'u-t',
      email: 't@x.com',
      role: { name: role },
      organization: { id: 'org-1' },
      store:
        role === 'ORGANIZATION_MANAGER' ? null : { id: 'store-1', archivedAt: null, organization: { id: 'org-1' } },
    });

    it('an ADMIN cannot manage an ORGANIZATION_MANAGER', async () => {
      mockUserRepo.findOne.mockResolvedValue(target('ORGANIZATION_MANAGER'));
      await expect(service.deactivate(scopeOf(admin), admin, 'u-t')).rejects.toThrow(ForbiddenException);
    });

    it('an ADMIN cannot manage a STORE_ADMIN peer', async () => {
      mockUserRepo.findOne.mockResolvedValue(target('STORE_ADMIN'));
      await expect(service.deactivate(scopeOf(admin), admin, 'u-t')).rejects.toThrow(ForbiddenException);
    });

    it('an ADMIN cannot manage another ADMIN peer', async () => {
      mockUserRepo.findOne.mockResolvedValue(target('ADMIN'));
      await expect(service.deactivate(scopeOf(admin), admin, 'u-t')).rejects.toThrow(ForbiddenException);
    });

    it('a store-bound ADMIN manages lower roles of its own store only', async () => {
      const storeBoundAdmin: any = { ...admin, store: { id: 'store-1', organization: { id: 'org-1' } } };
      // Same store: allowed
      mockUserRepo.findOne.mockResolvedValue(target('EDITOR'));
      await expect(service.deactivate(scopeOf(storeBoundAdmin), storeBoundAdmin, 'u-t')).resolves.toBeDefined();
      // Different store: indistinguishable from nonexistent (404)
      const foreign = {
        ...target('VIEWER'),
        store: { id: 'store-9', archivedAt: null, organization: { id: 'org-2' } },
      };
      mockUserRepo.findOne.mockResolvedValue(foreign);
      await expect(service.deactivate(scopeOf(storeBoundAdmin), storeBoundAdmin, 'u-t')).rejects.toThrow(
        'User not found',
      );
    });

    it('a SUPER_ADMIN retains the full hierarchy', async () => {
      mockUserRepo.findOne.mockResolvedValue(target('ORGANIZATION_MANAGER'));
      await expect(service.deactivate(scopeOf(superAdmin), superAdmin, 'u-t')).resolves.toBeDefined();
    });
  });

  // #156: register-dev's service half — the org comes FROM the store
  describe('createUserInStore', () => {
    it('binds the user to the store and its organization', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });
      mockEm.findOne.mockResolvedValue({ id: 'store-1', name: 'Acme', organization: { id: 'org-1' } });

      const user = await service.createUserInStore({
        email: 'dev@local.test',
        passwordHash: 'hash',
        roleName: 'EDITOR',
        storeId: 'store-1',
      });

      expect((user as any).store.id).toBe('store-1');
      expect((user as any).organization).toEqual({ id: 'org-1' });
      expect(mockEm.execute).toHaveBeenCalled();
      expect(mockEm.count).toHaveBeenCalled();
      expect(mockEm.persistAndFlush).toHaveBeenCalled();
    });

    it('rejects a missing or archived store (indistinguishably)', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });
      mockEm.findOne.mockResolvedValue(null);

      await expect(
        service.createUserInStore({ email: 'x@x.com', passwordHash: 'h', roleName: 'EDITOR', storeId: 'ghost' }),
      ).rejects.toThrow('Store not found');
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('rejects a store that has no organization', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ name: 'EDITOR' });
      mockEm.findOne.mockResolvedValue({ id: 'store-1', name: 'Orphan', organization: null });

      await expect(
        service.createUserInStore({ email: 'x@x.com', passwordHash: 'h', roleName: 'EDITOR', storeId: 'store-1' }),
      ).rejects.toThrow(/must belong to an organization/);
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('rejects an unknown role', async () => {
      mockRoleRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createUserInStore({ email: 'x@x.com', passwordHash: 'h', roleName: 'NOPE', storeId: 'store-1' }),
      ).rejects.toThrow('does not exist');
    });
  });

  describe('resetPassword', () => {
    it('stores a new hash and revokes sessions', async () => {
      const target: any = {
        id: 'u-2',
        email: 'e@x.com',
        role: { name: 'EDITOR' },
        organization: { id: 'org-1' },
        passwordHash: 'old-hash',
      };
      mockUserRepo.findOne.mockResolvedValue(target);

      await service.resetPassword(scopeOf(admin), admin, 'u-2', 'new-password-1');

      await expect(argon2.verify(target.passwordHash, 'new-password-1')).resolves.toBe(true);
      expect(mockEm.nativeUpdate).toHaveBeenCalled();
    });
  });

  describe('findAll is organization-scoped (Phase 4, C13)', () => {
    it('refuses a listing with no organization in scope instead of returning every company', async () => {
      await expect(service.findAll({})).rejects.toThrow(ForbiddenException);
      await expect(service.findAll({ storeScopeId: 'store-1' })).rejects.toThrow(ForbiddenException);
      expect(mockUserRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('scopes by the company, populates the organization, and exposes it on the row', async () => {
      mockUserRepo.findAndCount.mockResolvedValueOnce([
        [
          {
            id: 'u-om',
            email: 'om@acme.com',
            role: { name: 'ORGANIZATION_MANAGER' },
            store: null,
            organization: { id: 'org-1', name: 'Acme' },
            passwordHash: 'set',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        1,
      ]);

      const result = await service.findAll({ organizationScopeId: 'org-1' });

      const [where, options] = mockUserRepo.findAndCount.mock.calls[0];
      expect(where.organization).toBe('org-1');
      expect(options.populate).toEqual(['role', 'organization']);
      // The minimal ownership reference that makes a STORE-LESS row (an
      // ORGANIZATION_MANAGER) attributable at all — shipped only together
      // with the scoping above.
      expect(result.items[0].organization).toEqual({ id: 'org-1', name: 'Acme' });
      expect(result.items[0].store).toBeNull();
    });

    it('still narrows to one branch when the scope carries a store', async () => {
      await service.findAll({ organizationScopeId: 'org-1', storeScopeId: 'store-1' });
      const [where] = mockUserRepo.findAndCount.mock.calls[0];
      expect(where).toMatchObject({ organization: 'org-1', store: 'store-1' });
    });
  });

  describe('createOrganizationAdministrator (Phase 4)', () => {
    const ORG = { id: 'org-1', name: 'Acme', archivedAt: null };

    beforeEach(() => {
      // The organization lookup goes through the repo's EntityManager.
      mockEm.findOne.mockResolvedValue(ORG);
      mockUserRepo.findOne.mockResolvedValue(null); // email free
      mockRoleRepo.findOne.mockResolvedValue({ name: 'ORGANIZATION_MANAGER' });
    });

    it('creates the manager in ONE persist: organization from the path, store null, role fixed', async () => {
      const user = await service.createOrganizationAdministrator(superAdmin, {
        organizationId: 'org-1',
        email: 'om@acme.com',
      });

      expect(mockEm.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ email: 'om@acme.com', store: null, organization: ORG, passwordHash: null }),
      );
      expect(mockEm.persistAndFlush).toHaveBeenCalledTimes(1);
      expect(user.role).toBe('ORGANIZATION_MANAGER');
      expect(user.store).toBeNull();
      // Invited, not provisioned with a password: onboarding sets it.
      expect(user.pendingInvite).toBe(true);
      expect(user.invitation).toEqual({ pending: true, deliveryStatus: 'DELIVERED' });
    });

    it('keeps the manager recoverable and reports a failed email delivery truthfully', async () => {
      mockMail.send.mockResolvedValueOnce(false);

      const user = await service.createOrganizationAdministrator(superAdmin, {
        organizationId: 'org-1',
        email: 'om@acme.com',
      });

      expect(user.id).toBeDefined();
      expect(user.pendingInvite).toBe(true);
      expect(user.invitation).toEqual({ pending: true, deliveryStatus: 'FAILED' });
    });

    it('counts a store-less organization manager as a plan seat', async () => {
      mockEm.count.mockResolvedValue(3);

      await expect(
        service.createOrganizationAdministrator(superAdmin, { organizationId: 'org-1', email: 'om@acme.com' }),
      ).rejects.toThrow(/Deactivate a team member or upgrade/);
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('refuses a duplicate email before creating anything', async () => {
      mockUserRepo.findOne.mockResolvedValue({ id: 'existing' });
      await expect(
        service.createOrganizationAdministrator(superAdmin, { organizationId: 'org-1', email: 'om@acme.com' }),
      ).rejects.toThrow('Email already registered');
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('refuses an unknown or archived organization', async () => {
      mockEm.findOne.mockResolvedValue(null);
      await expect(
        service.createOrganizationAdministrator(superAdmin, { organizationId: 'ghost', email: 'om@acme.com' }),
      ).rejects.toThrow('Organization not found');
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('refuses an ADMIN actor: ORGANIZATION_MANAGER is not strictly below its level', async () => {
      await expect(
        service.createOrganizationAdministrator(admin, { organizationId: 'org-1', email: 'om@acme.com' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });
  });

  // PHASE 4 (requirement 5, positive half): the level-4 manager creates its
  // company's level-3 store admins — and nothing outside its own tenant.
  describe('inviteUser by an ORGANIZATION_MANAGER (Phase 4, requirement 5)', () => {
    const orgManager: any = {
      id: 'om-1',
      email: 'om@acme.com',
      role: { name: 'ORGANIZATION_MANAGER' },
      organization: { id: 'org-1' },
      store: null,
    };
    const ownStore = { id: 'store-b', name: 'Acme Store B', organization: { id: 'org-1', plan: 'BASICO' } };
    const invite = { email: 'newadmin@x.com', roleName: 'ADMIN', company: 'Acme', storeId: 'store-b' };

    beforeEach(() => {
      mockUserRepo.findOne.mockResolvedValue(null); // email free
      mockRoleRepo.findOne.mockResolvedValue({ name: 'ADMIN' });
      mockEm.findOne.mockResolvedValue(ownStore);
    });

    it('creates a store-bound ADMIN inside its own company, tenant-walled in the query itself', async () => {
      const result = await service.inviteUser(scopeOf(orgManager, ['store-b']), orgManager, invite);

      // P5-A2 family 6: the branch is proven against the RESOLVED SCOPE before
      // the lookup runs, so the query no longer needs an actor-derived
      // organization clause — a foreign branch is refused earlier, and is
      // never loaded at all (asserted in the sibling test below).
      expect(mockEm.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'store-b', archivedAt: null }),
        expect.anything(),
      );
      const persisted = mockEm.persistAndFlush.mock.calls[0][0];
      expect(persisted.store).toEqual(ownStore);
      expect(persisted.organization).toEqual(ownStore.organization);
      expect(persisted.passwordHash).toBeNull();
      expect(result.role).toBe('ADMIN');
      expect(result.pendingInvite).toBe(true);
      expect(mockMail.send).toHaveBeenCalledTimes(1);
    });

    it('refuses to mint a SUPER_ADMIN', async () => {
      await expect(
        service.inviteUser(scopeOf(orgManager), orgManager, { ...invite, roleName: 'SUPER_ADMIN' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
      expect(mockMail.send).not.toHaveBeenCalled();
    });

    it('refuses to mint a peer ORGANIZATION_MANAGER', async () => {
      await expect(
        service.inviteUser(scopeOf(orgManager), orgManager, { ...invite, roleName: 'ORGANIZATION_MANAGER' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('refuses a store-less creation — the manager places every hire in a branch', async () => {
      await expect(
        service.inviteUser(scopeOf(orgManager), orgManager, { ...invite, storeId: undefined }),
      ).rejects.toThrow(/storeId is required/);
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('a foreign branch is refused before any lookup, and an archived one still 404s', async () => {
      // Family 6: a branch outside the resolved scope is refused by the target
      // resolver, so the store is never even loaded — strictly earlier than the
      // old org-scoped query, and indistinguishable from a nonexistent one.
      await expect(
        service.inviteUser(scopeOf(orgManager, ['store-b']), orgManager, { ...invite, storeId: 'foreign-store' }),
      ).rejects.toThrow(NotFoundException);
      expect(mockEm.findOne).not.toHaveBeenCalled();
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();

      // An ALLOWED but archived branch is still an absent one.
      mockEm.findOne.mockResolvedValue(null);
      await expect(
        service.inviteUser(scopeOf(orgManager, ['store-b']), orgManager, { ...invite, storeId: 'store-b' }),
      ).rejects.toThrow('Store not found');
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });

    it('refuses a manager whose own account carries no organization', async () => {
      const corrupt: any = { ...orgManager, organization: null };
      await expect(service.inviteUser(scopeOf(corrupt), corrupt, invite)).rejects.toThrow(/carries no organization/);
      expect(mockEm.findOne).not.toHaveBeenCalled();
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });
  });
});

/**
 * Route admission. Phase 4 admitted ORGANIZATION_MANAGER on `create` ONLY;
 * P5-A2 family 6 completes ADR 014's "users and store assignments" row, so the
 * manager now holds the whole staffing surface of its own company — and store
 * assignment stops being platform-only.
 */
describe('/users route admission (P5-A2 family 6)', () => {
  const STAFFING = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'];

  it('gives the class and every inherited route the complete staffing list', () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController)).toEqual(STAFFING);
    expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.create)).toEqual(STAFFING);
    expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.resendInvite)).toEqual(STAFFING);
  });

  it('keeps store assignment to organization authority — ADMIN excluded (D-6.2)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.setStore)).toEqual([
      'SUPER_ADMIN',
      'ORGANIZATION_MANAGER',
    ]);
  });

  it('admits no role outside the staffing list on any route', () => {
    for (const handler of [
      UsersController.prototype.create,
      UsersController.prototype.setStore,
      UsersController.prototype.resendInvite,
    ]) {
      const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
      expect(roles).not.toContain('EDITOR');
      expect(roles).not.toContain('VIEWER');
    }
  });
});
