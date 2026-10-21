import { randomUUID } from 'crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { AuditLogService } from '../audit-log.service';
import { AuditLog, EntityType, Action } from '../entities/audit-log.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-A1 (#171/#203) + P5-A2 family 1 against real PostgreSQL: audit rows
 * persist the AFFECTED RESOURCE's organization/store context, and tenant views
 * list rows by that STORED context. A store view is exact organization AND
 * exact store; an organization view (ORGANIZATION_MANAGER, or the platform
 * owner under a managed organization) sees every row of ONE organization —
 * store-level and organization-level alike — and still excludes platform rows
 * (organization_id IS NULL), foreign-organization rows, and unresolved
 * legacy-null rows.
 */
d('P5-A1/A2 audit context isolation (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let service: AuditLogService;

  const ORG_A = randomUUID();
  const ORG_B = randomUUID();
  const STORE_A1 = randomUUID();
  const STORE_A2 = randomUUID();
  const STORE_B1 = randomUUID();

  const record = (message: string, context: { organizationId: string | null; storeId?: string | null }) =>
    service.recordAuditEntry(
      null,
      'p5a1@test.local',
      EntityType.PRODUCT,
      randomUUID(),
      Action.UPDATE,
      null,
      message,
      context,
    );

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
    service = new AuditLogService(em.getRepository(AuditLog) as any);

    // One row per isolation class, all written through the real service
    await record('exact row: org A, store A1', { organizationId: ORG_A, storeId: STORE_A1 });
    await record('sibling-store row: org A, store A2', { organizationId: ORG_A, storeId: STORE_A2 });
    await record('organization-level row: org A, no store', { organizationId: ORG_A });
    await record('foreign-organization row: org B, store B1', { organizationId: ORG_B, storeId: STORE_B1 });
    await record('platform row: explicit null context', { organizationId: null });
    // Legacy unresolved row written raw, as pre-backfill history would look
    await em.getConnection().execute(
      `insert into audit_logs (actor_email, entity_type, entity_id, action, message, created_at)
       values ('legacy@test.local', 'PRODUCT', ?, 'UPDATE', 'legacy unresolved row', now())`,
      [randomUUID()],
    );
  });

  afterAll(async () => {
    await pg.close();
  });

  it('persists the affected-resource context columns exactly as written', async () => {
    const [row] = await em
      .getConnection()
      .execute(`select organization_id, store_id from audit_logs where message = 'exact row: org A, store A1'`);
    expect(row.organization_id).toBe(ORG_A);
    expect(row.store_id).toBe(STORE_A1);

    const [platform] = await em
      .getConnection()
      .execute(
        `select organization_id, store_id from audit_logs where message = 'platform row: explicit null context'`,
      );
    expect(platform.organization_id).toBeNull();
    expect(platform.store_id).toBeNull();
  });

  it('platform view (no tenant view) sees every class of row', async () => {
    const result = await service.findAll({}, { page: 1, limit: 100 });
    expect(result.total).toBe(6);
    expect(result.items).toHaveLength(6);
  });

  it('store-bound ADMIN view returns ONLY exact (org A, store A1) rows — all five other classes excluded', async () => {
    const result = await service.findAll(
      {},
      { page: 1, limit: 100 },
      { kind: 'store', organizationId: ORG_A, storeId: STORE_A1 },
    );
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].message).toBe('exact row: org A, store A1');
    expect(result.items[0].organizationId).toBe(ORG_A);
    expect(result.items[0].storeId).toBe(STORE_A1);
  });

  it('sibling store view of the same organization sees only its own row', async () => {
    const result = await service.findAll(
      {},
      { page: 1, limit: 100 },
      { kind: 'store', organizationId: ORG_A, storeId: STORE_A2 },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].message).toBe('sibling-store row: org A, store A2');
  });

  it('organization-wide view of org A sees exactly its three rows — both stores plus the org-level row (P5-A2 family 1)', async () => {
    const result = await service.findAll({}, { page: 1, limit: 100 }, { kind: 'organization', organizationId: ORG_A });
    expect(result.total).toBe(3);
    const messages = result.items.map((i) => i.message).sort();
    expect(messages).toEqual([
      'exact row: org A, store A1',
      'organization-level row: org A, no store',
      'sibling-store row: org A, store A2',
    ]);
    // Platform, foreign-organization and legacy-null rows stay invisible
    for (const item of result.items) expect(item.organizationId).toBe(ORG_A);
  });

  it('narrowed ORGANIZATION_MANAGER: the exact-store view is a strict subset of its organization view — own branch only, sibling and org-level rows excluded (P5-A2 amendment)', async () => {
    const orgView = await service.findAll({}, { page: 1, limit: 100 }, { kind: 'organization', organizationId: ORG_A });
    const narrowed = await service.findAll(
      {},
      { page: 1, limit: 100 },
      { kind: 'store', organizationId: ORG_A, storeId: STORE_A1 },
    );

    expect(narrowed.total).toBe(1);
    expect(narrowed.items[0].message).toBe('exact row: org A, store A1');

    // Restriction, never expansion: every narrowed row exists in the org view,
    // and the org view is strictly larger (sibling + org-level rows excluded).
    const orgMessages = orgView.items.map((i) => i.message);
    for (const item of narrowed.items) expect(orgMessages).toContain(item.message);
    expect(orgMessages).toContain('sibling-store row: org A, store A2');
    expect(orgMessages).toContain('organization-level row: org A, no store');
    expect(orgView.total).toBeGreaterThan(narrowed.total);
  });

  it('organization-wide view of org B sees only its single row', async () => {
    const result = await service.findAll({}, { page: 1, limit: 100 }, { kind: 'organization', organizationId: ORG_B });
    expect(result.total).toBe(1);
    expect(result.items[0].message).toBe('foreign-organization row: org B, store B1');
  });

  it('filters compose with the tenant view and the pagination envelope stays truthful', async () => {
    const filtered = await service.findAll(
      { entityType: EntityType.PRODUCT, action: Action.UPDATE },
      { page: 1, limit: 100 },
      { kind: 'store', organizationId: ORG_A, storeId: STORE_A1 },
    );
    expect(filtered.total).toBe(1);
    expect(filtered.totalPages).toBe(1);

    const none = await service.findAll(
      { action: Action.DELETE },
      { page: 1, limit: 100 },
      { kind: 'store', organizationId: ORG_A, storeId: STORE_A1 },
    );
    expect(none.total).toBe(0);
    expect(none.items).toHaveLength(0);
  });
});
