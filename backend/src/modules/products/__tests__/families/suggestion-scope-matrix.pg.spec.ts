import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { FamilyLearningService } from '../../families/family-learning.service';
import { TenantScopeService } from '../../../auth/tenancy/tenant-scope.service';
import { assertProductInOrganization } from '../../../auth/tenancy/tenant-assertions';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { FamilyVocabulary } from '../../entities/family-vocabulary.entity';
import { DismissedSuggestion } from '../../entities/dismissed-suggestion.entity';
import { Product } from '../../entities/product.entity';
import { Store } from '../../../stores/entities/store.entity';
import { User } from '../../../users/entities/user.entity';
import { realStock } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * ONE authority, resolved once, for every act in this feature.
 *
 * List, counts, dismissal, validation and creation used to answer to two
 * different ideas of "which company": the list read the request's resolved
 * scope, while dismissal and the vocabulary read the CALLER'S OWN USER ROW.
 * Those are not the same company — a platform owner working inside a client
 * has no company of their own — so a dismissal vanished from the owner's view
 * and never reached the client's.
 *
 * This is the whole matrix, driven through the REAL `TenantScopeService`
 * rather than a hand-built scope object, because the question is not only
 * "does the service filter" but "can a header talk the resolver into an
 * authority the caller does not hold".
 */
