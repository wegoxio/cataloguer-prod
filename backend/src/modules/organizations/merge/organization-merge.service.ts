import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { Organization } from '../entities/organization.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { Action, EntityType } from '../../audit-log/entities/audit-log.entity';
import { Actor } from '../../audit-log/types/actor.type';
import { lockOrganizationAccess } from '../../users/access/access-locks';
import { MERGE_MOVES, unmovedClasses } from '../lifecycle/organization-dependency-census';

/** PostgreSQL's `lock_not_available`: the NOWAIT pre-lock found a row someone else holds. */
const LOCK_NOT_AVAILABLE = '55P03';

const carriesSqlState = (error: unknown, state: string): boolean => {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const candidate = cursor as { code?: unknown; sqlState?: unknown; previous?: unknown; cause?: unknown };
    if (candidate.code === state || candidate.sqlState === state) return true;
    cursor = candidate.previous ?? candidate.cause;
  }
  return false;
};

export interface MergeConflict {
  kind: 'product-slug' | 'product-sku' | 'category-slug' | 'active-subscription' | 'already-merged' | 'unmoved-rows';
  detail: string;
  values: string[];
}

export interface MergePlan {
  dryRun: boolean;
  source: { id: string; name: string };
  target: { id: string; name: string };
  /** What would move, table by table. */
  moves: Record<string, number>;
  conflicts: MergeConflict[];
  /** True when a commit would be accepted as-is. */
  committable: boolean;
}

/** The two organization rows as the merge reads them, under their row locks. */
interface LockedOrganization {
  id: string;
  name: string;
  archived_at: Date | null;
  removedAt?: Date | null;
  stripe_subscription_id: string | null;
  merged_into_organization_id: string | null;
}

/**
 * Manual organization merge (P0-12), with the #289 P1 corrections.
 *
 * The P0-02 backfill deliberately created one organization per store and
 * refused to guess which stores belong together. This is the other half:
 * a human states that SOURCE is really part of TARGET, sees exactly what
 * would move and what collides, and only then commits.
 *
 * Semantics:
 *  - everything the merge KNOWS HOW to move is RETAGGED to the target: stores,
 *    users, products, categories, orders, and the store_products links
 *  - inventories are never mixed — each store keeps its own store_products
 *    rows; they just change owner together with their store
 *  - identity collisions (both clients selling a "silla-nordica", or reusing
 *    a SKU) are CONFLICTS: the commit refuses them, because renaming or
 *    deduplicating a client's catalogue is a human decision, not a side
 *    effect of a merge
 *  - the emptied source is archived, never deleted — its id stays in the
 *    audit trail, so the merge remains traceable years later
 *
 * WHAT #289 ADDED, AND WHY.
 *
 *  - THE MERGE LEAVES A DURABLE RECORD. `merged_into_organization_id` and
 *    `merged_at` are written on the source in the same transaction that
 *    retags and archives it. An audit message cannot answer "was this company
 *    merged, and into whom" from SQL; removal (#294) has to, and so does a
 *    restoration that must revalidate a consistent record set. A source that
 *    already carries the record refuses a second merge.
 *
 *  - THE MERGE REFUSES WHAT IT CANNOT MOVE. Since this service was written,
 *    the platform gained inventory custody, a ledger, receiving, import
 *    provenance, specifications and more — every one of them tagged with the
 *    organization, none of them retagged here. Retagging them correctly is a
 *    design of its own (the open half of #289). Until it lands, a source that
 *    owns rows in any of those classes is a CONFLICT, not a silent split:
 *    `organization-dependency-census.ts` states the class list and the
 *    predicate per table, and a PostgreSQL test holds that list equal to the
 *    live schema. The consequence is deliberate and stated on #289: a company
 *    with a default warehouse cannot be merged today. That is the truth about
 *    what this code can do, said before the click instead of discovered in an
 *    inventory report months later.
 *
 *  - THE DECISION AND THE WRITE SHARE ONE TRANSACTION, UNDER LOCKS. The
 *    counts and conflicts used to be read outside any transaction and the
 *    retag committed afterwards. Now both organizations are read `FOR UPDATE`
 *    (ascending id, one order for every caller) after the `org-access` lock of
 *    each — a merge retags users, which is an access change, and Slice A's
 *    lock order puts `org-access` first. Two merges of the same source
 *    serialise there; the second finds the record and refuses.
 *
 *    The concurrent writer is closed by the DATABASE, not by this count:
 *    every MOVED and every UNMOVED class carries guard triggers
 *    (`Migration20260913130000`) that lock the organization row `FOR SHARE`
 *    before writing. That share conflicts with the `FOR UPDATE` taken here,
 *    so whichever side reaches the row first makes the other wait: a writer
 *    that won is counted (or retagged) after it commits; a merge that won
 *    commits its record and the writer then reads it and refuses (SQLSTATE
 *    WGR02). The MOVED guards exist because the NOWAIT pre-lock below reaches
 *    only rows that exist: a branch inserted after it would otherwise wait on
 *    the foreign key and then land on a company already recorded as merged.
 *
 *  - THE AUDIT COMMITS WITH THE MERGE. Both audit rows are written inside the
 *    same transaction (`recordAuditEntryIn`), so a merge without its evidence
 *    and evidence without its merge are both impossible, and no caller can
 *    receive a failure for a merge that has already committed.
 *
 *  - THE MERGE NEVER WAITS WHILE HOLDING THE ORGANIZATION. After the decision
 *    it locks every row it is about to retag with `FOR UPDATE NOWAIT`. A row a
 *    writer holds at that moment makes the merge fail with a retryable 409
 *    instead of waiting — and a transaction that never waits after taking the
 *    organization lock cannot be part of a wait cycle. That, plus guards that
 *    take organization rows in one ascending order, is the deadlock argument;
 *    `organization-merge-guards.pg.spec.ts` demonstrates both orders and the
 *    NOWAIT refusal against a real database.
 */
