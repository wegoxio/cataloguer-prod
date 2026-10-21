import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { InventoryOpeningReconciliation } from '../entities/inventory-opening-reconciliation.entity';
import { InventoryPostingService } from '../ledger/inventory-posting.service';
import { InventoryOpeningProposalService } from './inventory-opening-proposal.service';
import { InventoryCommand, InventoryPrincipal } from '../ledger/inventory.types';
import { OpeningApprovalInput, OpeningBlocker } from './inventory-opening.types';
import { provisionOrganizationLocationsIn } from '../locations/inventory-location-provisioning';

/**
 * P5-B2 — approval, location bootstrap, and the opening epoch itself.
 *
 * Three fail-closed rules govern everything here:
 *
 *  1. An approval must balance. `approvedOrgTotal` equals the sum of its
 *     normalized allocations plus any approved transit, checked against the
 *     child rows rather than a number somebody typed twice.
 *  2. An approval is bound to the bytes it was granted against. The epoch
 *     recomputes each product's legacy fingerprint and refuses on any drift, so
 *     an approval cannot be applied to data that moved afterwards.
 *  3. No partial cutover. The epoch refuses unless EVERY tracked product of the
 *     organization is approved and unblocked.
 */
@Injectable()
export class InventoryOpeningService {
  constructor(
    @InjectRepository(InventoryOpeningReconciliation)
    private readonly reconciliationRepository: EntityRepository<InventoryOpeningReconciliation>,
    private readonly posting: InventoryPostingService,
    private readonly proposals: InventoryOpeningProposalService,
  ) {}

  private get em(): EntityManager {
    return this.reconciliationRepository.getEntityManager() as EntityManager;
  }

  /**
   * Creates the custody identities B1 deliberately did not: exactly one default
   * warehouse per organization, and one canonical location per store.
   *
   * Idempotent, and safe to re-run: codes are derived from immutable uuids, and
   * the partial unique indexes make a duplicate impossible rather than merely
   * unlikely.
   *
   * #284: the rules now live in `inventory-location-provisioning.ts`, shared
   * with onboarding and store creation, so a company created through the
   * product and one bootstrapped by the operator CLI get identical rows. This
   * wrapper keeps the CLI's contract — its own transaction, the same return
   * shape — unchanged.
   */
  async bootstrapLocations(organizationId: string): Promise<{ warehouseId: string; storeLocationIds: string[] }> {
    return this.em.transactional(async (tem) => {
      const { warehouseId, storeLocationIds } = await provisionOrganizationLocationsIn(
        tem as EntityManager,
        organizationId,
      );
      return { warehouseId, storeLocationIds };
    });
  }

  /**
   * Approves one product's opening. The allocations supplied here REPLACE any
   * proposal: the proposal was advice, this is the decision.
   */
  async approve(input: OpeningApprovalInput): Promise<{ reconciliationId: string }> {
    return this.em.transactional(async (tem) => {
      const em = tem as EntityManager;
      const rows: { id: string; status: string; discrepancy_class: string; approved_in_transit_quantity: number }[] =
        await em.execute(
          `select id, status, discrepancy_class, approved_in_transit_quantity
             from inventory_opening_reconciliations
            where organization_id = ? and product_id = ?::uuid`,
          [input.organizationId, input.productId],
        );
      const row = rows[0];
      if (!row) throw new BadRequestException('This product has no opening reconciliation to approve');
      if (row.status !== 'PROPOSED') {
        throw new ConflictException(`This opening reconciliation is ${row.status} and can no longer be approved`);
      }
      if (input.approvedOrgTotal < 0) throw new BadRequestException('An approved total cannot be negative');
      // A discrepancy must be explained by a person. MATCHED needs no words.
      if (row.discrepancy_class !== 'MATCHED' && !input.discrepancyReason?.trim()) {
        throw new BadRequestException(`A ${row.discrepancy_class} opening must record why this total was chosen`);
      }

      const seen = new Set<string>();
      let allocated = 0;
      for (const allocation of input.allocations) {
        if (allocation.approvedQuantity < 0) throw new BadRequestException('An approved allocation cannot be negative');
        if (seen.has(allocation.destinationLocationId)) {
          throw new BadRequestException('One approved quantity per destination');
        }
        seen.add(allocation.destinationLocationId);
        allocated += allocation.approvedQuantity;
      }
      const transit = Number(row.approved_in_transit_quantity ?? 0);
      // The balance equation, checked against the rows that will actually exist.
      if (input.approvedOrgTotal !== allocated + transit) {
        throw new BadRequestException(
          `Approved total ${input.approvedOrgTotal} does not equal allocations ${allocated} plus transit ${transit}`,
        );
      }

      await em.execute(`delete from inventory_opening_reconciliation_allocations where reconciliation_id = ?::uuid`, [
        row.id,
      ]);
      for (const allocation of input.allocations) {
        if (allocation.approvedQuantity === 0) continue;
        await em.execute(
          `insert into inventory_opening_reconciliation_allocations
             (organization_id, reconciliation_id, destination_location_id, approved_quantity, created_at)
           values (?, ?::uuid, ?::uuid, ?, now())`,
          [input.organizationId, row.id, allocation.destinationLocationId, allocation.approvedQuantity],
        );
      }
      await em.execute(
        `update inventory_opening_reconciliations
            set approved_org_total = ?, discrepancy_reason = ?, approved_by_user_id = ?::uuid,
                approved_at = now(), status = 'APPROVED', updated_at = now()
          where id = ?::uuid`,
        [input.approvedOrgTotal, input.discrepancyReason ?? null, input.approvedByUserId, row.id],
      );
      return { reconciliationId: row.id };
    });
  }