d('suggestion scope matrix (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let products: ProductsService;
  let learning: FamilyLearningService;
  let scopes: TenantScopeService;

  let ORG_A: string;
  let ORG_B: string;
  let A1: string;
  let A2: string;
  let B1: string;
  /** The A1 group, the A2 group and company B's group. */
  let inA1: string[];
  let inA2: string[];
  let inB: string[];

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> => em.execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const mkOrg = async (label: string) =>
    (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, now(), now()) returning id`,
        [label, uid(label)],
      )
    )[0].id;

  const mkStore = async (organizationId: string, label: string) =>
    (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?::uuid, now(), now()) returning id`,
        [label, uid(label), organizationId],
      )
    )[0].id;

  const mkProduct = async (name: string, organizationId: string, storeId: string | null) => {
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, now(), now()) returning id`,
      [name, uid('slug'), organizationId],
    );
    if (storeId) {
      await exec(
        `insert into store_products (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
         values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
        [organizationId, storeId, row.id],
      );
    }
    return row.id;
  };

  /**
   * The roles this matrix needs.
   *
   * A disposable database is MIGRATED, not seeded, and only
   * `ORGANIZATION_MANAGER` arrives by migration — the rest come from the
   * seeder, which does not run here. Inserted idempotently rather than assumed.
   */
  const ensureRoles = async () => {
    for (const name of ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER']) {
      await exec(
        `insert into roles (id, name)
         select gen_random_uuid(), ?
         where not exists (select 1 from roles where name = ?)`,
        [name, name],
      );
    }
  };

  /** A real user row, so the resolver reads real bindings rather than a fake. */
  const mkUser = async (role: string, organizationId: string | null, storeId: string | null) => {
    const [roleRow] = await exec<{ id: string }[]>(`select id from roles where name = ?`, [role]);
    const [row] = await exec<{ id: string }[]>(
      `insert into users (id, email, password_hash, role_id, organization_id, store_id,
                          failed_login_attempts, created_at, updated_at)
       values (gen_random_uuid(), ?, 'x', ?::uuid, ?::uuid, ?::uuid, 0, now(), now()) returning id`,
      [`${uid(role.toLowerCase())}@scope.test`, roleRow.id, organizationId, storeId],
    );
    return em.findOne(User, { id: row.id }, { populate: ['role', 'store', 'organization'] as never });
  };

  /** The resolved scope for this caller AND these headers — nothing hand-built. */
  const resolve = (user: any, headers: Record<string, string> = {}) => scopes.resolve(user, headers);

  const namesFor = async (scope: any) =>
    (await products.findFamilySuggestions(scope.organizationId, scope.storeId ?? undefined)).map((s) => s.name).sort();

  const idsFor = async (scope: any) =>
    (await products.findFamilySuggestions(scope.organizationId, scope.storeId ?? undefined)).flatMap((s) =>
      s.members.map((m) => m.id),
    );

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const guard = new PublicationGuardService();
    const fields = new ProductFieldsService(em.getRepository(ProductFieldDefinition) as any, em as any, guard);
    learning = new FamilyLearningService(
      em.getRepository(FamilyVocabulary) as any,
      em.getRepository(DismissedSuggestion) as any,
    );
    products = new ProductsService(
      em.getRepository(Product) as any,
      em.getRepository(Product) as any,
      { findById: async () => undefined } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      learning,
      guard,
      fields,
      realStock(em as any),
    );
    scopes = new TenantScopeService(em.getRepository(Store) as any);

    await ensureRoles();
    ORG_A = await mkOrg('Matrix A');
    ORG_B = await mkOrg('Matrix B');
    A1 = await mkStore(ORG_A, 'A uno');
    A2 = await mkStore(ORG_A, 'A dos');
    B1 = await mkStore(ORG_B, 'B uno');

    inA1 = [await mkProduct('Camiseta lisa roja', ORG_A, A1), await mkProduct('Camiseta lisa azul', ORG_A, A1)];
    inA2 = [await mkProduct('Zapato bajo marron', ORG_A, A2), await mkProduct('Zapato bajo negro', ORG_A, A2)];
    inB = [await mkProduct('Pantalon corto verde', ORG_B, B1), await mkProduct('Pantalon corto gris', ORG_B, B1)];
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('what each actor may READ', () => {
    it('an organization manager sees its whole company, and only its company', async () => {
      const scope = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      expect(scope.organizationId).toBe(ORG_A);
      expect(await namesFor(scope)).toEqual(['Camiseta lisa', 'Zapato bajo']);
      const ids = await idsFor(scope);
      for (const foreign of inB) expect(ids).not.toContain(foreign);
    });

    /**
     * The header only means something for a genuine platform owner. For every
     * tenant role the resolver takes the company from the caller's own
     * persisted binding, so naming another one changes nothing.
     */
    it('an organization manager naming ANOTHER company is resolved to its own', async () => {
      const user = await mkUser('ORGANIZATION_MANAGER', ORG_A, null);
      const forged = await resolve(user, { 'x-managed-organization': ORG_B });
      expect(forged.organizationId).toBe(ORG_A);
      expect(await namesFor(forged)).toEqual(['Camiseta lisa', 'Zapato bajo']);
    });

    it('a store-scoped manager sees its authorized branch', async () => {
      const scope = await resolve(await mkUser('ADMIN', ORG_A, A1));
      expect([scope.organizationId, scope.storeId]).toEqual([ORG_A, A1]);
      expect(await namesFor(scope)).toEqual(['Camiseta lisa']);
    });

    it('a store-scoped manager naming ANOTHER branch is REFUSED at the resolver', async () => {
      const user = await mkUser('ADMIN', ORG_A, A1);
      await expect(resolve(user, { 'x-managed-store': A2 })).rejects.toThrow(/only act on your own store/i);
      await expect(resolve(user, { 'x-managed-store': B1 })).rejects.toThrow(/only act on your own store/i);
    });

    it('a VIEWER reads its own scope, exactly like any other reader', async () => {
      const scope = await resolve(await mkUser('VIEWER', ORG_A, A1));
      expect(await namesFor(scope)).toEqual(['Camiseta lisa']);
      const ids = await idsFor(scope);
      for (const foreign of [...inA2, ...inB]) expect(ids).not.toContain(foreign);
    });

    it('a platform owner INSIDE a company reads that company', async () => {
      const owner = await mkUser('SUPER_ADMIN', null, null);
      const scope = await resolve(owner, { 'x-managed-organization': ORG_B });
      expect(scope.organizationId).toBe(ORG_B);
      expect(await namesFor(scope)).toEqual(['Pantalon corto']);
    });

    it('a platform owner with NO company is refused — it does not read everything', async () => {
      const scope = await resolve(await mkUser('SUPER_ADMIN', null, null));
      expect(scope.organizationId).toBeNull();
      await expect(products.findFamilySuggestions(scope.organizationId, undefined)).rejects.toThrow(
        /requires an organization context/i,
      );
    });

    it('a platform owner naming a branch of ANOTHER company than the one it named is refused', async () => {
      const owner = await mkUser('SUPER_ADMIN', null, null);
      await expect(resolve(owner, { 'x-managed-organization': ORG_A, 'x-managed-store': B1 })).rejects.toThrow(
        /belongs to another organization/i,
      );
    });
  });

  describe('what each actor may DISMISS', () => {
    const dismiss = (scope: any, name: string) =>
      products.dismissFamilySuggestion(name, scope.organizationId, scope.storeId ?? undefined);

    it('an organization manager dismisses for its own company only', async () => {
      const a = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      const b = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_B, null));
      await dismiss(a, 'Zapato bajo');

      expect(await namesFor(a)).toEqual(['Camiseta lisa']);
      // Company B is untouched, and its own look-alike group is still there.
      expect(await namesFor(b)).toEqual(['Pantalon corto']);
    });

    it('is idempotent: a second No is still a No, not an error', async () => {
      const a = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      await expect(dismiss(a, 'Zapato bajo')).resolves.toEqual({ signature: 'zapato bajo' });
    });

    /**
     * The refusal is the SAME sentence whether the signature belongs to
     * another company or to nobody at all. A different answer for the two
     * would turn this route into a way to ask what another company has.
     */
    it('REFUSES another company’s signature, and says no more than for a made-up one', async () => {
      const a = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      const foreign = await dismiss(a, 'Pantalon corto').catch((e: Error) => e.message);
      const nonsense = await dismiss(a, 'Nada de nada').catch((e: Error) => e.message);
      expect(foreign).toBe('That suggestion is not one of yours.');
      expect(nonsense).toBe(foreign);

      // And company B still has it: the refusal wrote nothing anywhere.
      const b = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_B, null));
      expect(await namesFor(b)).toEqual(['Pantalon corto']);
    });

    it('REFUSES a branch-scoped actor a group that lives in a sibling branch', async () => {
      // Its OWN group, so the refusal cannot be confused with an already
      // dismissed one — the idempotent path deliberately skips the check.
      await mkProduct('Sandalia plana roja', ORG_A, A2);
      await mkProduct('Sandalia plana azul', ORG_A, A2);
      const a1 = await resolve(await mkUser('ADMIN', ORG_A, A1));
      expect(await namesFor(a1)).not.toContain('Sandalia plana');
      await expect(dismiss(a1, 'Sandalia plana')).rejects.toThrow('That suggestion is not one of yours.');

      // And the company-wide manager still has it: nothing was written.
      const a = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      expect(await namesFor(a)).toContain('Sandalia plana');
    });

    it('a platform owner INSIDE a company dismisses FOR that company', async () => {
      const owner = await mkUser('SUPER_ADMIN', null, null);
      const managed = await resolve(owner, { 'x-managed-organization': ORG_B });
      await dismiss(managed, 'Pantalon corto');

      // The company's OWN manager sees the dismissal — the whole point.
      const b = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_B, null));
      expect(await namesFor(b)).toEqual([]);
      expect(await namesFor(managed)).toEqual([]);
    });

    it('an UNSCOPED platform owner is refused', async () => {
      const scope = await resolve(await mkUser('SUPER_ADMIN', null, null));
      await expect(dismiss(scope, 'Camiseta lisa')).rejects.toThrow(/requires an organization context/i);
    });
  });

  describe('what each actor may VALIDATE or CREATE with', () => {
    /**
     * The per-member tenant gate both writing routes run before the service.
     * It is the reason a foreign identifier cannot be smuggled into a family.
     */
    const mayUse = async (scope: any, productId: string) =>
      assertProductInOrganization(em, scope as never, productId).then(
        () => true,
        () => false,
      );

    it('an organization manager may use its own company’s items', async () => {
      const scope = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      expect(await mayUse(scope, inA1[0])).toBe(true);
      expect(await mayUse(scope, inA2[0])).toBe(true);
    });

    it('an organization manager may NOT use another company’s items', async () => {
      const scope = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      for (const foreign of inB) expect(await mayUse(scope, foreign)).toBe(false);
    });

    it('a forged company header does not widen what may be used', async () => {
      const user = await mkUser('ORGANIZATION_MANAGER', ORG_A, null);
      const forged = await resolve(user, { 'x-managed-organization': ORG_B });
      for (const foreign of inB) expect(await mayUse(forged, foreign)).toBe(false);
    });

    it('a branch-scoped actor may not use another company’s items either', async () => {
      const scope = await resolve(await mkUser('ADMIN', ORG_A, A1));
      for (const foreign of inB) expect(await mayUse(scope, foreign)).toBe(false);
    });
  });

  describe('the query keys carry the scope', () => {
    /**
     * Nothing is memoized between calls. If a per-process cache were ever
     * added without company and branch in its key, interleaving these four
     * scopes is what would expose it.
     */
    it('three different scopes interleaved each get their own answer', async () => {
      // Fresh groups, one per scope, so the three answers are different by
      // construction rather than by whatever earlier tests happened to leave.
      await mkProduct('Corbata fina roja', ORG_A, A2);
      await mkProduct('Corbata fina azul', ORG_A, A2);
      await mkProduct('Cinturon ancho roja', ORG_A, A1);
      await mkProduct('Cinturon ancho azul', ORG_A, A1);
      await mkProduct('Chaleco corto roja', ORG_B, B1);
      await mkProduct('Chaleco corto azul', ORG_B, B1);

      const a = await resolve(await mkUser('ORGANIZATION_MANAGER', ORG_A, null));
      const a1 = await resolve(await mkUser('ADMIN', ORG_A, A1));
      const owner = await mkUser('SUPER_ADMIN', null, null);
      const managedB = await resolve(owner, { 'x-managed-organization': ORG_B });

      const first = [await namesFor(a), await namesFor(a1), await namesFor(managedB)];
      const again = [await namesFor(a), await namesFor(a1), await namesFor(managedB)];
      expect(again).toEqual(first);

      // The company-wide reader has both branches; the branch reader has only
      // its own; the other company has neither. Equality above is therefore
      // three answers repeating, not one cached list served three times.
      expect(first[0]).toEqual(expect.arrayContaining(['Corbata fina', 'Cinturon ancho']));
      expect(first[1]).toEqual(expect.arrayContaining(['Cinturon ancho']));
      expect(first[1]).not.toContain('Corbata fina');
      expect(first[2]).toEqual(expect.arrayContaining(['Chaleco corto']));
      expect(first[2]).not.toContain('Cinturon ancho');
      expect(new Set(first.map((n) => n.join('|'))).size).toBe(3);
    });
  });
});
