import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { Organization } from '../../../organizations/entities/organization.entity';
import { Store } from '../../../stores/entities/store.entity';
import { Product } from '../../entities/product.entity';
import { StoreProduct } from '../../entities/store-product.entity';
import { ProductFieldDefinition, ProductFieldType } from '../../entities/product-field-definition.entity';
import { StoreFieldSetting } from '../../entities/store-field-setting.entity';
import { ProductFieldValue } from '../../entities/product-field-value.entity';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { ProductFamilyService } from '../../families/product-family.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { storePublicationLock, productFamilyLock, AdvisoryLockKey } from '../../families/advisory-lock.util';
import { realStock } from '../../../../../test/inventory-stock-support';

// `pg` is used for the two scaffolding sessions only: a blocker that holds one
// advisory key to sequence the contenders deterministically, and an observer
// that watches pg_locks and checks invariants. Neither ever substitutes for a
// production transaction owner — every contended operation below runs through
// the real service entry point.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/** pg_locks reports advisory keys as unsigned oids; ours are signed int32. */
const unsigned = (n: number): number => n >>> 0;

type Outcome = { status: 'committed'; value: unknown } | { status: 'refused'; error: any };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (value) => ({ status: 'committed', value }) as Outcome,
    (error) => ({ status: 'refused', error }) as Outcome,
  );

/**
 * B4a3 publication invariant under REAL concurrency (real PostgreSQL).
 *
 * Each test drives two production service entry points in both orders and
 * proves that whatever the interleaving, no committed state ever shows a
 * published pivot of a sellable product in a store whose active, required
 * field it leaves unanswered.
 *
 * Sequencing is deterministic and bounded, never a sleep: a raw blocker
 * session holds ONE contended advisory key inside an open transaction; each
 * contender is launched and OBSERVED (via pg_locks) queuing on that key
 * before the next step; releasing the blocker then grants the queue in FIFO
 * order. Wall-clock bounds come from PGOPTIONS-supplied
 * lock_timeout/statement_timeout — exported BEFORE the ORM pool exists, so
 * every maintenance, pooled, blocker and observer connection receives them —
 * plus the poll deadlines here and the per-test Jest timeout.
 */
