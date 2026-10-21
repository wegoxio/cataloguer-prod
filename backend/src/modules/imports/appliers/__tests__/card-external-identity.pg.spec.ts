import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductMutation, ProductsApplier } from '../products.applier';
import { PlannedUnit } from '../../execution/batch-planner';
import { RowOutcome } from '../../entities/import-row-result.entity';
import { PublicationGuardService } from '../../../products/publication/publication-guard.service';
import { matchRow } from '../../matching/record-matching';
import { buildLookups } from '../../runner/orm-match-lookups';

const APPROVER = '00000000-0000-4000-8000-000000000001';
const SOURCE = 'manual-spreadsheet';
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * A CARD'S IDENTITY LIVES IN `import_external_identities`, NOT IN ITS SKU.
 *
 * A card is never ordered, sold or received, so a sellable item's identifier
 * has no business on one — and `products_organization_id_sku_unique` makes it
 * scarce besides. But something durable has to remain, because `matchRow`
 * resolves a repeated row by prior source identity, then SKU, then manufacturer
 * code, and its name step deliberately returns UNRESOLVED because names repeat.
 *
 * The table has existed since the DesignHof work, is already READ by
 * `buildLookups` and by the relationships applier, and was never written by
 * anything. Writing it is the whole correction: the card gives up the SKU it
 * was named by, and the name survives where the matcher already looks.
 *
 * No schema change was needed. The existing shape —
 * `(organization, source_system, external_id, target_type) → target_id`, unique
 * — represents exactly this.
 */
