import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg, insertOrganizationRaw } from '../../../../../test/pg-harness';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMergeService } from '../../merge/organization-merge.service';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * #289 P1 — the merge against a real database: the durable record, the
 * refusal for unmoved classes, and the database's own guarantees about the
 * record's shape. Every case seeds its own companies under unique slugs.
 */
d('OrganizationMergeService against PostgreSQL (#289 P1)', () => {
  let pg: DisposablePg;
  let em: EntityManager;
  let audit: AuditLogService;
  let service: OrganizationMergeService;
  let n = 0;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    audit = new AuditLogService(em.getRepository(AuditLog) as any);
    service = new OrganizationMergeService(em.getRepository(Organization) as any, audit);
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  const org = async (label: string): Promise<string> => {
    n += 1;
    return insertOrganizationRaw(em, { name: `${label} ${n}`, slug: `${label.toLowerCase()}-${n}` });
  };
  const store = async (organizationId: string): Promise<string> => {
    n += 1;
    const rows = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at) values (?, ?, ?, now(), now()) returning id`,
      [`Branch ${n}`, `branch-${n}`, organizationId],
    );
    return rows[0].id as string;
  };
  const record = async (id: string) =>
    (
      await em.execute<
        { archived_at: Date | null; merged_into_organization_id: string | null; merged_at: Date | null }[]
      >(`select archived_at, merged_into_organization_id, merged_at from organizations where id = ?`, [id])
    )[0];
  const auditRows = async (source: string, target: string) =>
    em.execute<{ entity_id: string; action: string }[]>(
      `select entity_id, action from audit_logs where entity_type = 'ORGANIZATION' and entity_id in (?, ?) order by created_at, action desc`,
      [source, target],
    );
  const ownerOf = async (storeId: string): Promise<string> =>
    (await em.execute<{ organization_id: string }[]>(`select organization_id from stores where id = ?`, [storeId]))[0]
      .organization_id;

  it('a clean commit retags, and records the target and the moment in the same statement that archives', async () => {
    const target = await org('Target');
    const source = await org('Source');
    const branch = await store(source);
    const before = await record(source);
    expect(before).toEqual({ archived_at: null, merged_into_organization_id: null, merged_at: null });

    const plan = await service.merge(target, source, false, { id: null, email: 'owner@example.com' } as any);
    expect(plan.committable).toBe(true);
    expect(plan.moves.stores).toBe(1);

    expect(await ownerOf(branch)).toBe(target);
    const after = await record(source);
    expect(after.merged_into_organization_id).toBe(target);
    expect(after.merged_at).not.toBeNull();
    expect(after.archived_at).not.toBeNull();
    expect(await record(target)).toEqual({ archived_at: null, merged_into_organization_id: null, merged_at: null });
    expect(await auditRows(source, target)).toEqual([
      { entity_id: target, action: 'UPDATE' },
      { entity_id: source, action: 'ARCHIVE' },
    ]);
  });

  it('a dry-run writes no audit row', async () => {
    const target = await org('Target');
    const source = await org('Source');
    await service.merge(target, source, true, { id: null, email: 'owner@example.com' } as any);
    expect(await auditRows(source, target)).toEqual([]);
  });

  it('the audit commits WITH the merge: when the database refuses the audit insert, nothing at all is merged', async () => {
    const target = await org('Target');
    const source = await org('Source');
    const branch = await store(source);
    await em.execute(
      `create function zz_refuse_audit() returns trigger as $$ begin raise exception 'audit refused'; end $$ language plpgsql`,
    );
    await em.execute(
      `create trigger zz_refuse_audit before insert on audit_logs for each row execute function zz_refuse_audit()`,
    );
    try {
      await expect(
        service.merge(target, source, false, { id: null, email: 'owner@example.com' } as any),
      ).rejects.toThrow(/audit refused/);
    } finally {
      await em.execute(`drop trigger zz_refuse_audit on audit_logs`);
      await em.execute(`drop function zz_refuse_audit()`);
    }
    expect(await record(source)).toEqual({ archived_at: null, merged_into_organization_id: null, merged_at: null });
    expect(await ownerOf(branch)).toBe(source);
    expect(await auditRows(source, target)).toEqual([]);
  });

  it('when only the SECOND audit insert fails, the first one rolls back with the merge — zero partial rows', async () => {
    const target = await org('Target');
    const source = await org('Source');
    const branch = await store(source);
    let calls = 0;
    const flaky = new Proxy(audit, {
      get(t, prop, receiver) {
        if (prop === 'recordAuditEntryIn') {
          return async (...args: unknown[]) => {
            calls += 1;
            if (calls === 2) throw new Error('second audit refused');
            return (t as any).recordAuditEntryIn(...args);
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });
    const s = new OrganizationMergeService(em.getRepository(Organization) as any, flaky);
    await expect(s.merge(target, source, false, { id: null, email: 'owner@example.com' } as any)).rejects.toThrow(
      'second audit refused',
    );
    expect(calls).toBe(2);
    expect(await record(source)).toEqual({ archived_at: null, merged_into_organization_id: null, merged_at: null });
    expect(await ownerOf(branch)).toBe(source);
    expect(await auditRows(source, target)).toEqual([]);
    // And the same source merges cleanly afterwards: nothing was left half-done.
    const plan = await service.merge(target, source, false, { id: null, email: 'owner@example.com' } as any);
    expect(plan.committable).toBe(true);
    expect(await auditRows(source, target)).toHaveLength(2);
  });

  it('a source that owns its default WAREHOUSE is refused — dry-run names the class, commit writes nothing', async () => {
    const target = await org('Target');
    const source = await org('Source');
    const branch = await store(source);
    await em.execute(
      `insert into inventory_locations (organization_id, kind, code, name, is_default) values (?, 'WAREHOUSE', 'MAIN', 'Main', true)`,
      [source],
    );

    const plan = await service.merge(target, source, true);
    expect(plan.committable).toBe(false);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['unmoved-rows']);
    expect(plan.conflicts[0].values).toEqual(['inventory_locations (1)']);

    await expect(service.merge(target, source, false)).rejects.toThrow(BadRequestException);
    expect(await ownerOf(branch)).toBe(source);
    expect(await record(source)).toEqual({ archived_at: null, merged_into_organization_id: null, merged_at: null });
  });

  it('an already-merged source refuses a second merge, into the same target or another', async () => {
    const target = await org('Target');
    const other = await org('Other');
    const source = await org('Source');
    await service.merge(target, source, false);

    for (const into of [target, other]) {
      const plan = await service.merge(into, source, true);
      expect(plan.conflicts.map((c) => c.kind)).toEqual(['already-merged']);
      expect(plan.conflicts[0].values).toEqual([target]);
      await expect(service.merge(into, source, false)).rejects.toThrow(/Merge refused/);
    }
    expect((await record(source)).merged_into_organization_id).toBe(target);
  });

  it('a TRAIL row never refuses: audit attribution stays where it was written', async () => {
    const target = await org('Target');
    const source = await org('Source');
    await em.execute(
      `insert into audit_logs (entity_type, entity_id, action, organization_id, created_at)
       values ('ORGANIZATION', ?, 'UPDATE', ?, now())`,
      [source, source],
    );
    const plan = await service.merge(target, source, true);
    expect(plan.committable).toBe(true);
  });

  it('the predicate is the operational surface: a checkout still creating refuses, a failed one is history', async () => {
    const target = await org('Target');
    const source = await org('Source');
    n += 1;
    await em.execute(
      `insert into billing_checkout_attempts (organization_id, plan, status, stripe_idempotency_key, request_params, stripe_customer_id, settled_at, failure_code)
       values (?, 'BASICO', 'failed', ?, '{}'::jsonb, 'cus_test', now(), 'card_declined')`,
      [source, `idem-failed-${n}`],
    );
    expect((await service.merge(target, source, true)).committable).toBe(true);

    n += 1;
    await em.execute(
      `insert into billing_checkout_attempts (organization_id, plan, status, stripe_idempotency_key, request_params, stripe_customer_id)
       values (?, 'BASICO', 'creating', ?, '{}'::jsonb, 'cus_test')`,
      [source, `idem-creating-${n}`],
    );
    const plan = await service.merge(target, source, true);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['unmoved-rows']);
    expect(plan.conflicts[0].values).toEqual(['billing_checkout_attempts (1)']);
  });

  it('refuses an archived target, the same organization on both sides, and an unknown organization', async () => {
    const target = await org('Target');
    const source = await org('Source');
    await em.execute(`update organizations set archived_at = now() where id = ?`, [target]);
    await expect(service.merge(target, source, true)).rejects.toThrow('The target organization is archived');
    await expect(service.merge(source, source, true)).rejects.toThrow(BadRequestException);
    await expect(service.merge('00000000-0000-0000-0000-000000000000', source, true)).rejects.toThrow(/not found/);
  });
});
