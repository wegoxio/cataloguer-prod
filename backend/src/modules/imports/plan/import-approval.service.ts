import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Server-issued approval proofs.
 *
 * An approval a client can construct is not an approval, so the proof is minted
 * here, returned once, and stored only as a hash — for the same reason a
 * password is: reading the database should not yield a usable authorization.
 *
 * Execution presents the proof and this service re-derives everything it binds,
 * at the moment of execution rather than trusting what was true at approval
 * time. Four things are checked, and each one has a way of going stale that the
 * others do not catch:
 *
 *  - the PLAN hash, so an edited plan cannot ride an old approval;
 *  - the SOURCE hash, so re-uploading different bytes under the same source
 *    cannot slip through a plan that still looks identical;
 *  - the approver's authority NOW, because a role can be revoked between
 *    approving and running;
 *  - expiry, because a proof should not outlive the catalogue it reasoned about.
 *
 * Consumption is single-use. A proof that has run cannot run again — a retry
 * resumes the same execution from its checkpoints instead.
 */

/** 72 hours: long enough to approve on Friday and run on Monday. */
export const APPROVAL_TTL_HOURS = 72;

export interface IssuedApproval {
  approvalId: string;
  /** Returned ONCE. Never stored in this form, never logged. */
  proof: string;
  expiresAt: Date;
}

export type ApprovalRefusal =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'REVOKED'
  | 'ALREADY_CONSUMED'
  | 'PLAN_CHANGED'
  | 'SOURCE_CHANGED'
  | 'AUTHORITY_CHANGED'
  | 'WRONG_TENANT';

export interface ApprovalCheck {
  valid: boolean;
  refusal?: ApprovalRefusal;
  /** User-facing sentence. Says what to do, not merely what failed. */
  message?: string;
  approvalId?: string;
}

export interface CurrentAuthority {
  userId: string;
  role: string;
  storeId: string | null;
}

@Injectable()
export class ImportApprovalService {
  private readonly logger = new Logger(ImportApprovalService.name);

  constructor(private readonly em: EntityManager) {}

  /** 32 bytes of entropy; only its SHA-256 is ever persisted. */
  static mintProof(): { proof: string; proofHash: string } {
    const proof = randomBytes(32).toString('base64url');
    return { proof, proofHash: ImportApprovalService.hashProof(proof) };
  }

  static hashProof(proof: string): string {
    return createHash('sha256').update(proof).digest('hex');
  }

  async issue(params: {
    organizationId: string;
    planId: string;
    planVersion: number;
    planHash: string;
    sourceHash: string;
    approver: CurrentAuthority & { email: string };
    ttlHours?: number;
  }): Promise<IssuedApproval> {
    const { proof, proofHash } = ImportApprovalService.mintProof();
    const ttl = params.ttlHours ?? APPROVAL_TTL_HOURS;

    const rows = await this.em.getConnection().execute(
      `insert into import_approvals
         (organization_id, plan_id, plan_version, plan_hash, source_hash, proof_hash,
          approved_by_user_id, approved_by_email, approved_with_role, approved_with_store_id, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now() + (? || ' hours')::interval)
       returning id, expires_at`,
      [
        params.organizationId,
        params.planId,
        params.planVersion,
        params.planHash,
        params.sourceHash,
        proofHash,
        params.approver.userId,
        params.approver.email,
        params.approver.role,
        params.approver.storeId,
        String(ttl),
      ],
    );

    return { approvalId: rows[0].id, proof, expiresAt: new Date(rows[0].expires_at) };
  }