d('a card is identified durably, not by a SKU (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let applier: ProductsApplier;
  let organizationId: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    pg.orm.em.getConnection().execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const context = () => ({
    organizationId,
    executionId: randomUUID(),
    importType: 'PRODUCTS',
    approvedByUserId: APPROVER,
    em: pg.orm.em as EntityManager,
  });
  const unit = (mutations: ProductMutation[]): PlannedUnit =>
    ({ kind: 'ROW', sourceRows: mutations.map((m) => m.sourceRow), mutations }) as PlannedUnit;
  const applyUnit = (u: PlannedUnit) =>
    (pg.orm.em as EntityManager).transactional(async (tem) =>
      applier.apply(u, { ...context(), em: tem as EntityManager }),
    );

  /** The family row a spreadsheet produces: named by a SKU column. */
  const familyUnit = (over: {
    sku: string;
    name: string;
    childName: string;
    targetId?: string;
    /** On a retry the recompiled plan matches the CHILD too, by its own name. */
    childTargetId?: string;
  }) =>
    unit([
      {
        sourceRow: 1,
        targetId: over.targetId ?? null,
        fields: { name: over.name, sku: over.sku },
        externalIdentity: { sourceSystem: SOURCE, externalId: over.sku },
        children: [
          {
            sourceRow: 2,
            targetId: over.childTargetId ?? null,
            fields: { name: over.childName, optionLabel: 'M' },
          },
        ],
      } as ProductMutation,
    ]);

  const identitiesFor = async (externalId: string) =>
    exec<{ target_id: string }[]>(
      `select target_id from import_external_identities
        where organization_id = ?::uuid and external_id = ? and target_type = 'product'`,
      [organizationId, externalId],
    );
  const productCount = async (name: string) =>
    (await exec<{ n: number }[]>(`select count(*)::int n from products where name = ?`, [name]))[0].n;
  const childCount = async (id: string) =>
    (await exec<{ n: number }[]>(`select count(*)::int n from products where parent_id = ?::uuid`, [id]))[0].n;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    applier = new ProductsApplier(new PublicationGuardService());
    organizationId = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Ident Co', ?, now(), now()) returning id`,
        [uid('ident')],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('a first import creates ONE card, with no SKU and a recorded identity', async () => {
    const sku = uid('P1').toUpperCase();
    const name = uid('Camiseta');
    const results = await applyUnit(familyUnit({ sku, name, childName: uid('Camiseta M') }));
    expect(results.every((r) => r.outcome === RowOutcome.CREATED)).toBe(true);

    const cardId = results[0].targetId as string;
    const [row] = await exec<{ sku: string | null; manufacturer_code: string | null }[]>(
      `select sku, manufacturer_code from products where id = ?::uuid`,
      [cardId],
    );
    expect(row.sku).toBeNull();
    expect(row.manufacturer_code).toBeNull();
    expect(await productCount(name)).toBe(1);
    expect((await identitiesFor(sku)).map((r) => r.target_id)).toEqual([cardId]);
  });

  it('an IDENTICAL retry resolves the same card through the recorded identity', async () => {
    const sku = uid('P2').toUpperCase();
    const name = uid('Mesa');
    const first = await applyUnit(familyUnit({ sku, name, childName: uid('Mesa 160') }));
    const cardId = first[0].targetId as string;

    // The second run compiles a NEW plan against the catalogue as it now
    // stands: no product carries that SKU any more, so this is the exact path
    // that used to create a duplicate.
    const lookups = await buildLookups(pg.orm.em as EntityManager, organizationId);
    const match = matchRow({ sku, name }, lookups);
    expect(match.decision).toBe('UPDATE');
    expect(match.provenance).toBe('PRIOR_SOURCE_IDENTITY');
    expect(match.targetId).toBe(cardId);

    const second = await applyUnit(familyUnit({ sku, name, childName: uid('Mesa 160'), targetId: cardId }));
    expect(second[0].targetId).toBe(cardId);
    expect(await productCount(name)).toBe(1);
  });

  it('a RENAMED card on retry still resolves to the same record', async () => {
    const sku = uid('P3').toUpperCase();
    const first = await applyUnit(familyUnit({ sku, name: uid('Silla'), childName: uid('Silla A') }));
    const cardId = first[0].targetId as string;

    // The name is what changed; the identifier is not. Matching on names would
    // have created a second card here.
    const lookups = await buildLookups(pg.orm.em as EntityManager, organizationId);
    const match = matchRow({ sku, name: 'Un nombre completamente distinto' }, lookups);
    expect(match.targetId).toBe(cardId);
    expect(match.provenance).toBe('PRIOR_SOURCE_IDENTITY');
  });

  it('a retry adds no duplicate card and no duplicate children', async () => {
    const sku = uid('P4').toUpperCase();
    const name = uid('Lampara');
    const childName = uid('Lampara M');
    const first = await applyUnit(familyUnit({ sku, name, childName }));
    const cardId = first[0].targetId as string;
    const childrenAfterFirst = await childCount(cardId);

    const [existingChild] = await exec<{ id: string }[]>(`select id from products where parent_id = ?::uuid`, [cardId]);
    await applyUnit(familyUnit({ sku, name, childName, targetId: cardId, childTargetId: existingChild.id }));
    expect(await productCount(name)).toBe(1);
    // The child row matches by its own name on the second run, so the family
    // does not grow a twin of the child it already has.
    expect(await childCount(cardId)).toBe(childrenAfterFirst);
    expect((await identitiesFor(sku)).length).toBe(1);
  });

  it('a CONFLICTING identity fails closed, and writes nothing', async () => {
    const sku = uid('P5').toUpperCase();
    const first = await applyUnit(familyUnit({ sku, name: uid('Uno'), childName: uid('Uno M') }));
    const firstCardId = first[0].targetId as string;

    const clashingName = uid('Dos');
    // A DIFFERENT card claiming an identifier that already names one. Silently
    // re-aiming the pointer would make every later run update the wrong record.
    await expect(applyUnit(familyUnit({ sku, name: clashingName, childName: uid('Dos M') }))).rejects.toThrow(
      /already identifies a different product/i,
    );

    expect(await productCount(clashingName)).toBe(0);
    expect((await identitiesFor(sku)).map((r) => r.target_id)).toEqual([firstCardId]);
  });

  it('a ROLLBACK leaves no orphan identity mapping', async () => {
    const sku = uid('P6').toUpperCase();
    const name = uid('Rollback');
    const before = (await identitiesFor(sku)).length;

    // The unit fails after the identity would have been written: the card is
    // made, the identity recorded, and then the transaction is torn down.
    await expect(
      (pg.orm.em as EntityManager).transactional(async (tem) => {
        await applier.apply(familyUnit({ sku, name, childName: uid('Rollback M') }), {
          ...context(),
          em: tem as EntityManager,
        });
        throw new Error('the batch failed after this unit');
      }),
    ).rejects.toThrow(/batch failed/i);

    expect(await productCount(name)).toBe(0);
    expect((await identitiesFor(sku)).length).toBe(before);
  });

  it('an EXISTING card that already carries a legacy identifier keeps it', async () => {
    // Made before this rule existed: a card with a SKU of its own.
    const legacy = uid('LEGACY').toUpperCase();
    const name = uid('Antigua');
    const [card] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, sku, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, ?, now(), now()) returning id`,
      [name, uid('antigua'), organizationId, legacy],
    );
    await exec(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, parent_id, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, ?::uuid, now(), now())`,
      [uid('hija'), uid('hija'), organizationId, card.id],
    );

    await applyUnit(familyUnit({ sku: legacy, name, childName: uid('Otra hija'), targetId: card.id }));

    // Untouched: clearing a long-standing identifier is a migration, not an
    // import, and nothing here is authorised to run one.
    const [row] = await exec<{ sku: string | null }[]>(`select sku from products where id = ?::uuid`, [card.id]);
    expect(row.sku).toBe(legacy);
  });

  /**
   * THE SEQUENCE THAT MOTIVATED THE RULE.
   *
   * A card gives its SKU up at commit, which frees that exact string for any
   * other product to take. If matching tried the SKU first, the next product
   * to reuse it would capture a re-import of the file that has always meant
   * the card, and the run would silently rewrite an unrelated item.
   */
  it('a REUSED live SKU does not steal a re-import from the card that identifier names', async () => {
    const sku = 'FAM-P-' + randomUUID().slice(0, 8).toUpperCase();
    const cardName = uid('Camiseta');
    const childName = uid('Camiseta M');

    // 1. The parent is imported, identified by FAM-P.
    const first = await applyUnit(familyUnit({ sku, name: cardName, childName }));
    expect(first.every((r) => r.outcome === RowOutcome.CREATED)).toBe(true);
    const cardId = first[0].targetId as string;

    // 2. It committed with no SKU, and the identifier points at it.
    const [card] = await exec<{ sku: string | null; manufacturer_code: string | null }[]>(
      `select sku, manufacturer_code from products where id = ?::uuid`,
      [cardId],
    );
    expect(card.sku).toBeNull();
    expect(card.manufacturer_code).toBeNull();
    expect((await identitiesFor(sku)).map((r) => r.target_id)).toEqual([cardId]);

    // 3. An unrelated standalone product now takes that very SKU.
    const strangerName = uid('Ajeno');
    const [stranger] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, sale_price, cost, track_inventory, sku, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 33, 22, 11, true, ?, now(), now()) returning id`,
      [strangerName, uid('ajeno'), organizationId, sku],
    );
    const strangerBefore = (
      await exec<Record<string, unknown>[]>(`select * from products where id = ?::uuid`, [stranger.id])
    )[0];

    // 4. The original import is run again. The plan is recompiled against the
    //    catalogue as it now stands — which is exactly where the old order
    //    would have resolved to the stranger.
    const lookups = await buildLookups(pg.orm.em as EntityManager, organizationId);
    const match = matchRow({ sku, name: cardName }, lookups);

    // 5. The card is resolved, through the identifier it was recorded under.
    expect(match.decision).toBe('UPDATE');
    expect(match.provenance).toBe('PRIOR_SOURCE_IDENTITY');
    expect(match.targetId).toBe(cardId);
    expect(match.targetId).not.toBe(stranger.id);

    // The recompiled plan matches the CHILD by its own name, as a real re-run
    // does; without that the fixture would create a second child and the count
    // below would be measuring the fixture, not the rule.
    const [existingChild] = await exec<{ id: string }[]>(`select id from products where parent_id = ?::uuid`, [cardId]);
    const second = await applyUnit(
      familyUnit({ sku, name: cardName, childName, targetId: cardId, childTargetId: existingChild.id }),
    );
    expect(second[0].targetId).toBe(cardId);

    // 6. The unrelated product is untouched, column for column.
    const strangerAfter = (
      await exec<Record<string, unknown>[]>(`select * from products where id = ?::uuid`, [stranger.id])
    )[0];
    expect(strangerAfter).toEqual(strangerBefore);

    // 7. No duplicate card, no duplicate child, no duplicate identity row.
    expect(await productCount(cardName)).toBe(1);
    expect(await childCount(cardId)).toBe(1);
    expect((await identitiesFor(sku)).length).toBe(1);
    expect(await productCount(strangerName)).toBe(1);
  });

  it('a STALE mapping fails closed rather than falling through to the SKU', async () => {
    const sku = 'STALE-' + randomUUID().slice(0, 8).toUpperCase();
    const cardName = uid('Fantasma');
    const first = await applyUnit(familyUnit({ sku, name: cardName, childName: uid('Fantasma M') }));
    const cardId = first[0].targetId as string;

    // The card is gone; the mapping still names it. A broken pointer is not
    // the same as no pointer.
    await exec(`delete from products where parent_id = ?::uuid`, [cardId]);
    await exec(`delete from products where id = ?::uuid`, [cardId]);

    // Something else now carries the identifier as a live SKU.
    const strangerName = uid('Otro');
    const [stranger] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, sku, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 12, false, ?, now(), now()) returning id`,
      [strangerName, uid('otro'), organizationId, sku],
    );
    const before = (
      await exec<Record<string, unknown>[]>(`select * from products where id = ?::uuid`, [stranger.id])
    )[0];

    const lookups = await buildLookups(pg.orm.em as EntityManager, organizationId);
    const match = matchRow({ sku, name: cardName }, lookups);
    expect(match.decision).toBe('UNRESOLVED');
    expect(match.targetId).toBeNull();
    expect(match.reasons.join(' ')).toMatch(/no longer exists/i);

    // Nothing was written to the product that happens to hold the string.
    const after = (
      await exec<Record<string, unknown>[]>(`select * from products where id = ?::uuid`, [stranger.id])
    )[0];
    expect(after).toEqual(before);
  });

  it('a row whose OWN two identifiers disagree fails closed, with no writes', async () => {
    // The file carries an external id AND a separate SKU, and they name two
    // different records. Nobody can say which the row means.
    const externalId = 'EXT-' + randomUUID().slice(0, 8).toUpperCase();
    const cardName = uid('Doble');
    const first = await applyUnit(
      unit([
        {
          sourceRow: 1,
          fields: { name: cardName },
          externalIdentity: { sourceSystem: SOURCE, externalId },
          children: [{ sourceRow: 2, fields: { name: uid('Doble M'), optionLabel: 'M' } }],
        } as ProductMutation,
      ]),
    );
    const cardId = first[0].targetId as string;

    const otherSku = 'OTRO-' + randomUUID().slice(0, 8).toUpperCase();
    const otherName = uid('Distinto');
    const [other] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, sku, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 9, false, ?, now(), now()) returning id`,
      [otherName, uid('distinto'), organizationId, otherSku],
    );
    const before = (await exec<Record<string, unknown>[]>(`select * from products where id = ?::uuid`, [other.id]))[0];

    const lookups = await buildLookups(pg.orm.em as EntityManager, organizationId);
    const match = matchRow({ externalId, sku: otherSku, name: cardName }, lookups);
    expect(match.decision).toBe('UNRESOLVED');
    expect(match.targetId).toBeNull();
    expect(match.reasons.join(' ')).toMatch(/name two different products/i);
    expect(match.ambiguousCandidates?.map((c) => c.id).sort()).toEqual([cardId, other.id].sort());

    const after = (await exec<Record<string, unknown>[]>(`select * from products where id = ?::uuid`, [other.id]))[0];
    expect(after).toEqual(before);
  });

  it('a legacy card given a DIFFERENT SKU is BLOCKED, and keeps the one it has', async () => {
    // The update SET list writes whatever the mapping provided, so without a
    // rule a family row naming its parent by a SKU column would quietly change
    // a card's long-standing identifier — and the next row carrying the old one
    // would then collide on the unique index.
    const legacy = uid('OLD').toUpperCase();
    const name = uid('Legado');
    const [card] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, sku, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, ?, now(), now()) returning id`,
      [name, uid('legado'), organizationId, legacy],
    );
    await exec(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, parent_id, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, ?::uuid, now(), now())`,
      [uid('hija'), uid('hija'), organizationId, card.id],
    );

    const results = await applyUnit(
      familyUnit({ sku: uid('NUEVO').toUpperCase(), name, childName: uid('Otra'), targetId: card.id }),
    );
    expect(results.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
    expect(results[0].reason).toMatch(/already has the SKU/i);

    const [row] = await exec<{ sku: string | null }[]>(`select sku from products where id = ?::uuid`, [card.id]);
    expect(row.sku).toBe(legacy);
  });

  it('a DIFFERENT non-empty identifier for the same card is rejected', async () => {
    const sku = uid('P7').toUpperCase();
    const name = uid('Fija');
    const first = await applyUnit(familyUnit({ sku, name, childName: uid('Fija M') }));
    const cardId = first[0].targetId as string;

    // The same card, told it is now called something else, while the old name
    // still points at it. Two identifiers for one card is not the problem; one
    // identifier for two cards is, and this is the shape that produces it.
    const other = uid('P7B').toUpperCase();
    await applyUnit(familyUnit({ sku: other, name, childName: uid('Fija L'), targetId: cardId }));
    expect((await identitiesFor(other)).map((r) => r.target_id)).toEqual([cardId]);
    expect((await identitiesFor(sku)).map((r) => r.target_id)).toEqual([cardId]);

    // ...and that second identifier cannot then be handed to a third card.
    const third = uid('Tercera');
    await expect(applyUnit(familyUnit({ sku: other, name: third, childName: uid('Tercera M') }))).rejects.toThrow(
      /already identifies a different product/i,
    );
    expect(await productCount(third)).toBe(0);
  });
});
