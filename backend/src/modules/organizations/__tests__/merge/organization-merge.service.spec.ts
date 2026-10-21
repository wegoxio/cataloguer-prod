import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrganizationMergeService } from '../../merge/organization-merge.service';
import { MERGE_MOVES, unmovedClasses } from '../../lifecycle/organization-dependency-census';

/**
 * Unit coverage of the merge DECISION. The transaction, the locks and the
 * database's own refusals are proved against PostgreSQL in
 * `organization-merge.pg.spec.ts` and `organization-merge-concurrency.pg.spec.ts`;
 * this file pins what the service asks and in which order, with the database
 * replaced by a recorder.
 */
describe('OrganizationMergeService', () => {
  const TARGET = 'org-target';
  const SOURCE = 'org-source';
  const lockedRow = (id: string, name: string, extra: Partial<Record<string, unknown>> = {}) => ({
    id,
    name,
    archived_at: null,
    stripe_subscription_id: null,
    merged_into_organization_id: null,
    ...extra,
  });

  let service: OrganizationMergeService;
  let executed: string[];
  let sqlResults: Record<string, any[]>;
  let rows: Record<string, any>;
  let audit: any;
  let auditCalls: { em: unknown; phase: 'inside' | 'outside' }[];
  let transactionOpen: boolean;

  const trx = () => ({
    execute: jest.fn(async (sql: string) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      executed.push(flat);
      if (flat.includes('pg_advisory_xact_lock')) return [];
      if (flat.includes('from organizations where id in')) return Object.values(rows);
      // Longest key first, so 'from products where organization_id' beats
      // the looser 'from products' inside the join queries
      const key = Object.keys(sqlResults)
        .sort((a, b) => b.length - a.length)
        .find((k) => flat.includes(k));
      // Counts default to 0; clash queries default to no rows
      return key ? sqlResults[key] : flat.includes('count(') ? [{ n: 0 }] : [];
    }),
  });

  beforeEach(() => {
    executed = [];
    sqlResults = {};
    rows = { target: lockedRow(TARGET, 'Acme'), source: lockedRow(SOURCE, 'Acme Norte') };
    audit = {
      recordAuditEntryIn: jest.fn(async (...args: unknown[]) => {
        auditCalls.push({ em: args[0], phase: transactionOpen ? 'inside' : 'outside' });
      }),
      recordAuditEntry: jest.fn(() => {
        throw new Error('a post-commit audit call must not exist');
      }),
    };
    auditCalls = [];
    transactionOpen = false;
    const em: any = {
      transactional: jest.fn(async (fn: any) => {
        transactionOpen = true;
        try {
          return await fn(trx());
        } finally {
          transactionOpen = false;
        }
      }),
    };
    const repo: any = { getEntityManager: () => em };
    service = new OrganizationMergeService(repo, audit);
  });

  const updates = () => executed.filter((sql) => sql.startsWith('update'));

  it('refuses merging an organization into itself, and 404s unknown ids', async () => {
    await expect(service.merge(TARGET, TARGET, true)).rejects.toThrow(BadRequestException);
    rows = { target: lockedRow(TARGET, 'Acme') };
    await expect(service.merge(TARGET, 'nope', true)).rejects.toThrow(NotFoundException);
  });

  it('refuses an archived target before counting anything', async () => {
    rows.target.archived_at = new Date();
    await expect(service.merge(TARGET, SOURCE, true)).rejects.toThrow('The target organization is archived');
    expect(executed.some((sql) => sql.includes('count('))).toBe(false);
  });

  it('takes both org-access locks ascending, then the two rows FOR UPDATE, before any read', async () => {
    await service.merge(TARGET, SOURCE, true);
    const locks = executed.filter((sql) => sql.includes('pg_advisory_xact_lock'));
    expect(locks).toHaveLength(2);
    expect(executed.indexOf(locks[1])).toBeLessThan(executed.findIndex((sql) => sql.includes('for update')));
    expect(executed.findIndex((sql) => sql.includes('for update'))).toBeLessThan(
      executed.findIndex((sql) => sql.includes('count(')),
    );
  });

  it('dry-run reports moves and conflicts and writes NOTHING', async () => {
    sqlResults['from products where organization_id'] = [{ n: 12 }];
    sqlResults['from products a join products b on b.slug = a.slug'] = [{ slug: 'silla-nordica' }];
    const plan = await service.merge(TARGET, SOURCE, true);
    expect(plan.dryRun).toBe(true);
    expect(plan.moves.products).toBe(12);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['product-slug']);
    expect(plan.committable).toBe(false);
    expect(updates()).toHaveLength(0);
    expect(audit.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('the commit refuses unresolved conflicts', async () => {
    sqlResults['from categories a join categories b'] = [{ slug: 'ofertas' }];
    await expect(service.merge(TARGET, SOURCE, false)).rejects.toThrow(/Merge refused/);
    expect(updates()).toHaveLength(0);
  });

  it('an active subscription on the source is a conflict, not a silent cancellation', async () => {
    rows.source.stripe_subscription_id = 'sub_123';
    const plan = await service.merge(TARGET, SOURCE, true);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['active-subscription']);
  });

  it('#289: a source that owns rows in a class the merge does not move is a conflict naming the class', async () => {
    sqlResults['from inventory_locations t'] = [{ n: 1 }];
    const plan = await service.merge(TARGET, SOURCE, true);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['unmoved-rows']);
    expect(plan.conflicts[0].values).toEqual(['inventory_locations (1)']);
    expect(plan.committable).toBe(false);
    await expect(service.merge(TARGET, SOURCE, false)).rejects.toThrow(/Merge refused/);
    expect(updates()).toHaveLength(0);
  });

  it('#289: every unmoved class is asked, with its own predicate, and scoped to the source', async () => {
    await service.merge(TARGET, SOURCE, true);
    for (const cls of unmovedClasses()) {
      const asked = executed.find((sql) => sql.includes(`from ${cls.table} t where t.organization_id = ?`));
      expect(asked).toBeDefined();
      expect(asked).toContain(`(${cls.refuseWhen})`);
    }
  });

  it('#289: an already-merged source refuses a second merge', async () => {
    rows.source.merged_into_organization_id = 'org-elsewhere';
    const plan = await service.merge(TARGET, SOURCE, true);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['already-merged']);
    await expect(service.merge(TARGET, SOURCE, false)).rejects.toThrow(/Merge refused/);
    expect(updates()).toHaveLength(0);
  });

  it('a clean commit records and archives the source in ONE statement FIRST, then retags exactly the MOVED classes (#277 P2: the retag runs on the merged-source exception)', async () => {
    const plan = await service.merge(TARGET, SOURCE, false, { id: 'u1', email: 'admin@example.com' } as any);
    expect(plan.committable).toBe(true);
    const retagged = updates()
      .filter((sql) => sql.includes('set organization_id = ?'))
      .map((sql) => sql.split(' ')[1])
      .sort();
    expect(retagged).toEqual([...MERGE_MOVES]);
    const record = updates().find((sql) => sql.startsWith('update organizations'));
    expect(record).toContain('archived_at = now()');
    expect(record).toContain('merged_into_organization_id = ?');
    expect(record).toContain('merged_at = now()');
    // The record precedes every retag: the lifecycle guard lets nothing leave
    // an ARCHIVED company and lets a pure retag leave a MERGED one, so the
    // source must already be recorded merged when its rows move.
    expect(updates().indexOf(record!)).toBe(0);
    expect(audit.recordAuditEntryIn).toHaveBeenCalledTimes(2);
    expect(audit.recordAuditEntryIn.mock.calls[1][6]).toEqual({ mergedInto: TARGET });
    expect(audit.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('both audit rows are written INSIDE the transaction, through its entity manager, after the record write', async () => {
    const trxSeen: unknown[] = [];
    const em: any = {
      transactional: jest.fn(async (fn: any) => {
        transactionOpen = true;
        const t = trx();
        trxSeen.push(t);
        try {
          return await fn(t);
        } finally {
          transactionOpen = false;
        }
      }),
    };
    const s = new OrganizationMergeService({ getEntityManager: () => em } as any, audit);
    await s.merge(TARGET, SOURCE, false, { id: 'u1', email: 'admin@example.com' } as any);
    expect(auditCalls.map((c) => c.phase)).toEqual(['inside', 'inside']);
    expect(auditCalls.every((c) => c.em === trxSeen[0])).toBe(true);
    expect(audit.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('a dry-run writes no audit at all', async () => {
    await service.merge(TARGET, SOURCE, true, { id: 'u1', email: 'admin@example.com' } as any);
    expect(audit.recordAuditEntryIn).not.toHaveBeenCalled();
    expect(audit.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('an audit failure propagates out of the transaction — it is not swallowed', async () => {
    audit.recordAuditEntryIn = jest.fn(async () => {
      throw new Error('audit refused');
    });
    await expect(service.merge(TARGET, SOURCE, false, { id: 'u1', email: 'admin@example.com' } as any)).rejects.toThrow(
      'audit refused',
    );
  });

  it('locks every MOVED class NOWAIT, in census order, after the decision and before the first retag', async () => {
    await service.merge(TARGET, SOURCE, false);
    const nowaits = executed.filter((sql) => sql.includes('for update nowait'));
    expect(nowaits.map((sql) => sql.split(' ')[3])).toEqual([...MERGE_MOVES]);
    const lastCount = Math.max(...executed.map((sql, i) => (sql.includes('count(') ? i : -1)));
    const firstNowait = executed.indexOf(nowaits[0]);
    const firstRetag = executed.findIndex((sql) => sql.startsWith('update'));
    expect(lastCount).toBeLessThan(firstNowait);
    expect(firstNowait).toBeLessThan(firstRetag);
  });

  it('a row someone else holds turns into a retryable 409, never a wait and never a 500', async () => {
    const busy: any = new Error('could not obtain lock on row');
    busy.code = '55P03';
    const em: any = {
      transactional: jest.fn(async () => {
        throw busy;
      }),
    };
    const repo: any = { getEntityManager: () => em };
    const s = new OrganizationMergeService(repo, audit);
    await expect(s.merge(TARGET, SOURCE, false)).rejects.toThrow(ConflictException);
    const other: any = new Error('boom');
    other.code = '23505';
    em.transactional = jest.fn(async () => {
      throw other;
    });
    await expect(s.merge(TARGET, SOURCE, false)).rejects.toBe(other);
  });

  it('never mixes inventories: store_products rows move owner, nothing else', async () => {
    await service.merge(TARGET, SOURCE, false);
    const touching = updates().filter((sql) => sql.includes('store_products'));
    expect(touching).toHaveLength(1);
    expect(touching[0]).toMatch(/^update store_products set organization_id = \? where organization_id = \?$/);
  });
});
