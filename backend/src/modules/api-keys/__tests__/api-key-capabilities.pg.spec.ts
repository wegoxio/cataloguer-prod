import { EntityManager } from '@mikro-orm/postgresql';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { ApiKeysService } from '../api-keys.service';
import { ApiKeyGuard } from '../api-key.guard';
import { ApiKey } from '../entities/api-key.entity';
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * Phase 6 capability scoping against real PostgreSQL, in three layers:
 *
 *  1. THE MIGRATION — a key created before the column exists comes out of
 *     `up()` holding all three capabilities (issued-authority preserved),
 *     `down()` returns the table to its exact prior shape, and the CHECK
 *     constraint closes the vocabulary at the database itself.
 *  2. THE SERVICE — new issuance defaults to CATALOGUE_READ and persists
 *     exactly what normalization produced.
 *  3. THE GUARD — the full authority matrix over real stored keys: missing
 *     grant is 403, revoked/unknown key is 401, matching grant passes.
 */
d('Phase 6 API key capabilities (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  const PRE_CAPABILITIES_MIGRATION = 'Migration20260824120000';
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

  describe('migration semantics', () => {
    let pg: DisposablePg;

    beforeAll(async () => {
      pg = await withDisposablePg({ migrateTo: PRE_CAPABILITIES_MIGRATION });
    });

    afterAll(async () => {
      await pg.close();
    });

    it('stamps PRE-EXISTING keys with all three capabilities, and defaults NEW rows to read-only', async () => {
      const conn = pg.orm.em.getConnection();
      // a legacy key, inserted while the schema still has no capabilities column
      await conn.execute(
        `insert into "api_keys" ("name", "prefix", "key_hash", "created_at")
         values ('legacy integration', 'ck_legacy1', ?, now())`,
        [sha256('ck_legacy_secret')],
      );
      const before = await conn.execute(
        `select count(*)::int as n from information_schema.columns
          where table_name = 'api_keys' and column_name = 'capabilities'`,
      );
      expect(before[0].n).toBe(0);

      await pg.orm.getMigrator().up();

      const legacy = await conn.execute(`select "capabilities" from "api_keys" where "prefix" = 'ck_legacy1'`);
      // issued under the everything-key contract, so it KEEPS that authority
      expect(legacy[0].capabilities).toEqual(['CATALOGUE_READ', 'ORDER_CREATE', 'DISCOUNT_VALIDATE']);

      await conn.execute(
        `insert into "api_keys" ("name", "prefix", "key_hash", "created_at")
         values ('post-migration key', 'ck_newrow1', ?, now())`,
        [sha256('ck_new_secret')],
      );
      const fresh = await conn.execute(`select "capabilities" from "api_keys" where "prefix" = 'ck_newrow1'`);
      expect(fresh[0].capabilities).toEqual(['CATALOGUE_READ']);
    });

    it('the CHECK constraint closes the vocabulary and refuses an empty grant', async () => {
      const conn = pg.orm.em.getConnection();
      await expect(
        conn.execute(
          `insert into "api_keys" ("name", "prefix", "key_hash", "capabilities", "created_at")
           values ('bad literal', 'ck_badlit1', ?, array['ADMIN_EVERYTHING']::text[], now())`,
          [sha256('ck_bad_literal')],
        ),
      ).rejects.toThrow(/api_keys_capabilities_known/);
      await expect(
        conn.execute(
          `insert into "api_keys" ("name", "prefix", "key_hash", "capabilities", "created_at")
           values ('empty grant', 'ck_emptyg1', ?, array[]::text[], now())`,
          [sha256('ck_empty_grant')],
        ),
      ).rejects.toThrow(/api_keys_capabilities_known/);
    });

    it('down() removes exactly what up() introduced, and up() applies again cleanly', async () => {
      const conn = pg.orm.em.getConnection();
      await pg.orm.getMigrator().down({ to: PRE_CAPABILITIES_MIGRATION });
      const gone = await conn.execute(
        `select count(*)::int as n from information_schema.columns
          where table_name = 'api_keys' and column_name = 'capabilities'`,
      );
      expect(gone[0].n).toBe(0);
      const constraint = await conn.execute(
        `select count(*)::int as n from pg_constraint where conname = 'api_keys_capabilities_known'`,
      );
      expect(constraint[0].n).toBe(0);
      // the legacy row itself survived the round trip
      const legacy = await conn.execute(`select "name" from "api_keys" where "prefix" = 'ck_legacy1'`);
      expect(legacy[0].name).toBe('legacy integration');

      await pg.orm.getMigrator().up();
      const restamped = await conn.execute(`select "capabilities" from "api_keys" where "prefix" = 'ck_legacy1'`);
      expect(restamped[0].capabilities).toEqual(['CATALOGUE_READ', 'ORDER_CREATE', 'DISCOUNT_VALIDATE']);
    });
  });

  describe('service issuance and the guard authority matrix', () => {
    let pg: DisposablePg;
    let em: EntityManager;
    let service: ApiKeysService;
    let readOnlyKey: string;
    let orderKey: string;
    let legacyFullKey: string;

    const contextFor = (headers: Record<string, string>, required: string | undefined) => {
      const request: any = { headers };
      const context: any = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
      };
      const reflector: any = { getAllAndOverride: jest.fn().mockReturnValue(required) };
      return { request, context, guard: new ApiKeyGuard(service, reflector) };
    };

    beforeAll(async () => {
      pg = await withDisposablePg();
      em = pg.orm.em.fork();
      service = new ApiKeysService(em.getRepository(ApiKey) as any);

      const organization = em.create(Organization, { name: 'Gamma', slug: 'gamma-caps' } as any);
      await em.persistAndFlush(organization);
      const store = em.create(Store, {
        name: 'Gamma Centro',
        slug: 'gamma-centro-caps',
        organization,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      await em.persistAndFlush(store);

      readOnlyKey = (await service.create('website reader', store.id)).key;
      orderKey = (await service.create('checkout', store.id, undefined, ['CATALOGUE_READ', 'ORDER_CREATE'])).key;
      // simulates a pre-Phase-6 credential: the migration stamp, not new issuance
      const legacy = await service.create('legacy full', store.id, undefined, [
        'CATALOGUE_READ',
        'ORDER_CREATE',
        'DISCOUNT_VALIDATE',
      ]);
      legacyFullKey = legacy.key;
    });

    afterAll(async () => {
      await pg.close();
    });

    it('a defaulted key persists CATALOGUE_READ only, and verify() reports it', async () => {
      const row = await em
        .getConnection()
        .execute(`select "capabilities" from "api_keys" where "name" = 'website reader'`);
      expect(row[0].capabilities).toEqual(['CATALOGUE_READ']);
      const verified = await service.verify(readOnlyKey);
      expect(verified?.capabilities).toEqual(['CATALOGUE_READ']);
    });

    it('AUTHORITY MATRIX: grant × route across all three capabilities', async () => {
      const cases: Array<[string, string, boolean]> = [
        // key,        route requires,      allowed?
        [readOnlyKey, 'CATALOGUE_READ', true],
        [readOnlyKey, 'ORDER_CREATE', false],
        [readOnlyKey, 'DISCOUNT_VALIDATE', false],
        [orderKey, 'CATALOGUE_READ', true],
        [orderKey, 'ORDER_CREATE', true],
        [orderKey, 'DISCOUNT_VALIDATE', false],
        [legacyFullKey, 'CATALOGUE_READ', true],
        [legacyFullKey, 'ORDER_CREATE', true],
        [legacyFullKey, 'DISCOUNT_VALIDATE', true],
      ];
      for (const [key, required, allowed] of cases) {
        const { context, guard } = contextFor({ 'x-api-key': key }, required);
        if (allowed) {
          await expect(guard.canActivate(context)).resolves.toBe(true);
        } else {
          // valid key, missing grant: 403 — NEVER the 401 of a bad key
          await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
        }
      }
    });

    it('a revoked or unknown key stays a 401 regardless of what the route requires', async () => {
      const verified = await service.verify(orderKey);
      expect(verified).not.toBeNull();
      const stored = await em.findOneOrFail(ApiKey, { name: 'checkout' });
      await service.revoke(stored.id);

      const revoked = contextFor({ 'x-api-key': orderKey }, 'ORDER_CREATE');
      await expect(revoked.guard.canActivate(revoked.context)).rejects.toThrow(UnauthorizedException);

      const unknown = contextFor({ 'x-api-key': 'ck_' + randomBytes(32).toString('base64url') }, 'CATALOGUE_READ');
      await expect(unknown.guard.canActivate(unknown.context)).rejects.toThrow(UnauthorizedException);
    });

    it('no capability implies another: an ORDER_CREATE-only key cannot read the catalogue', async () => {
      const orderOnly = await service.create(
        'order only',
        (await em.findOneOrFail(ApiKey, { name: 'website reader' })).store!.id,
        undefined,
        ['ORDER_CREATE'],
      );
      const read = contextFor({ 'x-api-key': orderOnly.key }, 'CATALOGUE_READ');
      await expect(read.guard.canActivate(read.context)).rejects.toThrow(ForbiddenException);
      const order = contextFor({ 'x-api-key': orderOnly.key }, 'ORDER_CREATE');
      await expect(order.guard.canActivate(order.context)).resolves.toBe(true);
    });
  });
});