  /**
   * Verify a proof against the state that exists RIGHT NOW.
   *
   * The proof is looked up by its hash and then compared in constant time. The
   * lookup alone would be enough to find the row, but comparing the stored hash
   * against the presented one without timing leaks costs nothing and keeps the
   * comparison honest if the lookup is ever relaxed.
   */
  async verify(params: {
    organizationId: string;
    proof: string;
    currentPlanHash: string;
    currentSourceHash: string;
    currentAuthority: CurrentAuthority;
  }): Promise<ApprovalCheck> {
    const proofHash = ImportApprovalService.hashProof(params.proof);
    const rows = await this.em.getConnection().execute(
      `select id, organization_id, plan_hash, source_hash, proof_hash,
              approved_by_user_id, approved_with_role, approved_with_store_id,
              expires_at, revoked_at, consumed_at
         from import_approvals
        where proof_hash = ?
        limit 1`,
      [proofHash],
    );

    if (!rows.length) {
      return {
        valid: false,
        refusal: 'NOT_FOUND',
        message: 'This approval is not recognized. Approve the plan again.',
      };
    }
    const row = rows[0];

    if (!constantTimeEquals(row.proof_hash, proofHash)) {
      return {
        valid: false,
        refusal: 'NOT_FOUND',
        message: 'This approval is not recognized. Approve the plan again.',
      };
    }

    // Tenant first: a proof from another organization must not even reveal
    // which of the other reasons would have applied.
    if (row.organization_id !== params.organizationId) {
      return {
        valid: false,
        refusal: 'WRONG_TENANT',
        message: 'This approval is not recognized. Approve the plan again.',
      };
    }
    if (row.revoked_at) {
      return {
        valid: false,
        refusal: 'REVOKED',
        message: 'This approval was withdrawn. Review the plan and approve it again.',
      };
    }
    if (row.consumed_at) {
      return {
        valid: false,
        refusal: 'ALREADY_CONSUMED',
        message: 'This approval has already been used. Resume the existing run rather than starting a new one.',
      };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return {
        valid: false,
        refusal: 'EXPIRED',
        message: 'This approval has expired. Review the plan and approve it again.',
      };
    }
    if (row.plan_hash !== params.currentPlanHash) {
      return {
        valid: false,
        refusal: 'PLAN_CHANGED',
        message: 'The plan changed after it was approved. Review the changes and approve it again.',
      };
    }
    if (row.source_hash !== params.currentSourceHash) {
      return {
        valid: false,
        refusal: 'SOURCE_CHANGED',
        message: 'The uploaded file changed after this plan was approved. Re-analyze the file and approve it again.',
      };
    }
    // Authority is re-derived, not trusted from the approval: a role revoked
    // after approval must stop the run.
    if (
      row.approved_by_user_id !== params.currentAuthority.userId ||
      row.approved_with_role !== params.currentAuthority.role ||
      (row.approved_with_store_id ?? null) !== params.currentAuthority.storeId
    ) {
      return {
        valid: false,
        refusal: 'AUTHORITY_CHANGED',
        message: 'The access that approved this plan has changed. Approve it again with your current access.',
      };
    }

    return { valid: true, approvalId: row.id };
  }

  /**
   * Spend the proof.
   *
   * Conditional on `consumed_at` still being null, so two concurrent executions
   * cannot both claim the same approval — the database decides, and the loser
   * is told the approval was already used rather than silently running.
   */
  async consume(approvalId: string): Promise<boolean> {
    const rows = await this.em
      .getConnection()
      .execute(`update import_approvals set consumed_at = now() where id = ? and consumed_at is null returning id`, [
        approvalId,
      ]);
    return rows.length === 1;
  }

  /**
   * The live approval a queued run should execute under, if there still is one.
   *
   * The worker never sees the proof — it was returned once, to the browser, and
   * only its hash was ever stored. So a run started through the lifecycle
   * routes, where the proof was already verified at enqueue time, identifies
   * its approval by the plan instead. What that identification must still
   * establish is that the approval is live RIGHT NOW: unexpired, unrevoked and
   * unconsumed, all of which can have changed in the window between the
   * execution being queued and a worker picking it up.
   *
   * Ordered newest-first and limited to one. A plan approved, revoked and
   * approved again has exactly one approval that matters, and it is the last.
   */
  async findLiveForPlan(
    organizationId: string,
    planId: string,
  ): Promise<{ id: string; approvedByUserId: string; approvedWithRole: string; expiresAt: Date } | null> {
    const rows = await this.em
      .getConnection()
      .execute<{ id: string; approved_by_user_id: string; approved_with_role: string; expires_at: Date }[]>(
        `select id, approved_by_user_id, approved_with_role, expires_at
         from import_approvals
        where organization_id = ? and plan_id = ?
          and revoked_at is null and consumed_at is null and expires_at > now()
        order by created_at desc
        limit 1`,
        [organizationId, planId],
      );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      approvedByUserId: row.approved_by_user_id,
      approvedWithRole: row.approved_with_role,
      expiresAt: new Date(row.expires_at),
    };
  }

  /**
   * Withdraw every live approval for a plan.
   *
   * Called whenever the plan or its source changes. The hash comparison in
   * `verify` would catch it anyway; revoking makes the reason explicit rather
   * than leaving a person to infer it from a mismatch.
   */
  async revokeForPlan(planId: string, reason: string): Promise<number> {
    const rows = await this.em.getConnection().execute(
      `update import_approvals
          set revoked_at = now(), revoked_reason = ?
        where plan_id = ? and revoked_at is null and consumed_at is null
        returning id`,
      [reason, planId],
    );
    if (rows.length) this.logger.log(`Revoked ${rows.length} approval(s) for plan ${planId}: ${reason}`);
    return rows.length;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a ?? '', 'utf8');
  const right = Buffer.from(b ?? '', 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
