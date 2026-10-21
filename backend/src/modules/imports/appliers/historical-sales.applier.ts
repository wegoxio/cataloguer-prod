import { Injectable } from '@nestjs/common';
import { txExecute } from '../execution/tx';
import { ApplyContext, RowApplication, UnitApplier } from '../execution/import-executor';
import { PlannedUnit } from '../execution/batch-planner';
import { RowOutcome } from '../entities/import-row-result.entity';

/**
 * Historical store sales — records only.
 *
 * The customer arrives with years of sales history and wants to see it. What
 * they must never get is that history behaving like today's orders: deducting
 * stock sold in 2023, reserving inventory, moving a ledger balance, or turning
 * up in a fulfilment queue.
 *
 * The guarantee is made three times over, deliberately, because one of them
 * will eventually be edited by someone who does not know why it is there:
 *
 *  1. **A separate table.** Everything that drives fulfilment, availability and
 *     the ledger reads `sales_orders`/`sales_order_items`. This writes neither,
 *     so no existing query can reach these rows at all.
 *  2. **A CHECK constraint.** `stock_deducted` may only be false, so a path
 *     that tried to deduct would fail its INSERT rather than succeed quietly.
 *  3. **This applier.** It contains no inventory call, no ledger call and no
 *     sales-order write, and a test asserts that against its own source.
 *
 * A mapping that asks for a deduction is REFUSED rather than obeyed-and-ignored.
 * Silently dropping the request would let somebody believe their stock had been
 * adjusted.
 */

export interface HistoricalSaleRow {
  sourceRow: number;
  /** The shop, chosen explicitly in the plan. Never inferred from the file. */
  storeId: string;
  /** Matched product, when the row could be resolved to one. */
  productId?: string | null;
  /** What the source called the item, kept whether or not it matched. */
  itemText: string;
  variantText?: string | null;
  quantity: number;
  unitPrice?: number | null;
  lineTotal?: number | null;
  currency?: string | null;
  /** Business time: when the sale happened. */
  occurredAt: Date;
  externalRef?: string | null;
  customerReference?: string | null;
  /**
   * Present only so a mapping that asked for it can be REFUSED by name.
   *
   * If this were simply absent, a mapping requesting a deduction would be
   * silently ignored, and somebody would believe their stock had been adjusted.
   */
  requestsStockDeduction?: boolean;
}

/** The sentence the UI must show wherever these records appear. */
export const HISTORICAL_SALE_NOTICE = 'Historical record — inventory unaffected.';

@Injectable()
export class HistoricalSalesApplier implements UnitApplier {
  async apply(unit: PlannedUnit, context: ApplyContext): Promise<RowApplication[]> {
    const rows = unit.mutations as HistoricalSaleRow[];
    const results: RowApplication[] = [];

    for (const row of rows) {
      const refusal = refuseDeduction(row);
      if (refusal) {
        results.push({ sourceRow: row.sourceRow, outcome: RowOutcome.BLOCKED, reason: refusal });
        continue;
      }

      const inserted = await txExecute<{ id: string }[]>(
        context.em,
        `insert into imported_historical_sales
           (organization_id, store_id, product_id, item_text, variant_text,
            quantity, unit_price, line_total, currency, occurred_at,
            external_ref, customer_reference, stock_deducted,
            execution_id, source_table, source_row, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?, ?, now())
         on conflict (execution_id, source_table, source_row) do nothing
         returning id`,
        [
          context.organizationId,
          row.storeId,
          row.productId ?? null,
          row.itemText,
          row.variantText ?? null,
          row.quantity,
          row.unitPrice ?? null,
          row.lineTotal ?? null,
          row.currency ?? null,
          row.occurredAt,
          row.externalRef ?? null,
          row.customerReference ?? null,
          context.executionId,
          unitSourceTable(unit),
          row.sourceRow,
        ],
      );

      if (!Array.isArray(inserted) || inserted.length === 0) {
        // Already recorded by an earlier attempt of this same run. Reporting it
        // as skipped is the truth: nothing was written now, and nothing needs
        // to be.
        results.push({
          sourceRow: row.sourceRow,
          outcome: RowOutcome.SKIPPED,
          reason: 'This sale was already recorded by this import.',
        });
        continue;
      }

      results.push({
        sourceRow: row.sourceRow,
        outcome: RowOutcome.CREATED,
        targetType: 'historical-sale',
        targetId: inserted[0].id,
        matchProvenance: row.productId ? 'MATCHED_PRODUCT' : null,
        reason: row.productId ? null : `Kept as "${row.itemText}" — no product in your catalogue matched it.`,
      });
    }

    return results;
  }
}

/**
 * Why a row asking for a stock deduction is refused.
 *
 * Returned as a sentence rather than thrown, so the row is BLOCKED with an
 * explanation and the rest of the batch survives — one bad mapping decision
 * should not cost the other four hundred sales.
 */
export function refuseDeduction(row: HistoricalSaleRow): string | null {
  if (row.requestsStockDeduction === true) {
    return 'Historical sales never change stock. This import records what was sold; it does not adjust your inventory. Remove the stock-deduction option and import again.';
  }
  return null;
}

function unitSourceTable(unit: PlannedUnit): string {
  const table = (unit as unknown as { sourceTable?: string }).sourceTable;
  return typeof table === 'string' && table !== '' ? table : 'sales';
}