d('B4a3 publication invariant concurrency (real PostgreSQL)', () => {
  const TEST_TIMEOUT = 90_000;
  const POLL_DEADLINE_MS = 20_000;
  const POLL_INTERVAL_MS = 50;

  let pg: DisposablePg;
  let orm: MikroORM;
  let em: EntityManager;
  let blocker: any;
  let observer: any;
  let organizationId: string;
  let storeId: string;
  let definitionId: string;
  let previousPgOptions: string | undefined;

  const ACTOR = { id: 'u1', email: 'race@acme.test', store: null } as any;
  const scopeOrgWide = () => ({
    platform: false,
    organizationId,
    storeId: null,
    allowedStoreIds: [storeId],
    role: 'ORGANIZATION_MANAGER',
  });

  /** Real services on their OWN fork — one database session lineage each. */
  const buildActors = () => {
    const forkA = orm.em.fork();
    const forkB = orm.em.fork();
    const services = (fork: EntityManager) => {
      const guard = new PublicationGuardService();
      const fields = new ProductFieldsService(fork.getRepository(ProductFieldDefinition) as any, fork as any, guard);
      const products = new ProductsService(
        fork.getRepository(Product) as any,
        fork.getRepository(Product) as any, // category repo: unused by these paths
        { findById: async () => undefined } as any, // categories service: unused
        { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
        { learnFromAcceptedGroup: async () => undefined } as any,
        guard,
        fields,
        realStock(em as any),
      );
      const family = new ProductFamilyService(
        fork.getRepository(Product) as any,
        { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
        guard,
      );
      return { products, fields, family };
    };
    return { a: services(forkA), b: services(forkB) };
  };

  const disposableUrl = (): string => {
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${pg.dbName}`;
    return url.toString();
  };

  const waitersOn = async (key: AdvisoryLockKey): Promise<number> => {
    const rows = await observer.query(
      `select count(*)::int as n from pg_locks
        where locktype = 'advisory' and not granted
          and classid = $1 and objid = $2 and objsubid = 2`,
      [unsigned(key.ns), unsigned(key.key)],
    );
    return rows.rows[0].n;
  };

  const waitFor = async (predicate: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /**
   * Runs `first` then `second` through the blocker queue on `contendedKey`:
   * both are OBSERVED waiting on the key before the blocker releases, so the
   * grant order — and therefore the commit order — is exactly [first, second].
   */
  const sequenced = async (
    contendedKey: AdvisoryLockKey,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ): Promise<[Outcome, Outcome]> => {
    await blocker.query('begin');
    try {
      await blocker.query('select pg_advisory_xact_lock($1::int4, $2::int4)', [contendedKey.ns, contendedKey.key]);
      const firstPromise = settle(first());
      await waitFor(async () => (await waitersOn(contendedKey)) >= 1, 'first contender to queue on the advisory key');
      const secondPromise = settle(second());
      await waitFor(async () => (await waitersOn(contendedKey)) >= 2, 'second contender to queue on the advisory key');
      await blocker.query('rollback');
      return [await firstPromise, await secondPromise];
    } catch (err) {
      await blocker.query('rollback').catch(() => undefined);
      throw err;
    }
  };

  const one = async (sql: string, params: any[] = []): Promise<any> =>
    (await em.getConnection().execute(sql, params))[0];

  const invariantViolations = async (): Promise<number> =>
    Number(
      (
        await one(`
          select count(*)::int as n
            from store_products sp
            join store_field_settings sfs
              on sfs.store_id = sp.store_id and sfs.active and sfs.required
            join products p on p.id = sp.product_id
            left join product_field_values v
              on v.product_id = p.id and v.definition_id = sfs.definition_id
           where sp.published
             and p.status = '${ProductStatus.PUBLISHED}'
             and p.archived_at is null
             and not exists (select 1 from products c where c.parent_id = p.id)
             and v.id is null`)
      ).n,
    );

  interface Scenario {
    productStatus?: ProductStatus;
    pivot?: { published: boolean } | null;
    settingRequired?: boolean;
    value?: boolean;
    child?: boolean;
  }

  const seed = async (scenario: Scenario): Promise<{ productId: string; childId: string | null }> => {
    const fork = orm.em.fork();
    const product = fork.create(Product, {
      name: 'Silla',
      slug: `silla-${Date.now()}`,
      status: scenario.productStatus ?? ProductStatus.PUBLISHED,
      organization: organizationId as any,
      price: 10,
      stockQuantity: 0,
      trackInventory: false,
    } as any);
    fork.persist(product);
    await fork.flush();

    let childId: string | null = null;
    if (scenario.child) {
      const child = fork.create(Product, {
        name: 'Silla Verde',
        slug: `silla-verde-${Date.now()}`,
        status: ProductStatus.PUBLISHED,
        organization: organizationId as any,
        parent: product,
        optionLabel: 'Verde',
        price: 10,
        stockQuantity: 0,
        trackInventory: false,
      } as any);
      fork.persist(child);
      await fork.flush();
      childId = child.id;
    }

    if (scenario.pivot) {
      fork.persist(
        fork.create(StoreProduct, {
          organization: organizationId as any,
          store: storeId as any,
          product,
          published: scenario.pivot.published,
          stockQuantity: 0,
          trackInventory: false,
          price: null,
          salePrice: null,
          cost: null,
          leadTimeDays: null,
        } as any),
      );
    }
    fork.persist(
      fork.create(StoreFieldSetting, {
        organization: organizationId as any,
        store: storeId as any,
        definition: definitionId as any,
        active: true,
        required: scenario.settingRequired ?? false,
        publiclyVisible: false,
        importable: false,
      } as any),
    );
    if (scenario.value) {
      fork.persist(
        fork.create(ProductFieldValue, {
          organization: organizationId as any,
          product,
          definition: definitionId as any,
          definitionType: ProductFieldType.TEXT,
          valueText: 'Verde',
        } as any),
      );
    }
    await fork.flush();
    return { productId: product.id, childId };
  };

  const productRow = (productId: string) => one(`select status, parent_id from products where id = ?`, [productId]);
  const pivotRow = (productId: string) =>
    one(`select published from store_products where product_id = ? and store_id = ?`, [productId, storeId]);
  const settingRow = () =>
    one(`select required from store_field_settings where store_id = ? and definition_id = ?`, [storeId, definitionId]);
  const valueCount = async (productId: string) =>
    Number((await one(`select count(*)::int as n from product_field_values where product_id = ?`, [productId])).n);

  beforeAll(async () => {
    // BEFORE any pool exists: every connection made from here on — the
    // harness's maintenance client, the ORM pool, the blocker and the
    // observer — starts with bounded timeouts. An ALTER DATABASE afterwards
    // could not reach connections the pool had already opened.
    previousPgOptions = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c lock_timeout=20s -c statement_timeout=30s';

    pg = await withDisposablePg();
    orm = pg.orm;
    em = orm.em.fork();

    blocker = new Client({ connectionString: disposableUrl() });
    observer = new Client({ connectionString: disposableUrl() });
    await blocker.connect();
    await observer.connect();

    const setup = orm.em.fork();
    const org = setup.create(Organization, { name: 'Acme', slug: 'acme' } as any);
    setup.persist(org);
    await setup.flush();
    organizationId = org.id;
    const store = setup.create(Store, { name: 'North', slug: 'north', organization: org } as any);
    setup.persist(store);
    await setup.flush();
    storeId = store.id;
    const definition = setup.create(ProductFieldDefinition, {
      organization: organizationId as any,
      key: 'color',
      label: 'Color',
      type: ProductFieldType.TEXT,
      sortOrder: 0,
    } as any);
    setup.persist(definition);
    await setup.flush();
    definitionId = definition.id;
  }, 120_000);

  afterAll(async () => {
    if (blocker) await blocker.end().catch(() => undefined);
    if (observer) await observer.end().catch(() => undefined);
    if (pg) await pg.close();
    if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousPgOptions;
  });

  beforeEach(async () => {
    const conn = em.getConnection();
    await conn.execute('delete from product_field_values');
    await conn.execute('delete from store_field_settings');
    await conn.execute('delete from store_products');
    await conn.execute('update products set parent_id = null');
    await conn.execute('delete from products');
    em.clear();
  });

  const activate = (actors: ReturnType<typeof buildActors>['a']) => () =>
    actors.fields.upsertStoreSetting(scopeOrgWide() as any, storeId, definitionId, {
      active: true,
      required: true,
    } as any);

  describe('pair 1 — membership publish vs requirement activation (store key)', () => {
    it(
      'publish first: the pivot lands, then the activation refuses the unanswered product',
      async () => {
        const { productId } = await seed({ pivot: null });
        const { a, b } = buildActors();

        const [publish, activation] = await sequenced(
          storePublicationLock(storeId),
          () => a.products.update(productId, { storeIds: [storeId] } as any, organizationId),
          activate(b),
        );

        expect(publish.status).toBe('committed');
        expect(activation.status).toBe('refused');
        expect((activation as any).error.getResponse().missingProductIds).toEqual([productId]);
        expect((await pivotRow(productId)).published).toBe(true);
        expect((await settingRow()).required).toBe(false);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      'activation first: the requirement lands, then the publish refuses',
      async () => {
        const { productId } = await seed({ pivot: null });
        const { a, b } = buildActors();

        const [activation, publish] = await sequenced(storePublicationLock(storeId), activate(a), () =>
          b.products.update(productId, { storeIds: [storeId] } as any, organizationId),
        );

        expect(activation.status).toBe('committed');
        expect(publish.status).toBe('refused');
        expect((publish as any).error.getResponse().storeId).toBe(storeId);
        expect(await pivotRow(productId)).toBeUndefined();
        expect((await settingRow()).required).toBe(true);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });

  describe('pair 2 — status flip to PUBLISHED vs requirement activation (store key)', () => {
    it(
      'flip first: the product goes live, then the activation refuses it',
      async () => {
        const { productId } = await seed({ productStatus: ProductStatus.DRAFT, pivot: { published: true } });
        const { a, b } = buildActors();

        const [flip, activation] = await sequenced(
          storePublicationLock(storeId),
          () => a.products.update(productId, { status: ProductStatus.PUBLISHED } as any, organizationId),
          activate(b),
        );

        expect(flip.status).toBe('committed');
        expect(activation.status).toBe('refused');
        expect((await productRow(productId)).status).toBe(ProductStatus.PUBLISHED);
        expect((await settingRow()).required).toBe(false);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      'activation first: the draft is skipped by the scan, then the flip refuses',
      async () => {
        const { productId } = await seed({ productStatus: ProductStatus.DRAFT, pivot: { published: true } });
        const { a, b } = buildActors();

        const [activation, flip] = await sequenced(storePublicationLock(storeId), activate(a), () =>
          b.products.update(productId, { status: ProductStatus.PUBLISHED } as any, organizationId),
        );

        expect(activation.status).toBe('committed');
        expect(flip.status).toBe('refused');
        expect((flip as any).error.getResponse().storeId).toBe(storeId);
        expect((await productRow(productId)).status).toBe(ProductStatus.DRAFT);
        expect((await settingRow()).required).toBe(true);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });

  describe('pair 3 — releasing the last version vs requirement activation (store key)', () => {
    it(
      'release first: the card goes sellable unanswered, then the activation refuses it',
      async () => {
        const { productId, childId } = await seed({ pivot: { published: true }, child: true });
        const { a, b } = buildActors();

        const [release, activation] = await sequenced(
          storePublicationLock(storeId),
          () => a.family.removeMember(productId, childId!, ACTOR),
          activate(b),
        );

        expect(release.status).toBe('committed');
        expect(activation.status).toBe('refused');
        expect((await productRow(childId!)).parent_id).toBeNull();
        expect((await settingRow()).required).toBe(false);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      'activation first: the card is exempt while it has a version, then the release refuses',
      async () => {
        const { productId, childId } = await seed({ pivot: { published: true }, child: true });
        const { a, b } = buildActors();

        const [activation, release] = await sequenced(storePublicationLock(storeId), activate(a), () =>
          b.family.removeMember(productId, childId!, ACTOR),
        );

        expect(activation.status).toBe('committed');
        expect(release.status).toBe('refused');
        expect((release as any).error.getResponse().storeId).toBe(storeId);
        expect((await productRow(childId!)).parent_id).toBe(productId);
        expect((await settingRow()).required).toBe(true);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });

  describe('pair 4 — value deletion vs requirement activation (store key: the closed race)', () => {
    it(
      'deletion first: the answer goes, then the activation refuses the now-unanswered product',
      async () => {
        const { productId } = await seed({ pivot: { published: true }, value: true });
        const { a, b } = buildActors();

        const [deletion, activation] = await sequenced(
          storePublicationLock(storeId),
          () => a.fields.deleteValue(scopeOrgWide() as any, productId, definitionId),
          activate(b),
        );

        expect(deletion.status).toBe('committed');
        expect(activation.status).toBe('refused');
        expect((activation as any).error.getResponse().missingProductIds).toEqual([productId]);
        expect(await valueCount(productId)).toBe(0);
        expect((await settingRow()).required).toBe(false);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      'activation first: the requirement lands, then the deletion refuses',
      async () => {
        const { productId } = await seed({ pivot: { published: true }, value: true });
        const { a, b } = buildActors();

        const [activation, deletion] = await sequenced(storePublicationLock(storeId), activate(a), () =>
          b.fields.deleteValue(scopeOrgWide() as any, productId, definitionId),
        );

        expect(activation.status).toBe('committed');
        expect(deletion.status).toBe('refused');
        expect((deletion as any).error.getResponse().blockingStoreIds).toEqual([storeId]);
        expect(await valueCount(productId)).toBe(1);
        expect((await settingRow()).required).toBe(true);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });

  describe('pair 5 — value deletion vs publish flip (family-root key)', () => {
    it(
      'flip first: the pivot goes live on the answered product, then the deletion refuses',
      async () => {
        const { productId } = await seed({ pivot: { published: false }, settingRequired: true, value: true });
        const { a, b } = buildActors();

        const [flip, deletion] = await sequenced(
          productFamilyLock(productId),
          () => a.products.assignToStore(productId, storeId, { published: true } as any),
          () => b.fields.deleteValue(scopeOrgWide() as any, productId, definitionId),
        );

        expect(flip.status).toBe('committed');
        expect(deletion.status).toBe('refused');
        expect((deletion as any).error.getResponse().blockingStoreIds).toEqual([storeId]);
        expect((await pivotRow(productId)).published).toBe(true);
        expect(await valueCount(productId)).toBe(1);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      'deletion first: the hidden product loses its answer freely, then the flip refuses',
      async () => {
        const { productId } = await seed({ pivot: { published: false }, settingRequired: true, value: true });
        const { a, b } = buildActors();

        const [deletion, flip] = await sequenced(
          productFamilyLock(productId),
          () => a.fields.deleteValue(scopeOrgWide() as any, productId, definitionId),
          () => b.products.assignToStore(productId, storeId, { published: true } as any),
        );

        expect(deletion.status).toBe('committed');
        expect(flip.status).toBe('refused');
        expect((flip as any).error.getResponse().storeId).toBe(storeId);
        expect(await valueCount(productId)).toBe(0);
        expect((await pivotRow(productId)).published).toBe(false);
        expect(await invariantViolations()).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });
});