@Injectable()
export class OrganizationMergeService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: EntityRepository<Organization>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async merge(targetId: string, sourceId: string, dryRun: boolean, actor?: Actor): Promise<MergePlan> {
    if (targetId === sourceId) {
      throw new BadRequestException('Source and target are the same organization');
    }

    const em = this.organizationRepository.getEntityManager() as EntityManager;
    const plan = await this.inTransaction(em, async (trx) => {
      const run = async (sql: string, params: unknown[] = []): Promise<any[]> => trx.execute(sql, params);
      const count = async (sql: string, params: unknown[] = []): Promise<number> =>
        Number((await run(sql, params))[0]?.n ?? 0);

      // Lock 1 — `org-access` for BOTH companies, ascending, because the users
      // retag below is an access change and every access change serialises here.
      for (const id of [targetId, sourceId].sort()) await lockOrganizationAccess(trx, id);

      // Lock 2 — the two organization rows, ascending id, so two merges that
      // name the same pair from opposite ends wait on each other instead of
      // deadlocking. Read AFTER the lock: a row read before it is a guess.
      const rows: LockedOrganization[] = await run(
        `select id, name, archived_at, stripe_subscription_id, merged_into_organization_id, removed_at as "removedAt"
           from organizations where id in (?) order by id for update /* removed_at: read in every state; a removed side is refused below */`,
        [[targetId, sourceId]],
      );
      const target = rows.find((r) => r.id === targetId);
      const source = rows.find((r) => r.id === sourceId);
      if (!target || !source) throw new NotFoundException('Organization not found');
      // #294: a removed company is neither a merge target nor a merge source.
      if (target.removedAt || source.removedAt) throw new NotFoundException('Organization not found');
      if (target.archived_at) throw new BadRequestException('The target organization is archived');

      const moves: Record<string, number> = {
        // #293 follows the rule the lines below already set: the census counts
        // what the merge moves OPERATIONALLY, so a removed branch is excluded
        // from the number an operator approves. It still travels with the
        // company — see the retag block.
        stores: await count(`select count(*)::int as n from stores where organization_id = ? and removed_at is null`, [
          sourceId,
        ]),
        // Live members only: a removed identity is not part of what an operator
        // is being asked to approve moving, and counting it would overstate the
        // merge. The retag below still carries it.
        users: await count(`select count(*)::int as n from users where organization_id = ? and removed_at is null`, [
          sourceId,
        ]),
        // #292: the census counts what the merge is moving OPERATIONALLY, so
        // removed records are excluded — the same rule `users` above follows.
        // They still travel with the company; see the retag block below.
        products: await count(
          `select count(*)::int as n from products where organization_id = ? and removed_at is null`,
          [sourceId],
        ),
        categories: await count(
          `select count(*)::int as n from categories where organization_id = ? and removed_at is null`,
          [sourceId],
        ),
        store_products: await count(`select count(*)::int as n from store_products where organization_id = ?`, [
          sourceId,
        ]),
        sales_orders: await count(`select count(*)::int as n from sales_orders where organization_id = ?`, [sourceId]),
        api_keys: await count(
          `select count(*)::int as n from api_keys k join stores s on s.id = k.store_id
            where s.organization_id = ? and s.removed_at is null`,
          [sourceId],
        ),
      };

      const conflicts: MergeConflict[] = [];

      // A merged company has already given its records away. Merging it again
      // would retag nothing and archive nothing, and — worse — record a second
      // target over the first. The durable record is what makes this refusable.
      if (source.merged_into_organization_id) {
        conflicts.push({
          kind: 'already-merged',
          detail: 'The source was already merged into another organization; its records are no longer its own.',
          values: [source.merged_into_organization_id],
        });
      }

      const slugClashes = await run(
        // #292: uniqueness is partial over live rows, so only live rows can
        // clash. Reporting a removed row as a conflict would send someone to
        // rename an item they cannot see.
        `select a.slug from products a join products b on b.slug = a.slug
         where a.organization_id = ? and b.organization_id = ?
           and a.removed_at is null and b.removed_at is null limit 20`,
        [sourceId, targetId],
      );
      if (slugClashes.length) {
        conflicts.push({
          kind: 'product-slug',
          detail: 'Both organizations have a product with this slug; rename or archive one side first.',
          values: slugClashes.map((r: any) => r.slug),
        });
      }

      const skuClashes = await run(
        // #292: as above; the SKU index is partial over live rows too.
        `select a.sku from products a join products b on b.sku = a.sku
         where a.organization_id = ? and b.organization_id = ? and a.sku is not null
           and a.removed_at is null and b.removed_at is null limit 20`,
        [sourceId, targetId],
      );
      if (skuClashes.length) {
        conflicts.push({
          kind: 'product-sku',
          detail: 'Both organizations use this SKU; resolve which product keeps it first.',
          values: skuClashes.map((r: any) => r.sku),
        });
      }

      const categoryClashes = await run(
        // #292: as above, for the partial category slug index.
        `select a.slug from categories a join categories b on b.slug = a.slug
         where a.organization_id = ? and b.organization_id = ?
           and a.removed_at is null and b.removed_at is null limit 20`,
        [sourceId, targetId],
      );
      if (categoryClashes.length) {
        conflicts.push({
          kind: 'category-slug',
          detail: 'Both organizations have a category with this slug; merge or rename them first.',
          values: categoryClashes.map((r: any) => r.slug),
        });
      }

      // Two live subscriptions cannot be silently collapsed into one bill
      if (source.stripe_subscription_id) {
        conflicts.push({
          kind: 'active-subscription',
          detail: 'The source still has an active Stripe subscription; cancel it before merging.',
          values: [source.stripe_subscription_id],
        });
      }

      // #289: every class the merge does not move. Table names and predicates
      // come from the census constant, never from input; the census test runs
      // each predicate against the live schema.
      const unmoved: string[] = [];
      for (const cls of unmovedClasses()) {
        const n = await count(
          `select count(*)::int as n from ${cls.table} t where t.organization_id = ? and (${cls.refuseWhen})`,
          [sourceId],
        );
        if (n > 0) unmoved.push(`${cls.table} (${n})`);
      }
      if (unmoved.length) {
        conflicts.push({
          kind: 'unmoved-rows',
          detail:
            'The source owns records this merge does not move; archiving it would leave them on a company nobody can see. ' +
            'Resolve them first, or wait for the retag design tracked on #289.',
          values: unmoved,
        });
      }

      const result: MergePlan = {
        dryRun,
        source: { id: source.id, name: source.name },
        target: { id: target.id, name: target.name },
        moves,
        conflicts,
        committable: conflicts.length === 0,
      };

      if (dryRun) return result;
      if (conflicts.length > 0) {
        throw new BadRequestException(
          `Merge refused: ${conflicts.length} unresolved conflict group(s). Run the dry-run and resolve them first.`,
        );
      }

      // Lock every row the retag will touch WITHOUT WAITING. Holding the
      // organization while waiting on a row is the only way this transaction
      // could sit inside a wait cycle; refusing to wait removes it. The order
      // is the MOVED census order, stable and stated.
      for (const table of MERGE_MOVES) {
        await run(`select 1 from ${table} where organization_id = ? for update nowait`, [sourceId]);
      }

      // THE RECORD FIRST, THEN THE RETAG (#277 P2). The source is stamped
      // merged — record and archive in one statement, so there is no moment
      // at which it is archived-but-unrecorded or recorded-but-live — BEFORE
      // its rows are moved. The lifecycle guard lets nothing leave an
      // ARCHIVED company, and lets a pure retag (organization_id alone) leave
      // a MERGED one: that exception is the P1 contract for exactly this
      // statement sequence, and stamping first is what makes the merge of an
      // already-archived company its own permitted path rather than a bypass.
      await run(
        `update organizations
            set archived_at = now(), merged_into_organization_id = ?, merged_at = now(), updated_at = now()
          where id = ? /* removed_at: a removed side was refused under the lock above (#294) */`,
        [targetId, sourceId],
      );

      // Retag everything in one transaction: either the whole client moves, or
      // nothing does. Inventories travel untouched with their store.
      const retag = (sql: string) => run(sql, [targetId, sourceId]);
      // EVERY row, removed branches included — the same reasoning the users and
      // products retags below carry. A removed store left behind in the
      // archived source would become unrestorable, because restoration refuses
      // while the owning company is archived. It moves with the company.
      await retag(`update stores set organization_id = ? where organization_id = ? /* removed_at: all rows move */`);
      // EVERY row, removed ones included: `removed_at` is deliberately not
      // filtered here. A removed identity left behind in the archived source
      // would become unrestorable — its organization would no longer be active,
      // and restoration checks that. It travels with the rest of the company.
      await retag(`update users set organization_id = ? where organization_id = ? /* removed_at: all rows move */`);
      await retag(`update products set organization_id = ? where organization_id = ? /* removed_at: all rows move */`);
      await retag(
        `update categories set organization_id = ? where organization_id = ? /* removed_at: all rows move */`,
      );
      await retag(`update store_products set organization_id = ? where organization_id = ?`);
      await retag(`update sales_orders set organization_id = ? where organization_id = ?`);

      // THE AUDIT IS EVIDENCE OF THE MERGE, SO IT COMMITS WITH THE MERGE. Both
      // rows are written through the transaction's own entity manager: if
      // either insertion fails, the retag, the archive and the record roll
      // back with it, and the caller never learns of a merge that did not
      // happen — nor of a failure after one that did. There is no post-commit
      // audit call in this service.
      if (actor) {
        const summary = Object.entries(moves)
          .filter(([, n]) => n > 0)
          .map(([table, n]) => `${n} ${table}`)
          .join(', ');
        await this.auditLogService.recordAuditEntryIn(
          trx,
          actor.id,
          actor.email,
          EntityType.ORGANIZATION,
          target.id,
          Action.UPDATE,
          { merge: { source: source.id, sourceName: source.name, moves } },
          `Merged organization "${source.name}" into "${target.name}" (${summary || 'nothing to move'})`,
          { organizationId: target.id },
        );
        await this.auditLogService.recordAuditEntryIn(
          trx,
          actor.id,
          actor.email,
          EntityType.ORGANIZATION,
          source.id,
          Action.ARCHIVE,
          { mergedInto: target.id },
          `Archived after merging into "${target.name}"`,
          { organizationId: target.id },
        );
      }
      return { ...result, committable: true };
    });

    return plan;
  }

  /**
   * Runs the merge transaction and turns PostgreSQL's `lock_not_available` —
   * the NOWAIT pre-lock meeting a row another transaction holds — into a 409
   * the operator can simply retry. Nothing was written: the pre-lock runs
   * before the first retag, and the transaction rolls back as a whole.
   */
  private async inTransaction<T>(em: EntityManager, work: (trx: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await em.transactional(work);
    } catch (error) {
      if (carriesSqlState(error, LOCK_NOT_AVAILABLE)) {
        throw new ConflictException(
          'Another operation is writing to this organization right now; nothing was merged. Retry the merge.',
        );
      }
      throw error;
    }
  }
}