  async reject(organizationId: string, productId: string, reason: string): Promise<{ changed: boolean }> {
    // `returning 1`: the caller audits a rejection atomically with it, and a
    // no-op — already rejected, already posted, or no such reconciliation —
    // must be distinguishable from a decision that actually landed.
    const updated: unknown[] = await this.em.execute(
      `update inventory_opening_reconciliations
          set status = 'REJECTED', discrepancy_reason = ?, updated_at = now()
        where organization_id = ? and product_id = ?::uuid and status = 'PROPOSED' returning 1`,
      [reason, organizationId, productId],
    );
    return { changed: updated.length > 0 };
  }

  /**
   * The ambiguity gate. Every reason the epoch must not run, gathered rather
   * than thrown one at a time, so an operator sees the whole picture before
   * the point of no return.
   */
  async openingBlockers(organizationId: string, em?: EntityManager): Promise<OpeningBlocker[]> {
    const manager = em ?? this.em;
    const blockers: OpeningBlocker[] = [];

    const warehouses: { n: number }[] = await manager.execute(
      `select count(*)::int as n from inventory_locations where organization_id = ? and is_default and kind = 'WAREHOUSE'`,
      [organizationId],
    );
    if (warehouses[0].n !== 1) {
      blockers.push({ code: 'NO_DEFAULT_WAREHOUSE', detail: `found ${warehouses[0].n}, expected exactly 1` });
    }

    const negatives: { detail: string }[] = await manager.execute(
      // #292: opening blockers describe work the tenant must do. A removed
      // item is outside their catalogue, so listing it would demand a repair on
      // something they cannot open — and removal is itself blocked while any
      // balance is non-zero, so a removed row's cache is already settled.
      `select 'product ' || id || ' holds ' || stock_quantity as detail from products
        where organization_id = ? and stock_quantity < 0 and removed_at is null
       union all
       select 'store_product ' || sp.id || ' holds ' || sp.stock_quantity
         from store_products sp where sp.organization_id = ? and sp.stock_quantity < 0`,
      [organizationId, organizationId],
    );
    blockers.push(...negatives.map((row) => ({ code: 'NEGATIVE_LEGACY_QUANTITY', detail: row.detail })));

    const archived: { detail: string }[] = await manager.execute(
      `select 'archived product ' || id || ' holds ' || stock_quantity as detail
         from products where organization_id = ? and archived_at is not null and stock_quantity <> 0
          and removed_at is null` /* #292: as above */,
      [organizationId],
    );
    blockers.push(...archived.map((row) => ({ code: 'ARCHIVED_PRODUCT_HOLDS_STOCK', detail: row.detail })));

    const unapproved: { detail: string }[] = await manager.execute(
      `select 'product ' || p.id || ' is ' || coalesce(r.status, 'UNRECONCILED') as detail
         from products p
         left join inventory_opening_reconciliations r
           on r.organization_id = p.organization_id and r.product_id = p.id
        where p.organization_id = ? and p.archived_at is null and p.removed_at is null
          and coalesce(r.status, 'UNRECONCILED') not in ('APPROVED', 'POSTED')`,
      [organizationId],
    );
    blockers.push(...unapproved.map((row) => ({ code: 'PRODUCT_NOT_APPROVED', detail: row.detail })));

    const unbalanced: { detail: string }[] = await manager.execute(
      `select 'product ' || r.product_id || ' approved ' || r.approved_org_total
              || ' but allocations total ' || coalesce(a.total, 0) as detail
         from inventory_opening_reconciliations r
         left join (select reconciliation_id, sum(approved_quantity)::int as total
                      from inventory_opening_reconciliation_allocations group by 1) a
           on a.reconciliation_id = r.id
        where r.organization_id = ? and r.status = 'APPROVED'
          and r.approved_org_total is distinct from (coalesce(a.total, 0) + r.approved_in_transit_quantity)`,
      [organizationId],
    );
    blockers.push(...unbalanced.map((row) => ({ code: 'APPROVAL_DOES_NOT_BALANCE', detail: row.detail })));

    const foreignDestinations: { detail: string }[] = await manager.execute(
      `select 'allocation ' || a.id || ' targets a location of another organization' as detail
         from inventory_opening_reconciliation_allocations a
         join inventory_locations l on l.id = a.destination_location_id
        where a.organization_id = ? and l.organization_id is distinct from a.organization_id`,
      [organizationId],
    );
    blockers.push(...foreignDestinations.map((row) => ({ code: 'FOREIGN_DESTINATION', detail: row.detail })));

    // Fingerprint drift: an approval granted against bytes that have since moved.
    const snapshots = await this.proposals.snapshotOrganization(organizationId, manager);
    const live = new Map(
      snapshots.map((snapshot) => [snapshot.productId, InventoryOpeningProposalService.fingerprint(snapshot)]),
    );
    const approved: { product_id: string; source_fingerprint: string }[] = await manager.execute(
      `select product_id, source_fingerprint from inventory_opening_reconciliations
        where organization_id = ? and status = 'APPROVED'`,
      [organizationId],
    );
    for (const row of approved) {
      if (live.get(row.product_id) !== row.source_fingerprint) {
        blockers.push({
          code: 'LEGACY_DATA_MOVED_SINCE_APPROVAL',
          detail: `product ${row.product_id} no longer matches the bytes it was approved against`,
        });
      }
    }

    return blockers;
  }

