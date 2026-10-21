import { createHash } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { InventoryOpeningReconciliation } from '../entities/inventory-opening-reconciliation.entity';
import { canonicalJson } from '../ledger/inventory-command-fingerprint';
import { DiscrepancyClass, LegacySnapshot, defaultWarehouseCode } from './inventory-opening.types';
import { storeLocationCode } from '../ledger/inventory.types';

/**
 * P5-B2 — proposes, but never decides.
 *
 * For each product it reads the two pre-ledger columns, records exactly what
 * they said, classifies how they disagree, and offers a proposal. It does NOT
 * choose between them where they diverge: there is no defensible global rule,
 * and a silent max/min/sum is precisely what the owner decision forbids. A
 * DIVERGENT product is proposed with NO allocations, so somebody has to state
 * the answer before anything can be posted.
 */
@Injectable()
export class InventoryOpeningProposalService {
  constructor(
    @InjectRepository(InventoryOpeningReconciliation)
    private readonly reconciliationRepository: EntityRepository<InventoryOpeningReconciliation>,
  ) {}

  private get em(): EntityManager {
    return this.reconciliationRepository.getEntityManager() as EntityManager;
  }

  /**
   * The canonical legacy snapshot and its fingerprint.
   *
   * Stores are sorted by id, so the digest depends on the DATA and not on the
   * order the database happened to return rows in.
   */
  static fingerprint(snapshot: LegacySnapshot): string {
    const canonical: LegacySnapshot = {
      ...snapshot,
      stores: [...snapshot.stores].sort((a, b) => (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0)),
    };
    return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex');
  }

  static classify(productQuantity: number, allocationTotal: number): DiscrepancyClass {
    if (productQuantity === allocationTotal) return 'MATCHED';
    if (allocationTotal === 0) return 'PRODUCT_ONLY';
    if (productQuantity === 0) return 'ALLOCATION_ONLY';
    return 'DIVERGENT';
  }

  /** Every product of the organization, with its legacy columns, as one read. */
  async snapshotOrganization(organizationId: string, em?: EntityManager): Promise<LegacySnapshot[]> {
    const manager = em ?? this.em;
    const rows: {
      product_id: string;
      product_quantity: number;
      track_inventory: boolean;
      store_id: string | null;
      store_quantity: number | null;
      store_track: boolean | null;
    }[] = await manager.execute(
      `select p.id as product_id, p.stock_quantity as product_quantity, p.track_inventory,
              sp.store_id, sp.stock_quantity as store_quantity, sp.track_inventory as store_track
         from products p
         left join store_products sp on sp.product_id = p.id
        -- #292: the opening proposal covers the tenant's operable catalogue,
        -- so a removed item is not proposed. Its balances are already zero —
        -- removal is blocked otherwise — and proposing an opening for a row
        -- nobody can see would put a number on an invisible item.
        where p.organization_id = ? and p.removed_at is null
        order by p.id, sp.store_id`,
      [organizationId],
    );
    const byProduct = new Map<string, LegacySnapshot>();
    for (const row of rows) {
      let snapshot = byProduct.get(row.product_id);
      if (!snapshot) {
        snapshot = {
          productId: row.product_id,
          productQuantity: Number(row.product_quantity ?? 0),
          trackInventory: Boolean(row.track_inventory),
          stores: [],
        };
        byProduct.set(row.product_id, snapshot);
      }
      if (row.store_id) {
        snapshot.stores.push({
          storeId: row.store_id,
          quantity: Number(row.store_quantity ?? 0),
          trackInventory: Boolean(row.store_track),
        });
      }
    }
    return [...byProduct.values()];
  }

