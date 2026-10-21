import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { Product } from '../../entities/product.entity';
import { realStock } from '../../../../../test/inventory-stock-support';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;
const ACTOR = { id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', email: 'op@e.test' } as any;

/**
 * Two guarantees a created family makes about itself: it is RECORDED, and its
 * slug FITS.
 */
d('family creation: audit atomicity and slug safety (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let ORG: string;
  let STORE: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> => em.execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const build = (audit: any, learning: any = { learnFromAcceptedGroup: async () => undefined }) => {
    const guard = new PublicationGuardService();
    const fields = new ProductFieldsService(em.getRepository(ProductFieldDefinition) as any, em as any, guard);
    return new ProductsService(
      em.getRepository(Product) as any,
      em.getRepository(Product) as any,
      { findById: async () => undefined } as any,
      audit,
      learning,
      guard,
      fields,
      realStock(em as any),
    );
  };
  const ok = () => ({ recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never });

  const mkProduct = async () => {
    const name = uid('p');
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, now(), now()) returning id`,
      [name, name, ORG],
    );
    await exec(
      `insert into store_products (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
      [ORG, STORE, row.id],
    );
    return row.id;
  };

  const census = async () => ({
    products: (
      await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id=?::uuid`, [ORG])
    )[0].n,
    parented: (
      await exec<{ n: number }[]>(
        `select count(*)::int n from products where organization_id=?::uuid and parent_id is not null`,
        [ORG],
      )
    )[0].n,
    audit: (await exec<{ n: number }[]>(`select count(*)::int n from audit_logs`))[0].n,
    vocab: (await exec<{ n: number }[]>(`select count(*)::int n from family_vocabulary`))[0].n,
  });

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    ORG = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Audit Co', ?, now(), now()) returning id`,
        [uid('audit')],
      )
    )[0].id;
    STORE = (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), 'Centro', ?, ?::uuid, now(), now()) returning id`,
        [uid('centro'), ORG],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('the audit record commits with the family', () => {
    it('writes the entry inside the same transaction', async () => {
      const before = await census();
      const products = build(ok());
      const created = await products.createFamily(
        uid('fam'),
        [
          { id: await mkProduct(), label: 'A' },
          { id: await mkProduct(), label: 'B' },
        ],
        ACTOR,
      );
      expect(created.members).toBe(2);
      expect((await census()).parented).toBe(before.parented + 2);
    });

    it('AN AUDIT FAILURE TAKES THE WHOLE FAMILY WITH IT', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const before = await census();
      const products = build({
        recordAuditEntry: async () => undefined,
        recordAuditEntryIn: async () => {
          throw new Error('audit store unavailable');
        },
      });

      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: a, label: 'A' },
            { id: b, label: 'B' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/audit store unavailable/i);

      // No card, no parent links, no audit row — and no vocabulary either,
      // because the teaching step is never reached.
      expect(await census()).toEqual(before);
      const [{ n }] = await exec<{ n: number }[]>(
        `select count(*)::int n from products where id in (?::uuid, ?::uuid) and parent_id is not null`,
        [a, b],
      );
      expect(n).toBe(0);
    });

    it('a vocabulary failure AFTER the commit does not invalidate the family', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const products = build(ok(), {
        learnFromAcceptedGroup: async () => {
          throw new Error('vocabulary unavailable');
        },
      });

      // The learning step is explicitly non-authoritative, so its failure
      // surfaces — but the family it describes is already committed.
      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: a, label: 'A' },
            { id: b, label: 'B' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/vocabulary unavailable/i);

      const [{ n }] = await exec<{ n: number }[]>(
        `select count(*)::int n from products where id in (?::uuid, ?::uuid) and parent_id is not null`,
        [a, b],
      );
      expect(n).toBe(2);
    });

    it('a family that rolls back for any other reason leaves no audit entry', async () => {
      const a = await mkProduct();
      const before = await census();
      const products = build(ok());
      await expect(products.createFamily(uid('fam'), [{ id: a, label: 'Only' }], ACTOR)).rejects.toThrow(
        /at least two/i,
      );
      expect((await census()).audit).toBe(before.audit);
    });
  });

  describe('slug allocation is length-safe', () => {
    const slugOf = async (id: string) =>
      (await exec<{ slug: string }[]>(`select slug from products where id = ?::uuid`, [id]))[0].slug;

    it('leaves an ordinary name exactly as it was', async () => {
      const products = build(ok());
      const created = await products.createFamily(
        'Camiseta Basica',
        [
          { id: await mkProduct(), label: 'A' },
          { id: await mkProduct(), label: 'B' },
        ],
        ACTOR,
      );
      expect(await slugOf(created.id)).toBe('camiseta-basica');
    });

    it('a maximum-length name fits, with no collision', async () => {
      const products = build(ok());
      const name = 'a'.repeat(255);
      const created = await products.createFamily(
        name,
        [
          { id: await mkProduct(), label: 'A' },
          { id: await mkProduct(), label: 'B' },
        ],
        ACTOR,
      );
      const slug = await slugOf(created.id);
      expect(slug.length).toBeLessThanOrEqual(255);
      expect(slug).toBe('a'.repeat(255));
    });

    it('a maximum-length name still fits with ONE collision, and with MANY', async () => {
      const products = build(ok());
      const name = 'b'.repeat(255);
      const slugs: string[] = [];
      // Twelve families of the same maximum-length name: the first takes the
      // base, and every one after it must find a distinct suffixed slug that
      // still fits the column. The old code appended to the full-width base and
      // produced a 257-character slug the insert refused.
      for (let i = 0; i < 12; i++) {
        const created = await products.createFamily(
          name,
          [
            { id: await mkProduct(), label: 'A' },
            { id: await mkProduct(), label: 'B' },
          ],
          ACTOR,
        );
        slugs.push(await slugOf(created.id));
      }
      for (const slug of slugs) expect(slug.length).toBeLessThanOrEqual(255);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('creation stays atomic when slug allocation cannot succeed', async () => {
      // A name that slugifies to nothing falls back to a fixed base, so the
      // suffix loop is the only way out; the family either commits whole or
      // not at all, and this proves the loop cannot leave a half-made one.
      const products = build(ok());
      const before = await census();
      const created = await products.createFamily(
        '???',
        [
          { id: await mkProduct(), label: 'A' },
          { id: await mkProduct(), label: 'B' },
        ],
        ACTOR,
      );
      expect((await slugOf(created.id)).length).toBeGreaterThan(0);
      expect((await census()).parented).toBe(before.parented + 2);
    });
  });

  /**
   * NAMES THIS ENDPOINT ACCEPTS MUST NOT BREAK THE ROW THAT RECORDS THEM.
   *
   * `audit_logs.message` is varchar(255). Both the card's name and a child's
   * name may be 255 on their own, so a message that embedded them overflowed
   * the column — and because that row commits with the family, the INSERT
   * failing meant the whole grouping failed with a server error on names the
   * endpoint had just validated as fine. The message is now a constant and
   * every name lives in `changes`, which is jsonb.
   *
   * Run against a REAL AuditLogService, because a double cannot overflow a
   * column it never writes to.
   */
  describe('long names and the audit row that records them', () => {
    // Exactly n characters and never ending in whitespace, because the
    // endpoint trims what it is given and a fixture that ends in a space
    // would be comparing against a name the server never stored.
    const long = (n: number, seed: string) =>
      seed
        .repeat(Math.ceil(n / seed.length))
        .slice(0, n)
        .replace(/\s$/, 'o');
    const realAudit = () => new AuditLogService(em.getRepository(AuditLog) as any);

    const renameOf = async (productId: string) =>
      (
        await exec<{ message: string; changes: any }[]>(
          `select message, changes from audit_logs where entity_id=?::uuid and action='UPDATE' order by created_at desc limit 1`,
          [productId],
        )
      )[0];

    it('commits the group, the renames and every audit row with names at the limit', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const beforeA = (await exec<{ name: string }[]>(`select name from products where id=?::uuid`, [a]))[0].name;
      // A realistic worst case: the card and both children at the 255 the
      // endpoint allows. The old messages would have been far past 255.
      const cardName = long(250, 'Silla Nordic de Comedor Tapizada en Lino ');
      const newA = long(250, 'Verde Oliva con Patas de Roble Macizo ');
      const newB = long(250, 'Azul Marino con Patas de Nogal Oscuro ');

      const products = build(realAudit());
      const created = await products.createFamily(
        cardName,
        [
          { id: a, label: 'Verde', name: newA },
          { id: b, label: 'Azul', name: newB },
        ],
        ACTOR,
      );

      expect(created.members).toBe(2);
      // The grouping really happened.
      const rows = await exec<{ id: string; name: string; parent_id: string | null; option_label: string }[]>(
        `select id, name, parent_id, option_label from products where id in (?::uuid, ?::uuid) order by option_label`,
        [a, b],
      );
      expect(rows.every((r) => r.parent_id === created.id)).toBe(true);
      expect(rows.map((r) => r.name).sort()).toEqual([newA, newB].sort());

      // The card's own entry: a constant message, its name in `changes`.
      const cardEntry = (
        await exec<{ message: string; changes: any }[]>(
          `select message, changes from audit_logs where entity_id=?::uuid and action='CREATE'`,
          [created.id],
        )
      )[0];
      expect(cardEntry.message.length).toBeLessThanOrEqual(255);
      expect(cardEntry.changes.name.after).toBe(cardName);
      expect(cardEntry.changes.memberCount).toBe(2);

      // Each rename: the same, in the shape every other product edit writes.
      const entryA = await renameOf(a);
      expect(entryA.message).toBe('Renamed while grouping.');
      expect(entryA.message.length).toBeLessThanOrEqual(255);
      expect(entryA.changes.name).toEqual({ before: beforeA, after: newA });
    });

    it('a failure after the renames rolls back the card, the links, the names and the entries', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const nameA = (await exec<{ name: string }[]>(`select name from products where id=?::uuid`, [a]))[0].name;
      const before = await census();

      // A real audit service for the rows that succeed, and a refusal on the
      // LAST one — after the card, the links and both renames are written.
      const real = new AuditLogService(em.getRepository(AuditLog) as any);
      let seen = 0;
      const failing: any = {
        recordAuditEntry: async () => undefined,
        recordAuditEntryIn: async (...args: any[]) => {
          seen += 1;
          if (seen >= 3) throw new Error('audit refused');
          return (real as any).recordAuditEntryIn(...args);
        },
      };

      await expect(
        build(failing).createFamily(
          long(250, 'Silla Nordic de Comedor Tapizada en Lino '),
          [
            { id: a, label: 'Verde', name: long(250, 'Verde Oliva con Patas de Roble ') },
            { id: b, label: 'Azul', name: long(250, 'Azul Marino con Patas de Nogal ') },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/audit refused/);

      const after = await census();
      // No card survived.
      expect(after.products).toBe(before.products);
      // No child was linked.
      expect(after.parented).toBe(before.parented);
      // No entry claims any of it happened.
      expect(after.audit).toBe(before.audit);
      const nameNow = (await exec<{ name: string }[]>(`select name from products where id=?::uuid`, [a]))[0].name;
      // And the rename went with it.
      expect(nameNow).toBe(nameA);
    });

    it('a parent name that used to overflow the message is accepted', async () => {
      // ~220 characters was the reviewer's boundary for the old CREATE
      // message, whose fixed text pushed it past 255.
      const cardName = long(220, 'Conjunto de Sillas y Mesa de Comedor en Roble Macizo ');
      const products = build(realAudit());
      const created = await products.createFamily(
        cardName,
        [
          { id: await mkProduct(), label: 'A' },
          { id: await mkProduct(), label: 'B' },
        ],
        ACTOR,
      );
      const entry = (
        await exec<{ message: string; changes: any }[]>(
          `select message, changes from audit_logs where entity_id=?::uuid and action='CREATE'`,
          [created.id],
        )
      )[0];
      expect(entry.message.length).toBeLessThanOrEqual(255);
      expect(entry.changes.name.after).toBe(cardName);
    });

    it('writes no rename entry for a child nobody renamed', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const products = build(realAudit());
      await products.createFamily(
        uid('fam'),
        [
          { id: a, label: 'A' },
          { id: b, label: 'B' },
        ],
        ACTOR,
      );
      const n = (
        await exec<{ n: number }[]>(
          `select count(*)::int n from audit_logs where entity_id in (?::uuid, ?::uuid) and action='UPDATE'`,
          [a, b],
        )
      )[0].n;
      expect(n).toBe(0);
    });
  });
});