  /**
   * Posts the opening epoch. THE POINT OF NO RETURN (ADR 013 §10): after the
   * first posted opening transaction the system stays frozen until cutover
   * completes or the verified backup is fully restored. Rollback is
   * restore-based, never migration `down()`.
   */
  async postOpening(
    organizationId: string,
    principal: InventoryPrincipal,
  ): Promise<{ posted: number; zeroTotal: number; transactionIds: string[] }> {
    const blockers = await this.openingBlockers(organizationId);
    if (blockers.length) {
      throw new BadRequestException(
        `The opening epoch is blocked: ${blockers.map((b) => `${b.code} (${b.detail})`).join('; ')}`,
      );
    }

    const approved: { id: string; product_id: string; approved_org_total: number; idempotency_key: string }[] =
      await this.em.execute(
        `select id, product_id, approved_org_total, idempotency_key
           from inventory_opening_reconciliations
          where organization_id = ? and status = 'APPROVED'
          order by product_id`,
        [organizationId],
      );

    const transactionIds: string[] = [];
    let zeroTotal = 0;
    for (const row of approved) {
      const allocations: { destination_location_id: string; approved_quantity: number }[] = await this.em.execute(
        `select destination_location_id, approved_quantity
           from inventory_opening_reconciliation_allocations
          where reconciliation_id = ?::uuid and approved_quantity > 0
          order by destination_location_id`,
        [row.id],
      );

      if (Number(row.approved_org_total) === 0 || allocations.length === 0) {
        // An opening of nothing posts nothing: a ledger entry may not carry a
        // zero delta, and inventing an empty transaction to look tidy would be
        // a lie in the ledger.
        await this.em.execute(
          `update inventory_opening_reconciliations set status = 'POSTED', updated_at = now() where id = ?::uuid`,
          [row.id],
        );
        // The compatibility caches must still be settled. A posting syncs them
        // as part of writing the ledger, but a zero-total opening writes no
        // ledger row — and a product whose LEGACY cache was non-zero (the
        // approved decision being "open at zero") would otherwise keep its
        // stale cache forever: LEGACY_PRODUCT_CACHE_EQUALITY stays red, and
        // unfreeze — which requires green reconciliation — becomes structurally
        // impossible for the whole organization. Measured on the P5-X2
        // rehearsal (EliteToGo, product 3d7eb696, cache=5 ledger=0) before this
        // sync existed. The refresh goes through the posting service's ONE
        // authorised cache writer — the B3 census forbids a second — and a
        // cache already agreeing with the (empty) ledger is a no-op.
        await this.posting.syncCompatibilityCaches(this.em, organizationId, [row.product_id]);
        zeroTotal += 1;
        continue;
      }

      const command: InventoryCommand = {
        organizationId,
        type: 'OPENING_BALANCE',
        idempotencyKey: row.idempotency_key,
        principal,
        intents: [
          {
            productId: row.product_id,
            declaredAmount: Number(row.approved_org_total),
            intentSign: 1,
          },
        ],
        movements: allocations.map((allocation) => ({
          productId: row.product_id,
          locationId: allocation.destination_location_id,
          physicalCondition: 'GOOD' as const,
          operationalState: 'AVAILABLE' as const,
          quantityDelta: Number(allocation.approved_quantity),
        })),
      };
      const posted = await this.posting.post(command);
      transactionIds.push(posted.transactionId);
      await this.em.execute(
        `update inventory_opening_reconciliations
            set status = 'POSTED', posted_transaction_id = ?::uuid, updated_at = now()
          where id = ?::uuid`,
        [posted.transactionId, row.id],
      );
    }

    return { posted: transactionIds.length, zeroTotal, transactionIds };
  }
}