  /**
   * Writes one PROPOSED reconciliation per product, replacing any earlier
   * proposal that has not been approved. Approved and posted rows are never
   * touched — the database trigger refuses it, and so does this.
   */
  async propose(
    organizationId: string,
  ): Promise<{ proposed: number; skipped: number; byClass: Record<string, number> }> {
    return this.em.transactional(async (tem) => {
      const em = tem as EntityManager;
      const snapshots = await this.snapshotOrganization(organizationId, em);

      const locations: { id: string; kind: string; code: string; is_default: boolean; store_id: string | null }[] =
        await em.execute(
          `select id, kind, code, is_default, store_id from inventory_locations where organization_id = ?`,
          [organizationId],
        );
      const defaultWarehouse = locations.find((l) => l.is_default && l.kind === 'WAREHOUSE') ?? null;
      const storeLocation = new Map(locations.filter((l) => l.store_id).map((l) => [l.store_id as string, l.id]));

      let proposed = 0;
      let skipped = 0;
      const byClass: Record<string, number> = { MATCHED: 0, PRODUCT_ONLY: 0, ALLOCATION_ONLY: 0, DIVERGENT: 0 };

      for (const snapshot of snapshots) {
        const allocationTotal = snapshot.stores.reduce((sum, store) => sum + store.quantity, 0);
        const discrepancyClass = InventoryOpeningProposalService.classify(snapshot.productQuantity, allocationTotal);
        const fingerprint = InventoryOpeningProposalService.fingerprint(snapshot);

        const existing: { id: string; status: string }[] = await em.execute(
          `select id, status from inventory_opening_reconciliations where organization_id = ? and product_id = ?::uuid`,
          [organizationId, snapshot.productId],
        );
        if (existing[0] && existing[0].status !== 'PROPOSED') {
          skipped += 1;
          continue;
        }
        if (existing[0]) {
          await em.execute(
            `delete from inventory_opening_reconciliation_allocations where reconciliation_id = ?::uuid`,
            [existing[0].id],
          );
          await em.execute(`delete from inventory_opening_reconciliations where id = ?::uuid`, [existing[0].id]);
        }

        // A DIVERGENT product is proposed with the product column as a starting
        // figure and NO allocations, so the approval has to state where the
        // stock actually is. The other classes have an unambiguous reading.
        const proposedTotal = discrepancyClass === 'ALLOCATION_ONLY' ? allocationTotal : snapshot.productQuantity;

        const [row]: { id: string }[] = await em.execute(
          `insert into inventory_opening_reconciliations
             (organization_id, product_id, legacy_snapshot_json, legacy_product_quantity, proposed_org_total,
              discrepancy_class, source_fingerprint, idempotency_key, status, created_at, updated_at)
           values (?, ?::uuid, ?::jsonb, ?, ?, ?, ?, ?, 'PROPOSED', now(), now())
           returning id`,
          [
            organizationId,
            snapshot.productId,
            JSON.stringify(snapshot),
            snapshot.productQuantity,
            proposedTotal,
            discrepancyClass,
            fingerprint,
            `opening:${organizationId}:${snapshot.productId}`,
          ],
        );

        if (discrepancyClass !== 'DIVERGENT') {
          for (const store of snapshot.stores) {
            if (store.quantity <= 0) continue;
            const destination = storeLocation.get(store.storeId);
            if (!destination) {
              throw new BadRequestException(
                `Store ${store.storeId} has no custody location; bootstrap locations before proposing`,
              );
            }
            await em.execute(
              `insert into inventory_opening_reconciliation_allocations
                 (organization_id, reconciliation_id, destination_location_id, approved_quantity, created_at)
               values (?, ?::uuid, ?::uuid, ?, now())`,
              [organizationId, row.id, destination, store.quantity],
            );
          }
          const remainder = proposedTotal - (discrepancyClass === 'PRODUCT_ONLY' ? 0 : allocationTotal);
          if (remainder > 0) {
            if (!defaultWarehouse) {
              throw new BadRequestException('This organization has no default warehouse; bootstrap locations first');
            }
            await em.execute(
              `insert into inventory_opening_reconciliation_allocations
                 (organization_id, reconciliation_id, destination_location_id, approved_quantity, created_at)
               values (?, ?::uuid, ?::uuid, ?, now())`,
              [organizationId, row.id, defaultWarehouse.id, remainder],
            );
          }
        }

        byClass[discrepancyClass] += 1;
        proposed += 1;
      }

      return { proposed, skipped, byClass };
    });
  }

  /** Re-derives a product's fingerprint from live data; used to detect drift. */
  async currentFingerprint(organizationId: string, productId: string, em?: EntityManager): Promise<string | null> {
    const snapshots = await this.snapshotOrganization(organizationId, em);
    const snapshot = snapshots.find((s) => s.productId === productId);
    return snapshot ? InventoryOpeningProposalService.fingerprint(snapshot) : null;
  }
}

export { defaultWarehouseCode, storeLocationCode };
