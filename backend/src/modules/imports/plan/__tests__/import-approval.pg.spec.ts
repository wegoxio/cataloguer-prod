import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { randomUUID } from 'crypto';
import { ImportApprovalService, CurrentAuthority } from '../import-approval.service';

/**
 * Approval against real PostgreSQL, because the properties that matter are
 * database ones: single-use consumption decided by a conditional UPDATE, and
 * expiry measured on the server's clock rather than a caller's.
 */
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('import approvals (real PostgreSQL)', () => {
  let pg: DisposablePg;
  let em: EntityManager;
  let service: ImportApprovalService;
  let orgId: string;
  let otherOrgId: string;
  let planId: string;

  const PLAN_HASH = 'p'.repeat(64);
  const SOURCE_HASH = 's'.repeat(64);
  // Real ids are UUIDs; the columns are typed uuid, so the fixture must be too.
  const APPROVER_ID = randomUUID();
  const OTHER_USER_ID = randomUUID();
  const OTHER_STORE_ID = randomUUID();
  const approver = { userId: APPROVER_ID, email: 'a@b.test', role: 'ORGANIZATION_MANAGER', storeId: null };
  const authority: CurrentAuthority = { userId: APPROVER_ID, role: 'ORGANIZATION_MANAGER', storeId: null };

  const exec = (sql: string, params: unknown[] = []) => em.getConnection().execute(sql, params);

  const makeOrg = async (slug: string) =>
    (
      await exec(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, now(), now()) returning id`,
        [slug, `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
      )
    )[0].id as string;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    service = new ImportApprovalService(em);

    orgId = await makeOrg('approval-co');
    otherOrgId = await makeOrg('other-co');

    const sourceId = (
      await exec(
        `insert into import_sources
           (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
         values (?, ?, 'x.csv', 10, ?, 'CSV_OR_TEXT', 'p9-1') returning id`,
        [orgId, `imports/${orgId}/a.csv`, SOURCE_HASH],
      )
    )[0].id;

    planId = (
      await exec(
        `insert into import_plans
           (organization_id, source_id, import_type, plan_hash, source_hash, analyzer_version,
            mapping, decisions, target_assumptions, summary)
         values (?, ?, 'PRODUCTS', ?, ?, 'a9-1', '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb) returning id`,
        [orgId, sourceId, PLAN_HASH, SOURCE_HASH],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await exec(`delete from import_approvals where plan_id = ?`, [planId]);
  });

  const issue = (ttlHours = 72) =>
    service.issue({
      organizationId: orgId,
      planId,
      planVersion: 1,
      planHash: PLAN_HASH,
      sourceHash: SOURCE_HASH,
      approver,
      ttlHours,
    });

  const verify = (proof: string, over: Partial<Parameters<ImportApprovalService['verify']>[0]> = {}) =>
    service.verify({
      organizationId: orgId,
      proof,
      currentPlanHash: PLAN_HASH,
      currentSourceHash: SOURCE_HASH,
      currentAuthority: authority,
      ...over,
    });

  describe('issuing', () => {
    it('returns a proof and stores only its hash', async () => {
      const issued = await issue();
      expect(issued.proof.length).toBeGreaterThan(30);

      const row = (await exec(`select proof_hash from import_approvals where id = ?`, [issued.approvalId]))[0];
      // Reading the database must not yield a usable authorization.
      expect(row.proof_hash).not.toBe(issued.proof);
      expect(row.proof_hash).toHaveLength(64);
    });

    it('mints a different proof every time', async () => {
      const a = await issue();
      await exec(`delete from import_approvals where plan_id = ?`, [planId]);
      const b = await issue();
      expect(a.proof).not.toBe(b.proof);
    });
  });

  describe('verifying', () => {
    it('accepts an untouched plan approved by the same person', async () => {
      const { proof } = await issue();
      expect(await verify(proof)).toMatchObject({ valid: true });
    });

    it('refuses a proof it never issued', async () => {
      const check = await verify('not-a-real-proof');
      expect(check).toMatchObject({ valid: false, refusal: 'NOT_FOUND' });
    });

    it('refuses when the PLAN changed after approval', async () => {
      const { proof } = await issue();
      const check = await verify(proof, { currentPlanHash: 'q'.repeat(64) });
      expect(check.refusal).toBe('PLAN_CHANGED');
      expect(check.message).toMatch(/approve it again/i);
    });

    it('refuses when the SOURCE BYTES changed, even if the plan still hashes the same', async () => {
      // Re-uploading different bytes under the same source is the case a plan
      // hash alone cannot see.
      const { proof } = await issue();
      const check = await verify(proof, { currentSourceHash: 't'.repeat(64) });
      expect(check.refusal).toBe('SOURCE_CHANGED');
      expect(check.message).toMatch(/re-analyze/i);
    });

    it('refuses when the approver’s ROLE was revoked between approving and running', async () => {
      const { proof } = await issue();
      const check = await verify(proof, { currentAuthority: { ...authority, role: 'ADMIN' } });
      expect(check.refusal).toBe('AUTHORITY_CHANGED');
    });

    it('refuses when a different person presents the proof', async () => {
      const { proof } = await issue();
      const check = await verify(proof, { currentAuthority: { ...authority, userId: OTHER_USER_ID } });
      expect(check.refusal).toBe('AUTHORITY_CHANGED');
    });

    it('refuses when the approver’s store binding narrowed', async () => {
      const { proof } = await issue();
      const check = await verify(proof, { currentAuthority: { ...authority, storeId: OTHER_STORE_ID } });
      expect(check.refusal).toBe('AUTHORITY_CHANGED');
    });

    it('refuses an expired proof, measured on the server clock', async () => {
      const { proof, approvalId } = await issue();
      await exec(`update import_approvals set expires_at = now() - interval '1 minute' where id = ?`, [approvalId]);
      const check = await verify(proof);
      expect(check.refusal).toBe('EXPIRED');
    });

    it('refuses a revoked proof and says it was withdrawn', async () => {
      const { proof } = await issue();
      await service.revokeForPlan(planId, 'the mapping was edited');
      const check = await verify(proof);
      expect(check.refusal).toBe('REVOKED');
      expect(check.message).toMatch(/withdrawn/i);
    });

    it('refuses a proof presented by ANOTHER tenant without revealing more', async () => {
      const { proof } = await issue();
      const check = await service.verify({
        organizationId: otherOrgId,
        proof,
        currentPlanHash: PLAN_HASH,
        currentSourceHash: SOURCE_HASH,
        currentAuthority: authority,
      });
      expect(check.valid).toBe(false);
      // Same wording as an unknown proof: a cross-tenant probe learns nothing.
      expect(check.message).toMatch(/not recognized/i);
    });
  });

  describe('consuming', () => {
    it('spends a proof exactly once', async () => {
      const { proof, approvalId } = await issue();
      expect(await verify(proof)).toMatchObject({ valid: true });
      expect(await service.consume(approvalId)).toBe(true);
      // Two concurrent executions cannot both claim one approval.
      expect(await service.consume(approvalId)).toBe(false);
    });

    it('refuses a consumed proof and points at the existing run', async () => {
      const { proof, approvalId } = await issue();
      await service.consume(approvalId);
      const check = await verify(proof);
      expect(check.refusal).toBe('ALREADY_CONSUMED');
      expect(check.message).toMatch(/resume the existing run/i);
    });
  });

  describe('revocation', () => {
    it('withdraws every live approval for a plan', async () => {
      await issue();
      expect(await service.revokeForPlan(planId, 'edited')).toBe(1);
    });

    it('leaves an already-consumed approval alone', async () => {
      const { approvalId } = await issue();
      await service.consume(approvalId);
      expect(await service.revokeForPlan(planId, 'edited')).toBe(0);
    });
  });
});
