import { Injectable } from '@nestjs/common';
import { ApplyContext, RowApplication, UnitApplier } from '../execution/import-executor';
import { PlannedUnit } from '../execution/batch-planner';
import { RowOutcome } from '../entities/import-row-result.entity';
import { InventoryPostingService } from '../../inventory/ledger/inventory-posting.service';
import type { InventoryCommand } from '../../inventory/ledger/inventory.types';
import { InventoryProposal, describeProposal, proposalIdempotencyKey } from '../inventory/inventory-proposal';

/**
 * Applying an approved inventory proposal — through the ledger, never around it.
 *
 * This is the piece that makes stock importable without a second writer. The
 * import never touches `products.stock_quantity` or
 * `store_products.stock_quantity`; it builds a command and hands it to
 * `InventoryPostingService.postWithin`, which is the same surface a sale, a
 * transfer and a receipt all go through. The caches are refreshed by that
 * service's one authorised writer as part of the same transaction, so the
 * P5-B3 census stays true.
 *
 * Three properties come free from posting inside the caller's transaction:
 *
 *  - the ledger entry, the cache refresh and the batch's checkpoint commit or
 *    roll back TOGETHER;
 *  - a repeated command under the same idempotency key REPLAYS — the posting
 *    surface returns the original transaction — so a resumed or retried run
 *    cannot double-post;
 *  - the cutover freeze is enforced once, by the posting service, rather than
 *    re-implemented here where it could drift.
 *
 * The transaction type is `ADJUSTMENT`, deliberately. `OPENING_BALANCE` is
 * refused outside a declared cutover window, and an import is by definition
 * ordinary operation — so an import that tried to post an opening balance would
 * be refused by the ledger, correctly, and confusingly. An adjustment says what
 * is actually happening: the ledger is being brought into line with what the
 * customer says they hold, attributably and by a named person.
 */

@Injectable()
export class InventoryProposalApplier implements UnitApplier {
  constructor(private readonly posting: InventoryPostingService) {}

  async apply(unit: PlannedUnit, context: ApplyContext): Promise<RowApplication[]> {
    const proposals = unit.mutations as InventoryProposal[];
    const results: RowApplication[] = [];

    for (const proposal of proposals) {
      // A declared zero is honoured as a decision, but it moves nothing: a
      // ledger entry may not carry a zero delta, and inventing an empty
      // transaction to look tidy would be a lie in the ledger.
      if (proposal.zeroDecision || proposal.totalQuantity === 0) {
        results.push({
          sourceRow: proposal.sourceRow,
          outcome: RowOutcome.SKIPPED,
          targetType: 'product',
          targetId: proposal.productId,
          reason: 'Recorded as holding nothing. No stock movement was needed.',
        });
        continue;
      }

      const command: InventoryCommand = {
        organizationId: context.organizationId,
        type: proposal.kind === 'RECEIPT' ? 'RECEIPT' : 'ADJUSTMENT',
        idempotencyKey: proposalIdempotencyKey(context.executionId, proposal.sourceRow, proposal.productId),
        // Attributable to the person who approved the import, never to the
        // system: somebody decided this stock was correct.
        principal: { kind: 'USER', userId: context.approvedByUserId },
        intents: [
          {
            productId: proposal.productId,
            declaredAmount: proposal.totalQuantity,
            intentSign: 1,
          },
        ],
        movements: proposal.placements.map((placement) => ({
          productId: proposal.productId,
          locationId: placement.locationId,
          physicalCondition: placement.condition,
          // Imported stock is AVAILABLE unless its condition says otherwise.
          // DAMAGED units are owned but not sellable, which is what the
          // condition bucket is for.
          operationalState: placement.condition === 'DAMAGED' ? 'NON_SELLABLE' : 'AVAILABLE',
          quantityDelta: placement.quantity,
        })),
      };

      // Inside the batch's transaction. The ledger entry, the cache refresh and
      // the checkpoint share one commit.
      // The batch's transaction, not the root manager: the ledger posting has
      // to roll back with the product it belongs to.
      const posted = await this.posting.postWithin(context.em, command);

      results.push({
        sourceRow: proposal.sourceRow,
        outcome: posted.replayed ? RowOutcome.SKIPPED : RowOutcome.UPDATED,
        targetType: 'inventory-transaction',
        targetId: posted.transactionId,
        matchProvenance: proposal.discrepancy,
        reason: posted.replayed
          ? 'This stock movement had already been posted by an earlier attempt of this import.'
          : describeProposal(proposal),
      });
    }

    return results;
  }
}
