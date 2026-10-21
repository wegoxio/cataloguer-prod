import { EntityManager } from '@mikro-orm/postgresql';

/**
 * When an EXISTING product may become a family card.
 *
 * The first design normalized a card into shape after writing it: clear the
 * SKU, the manufacturer code, the sale price, the cost. That is wrong twice
 * over.
 *
 * It destroys identity. A product's SKU and manufacturer code are how a
 * repeated import finds it again. `matchRow` tries prior source identity
 * first, then SKU, then manufacturer code, and only then normalized name —
 * and the name step deliberately returns UNRESOLVED rather than updating,
 * because names repeat. `import_external_identities` exists but nothing in
 * this codebase writes it yet (one reader, in the relationships applier), so
 * the first two steps are all a re-run has. Clearing them turns a clean
 * second run into a row awaiting a human decision.
 *
 * And it destroys history. A populated standalone can carry ledger entries,
 * balances, supplier lines and per-store commercial decisions. None of that
 * may be deleted to make a card of it.
 *
 * So nothing is ever cleared. A product may become a card only if it is
 * ALREADY in the shape a card must have — at which point conversion writes
 * nothing except the children's parent links, and there is nothing to
 * normalize. Anything else is refused before a single row is touched.
 */

export interface ConversionBlocker {
  /** What would have been destroyed, in a sentence an operator can act on. */
  reason: string;
}

/**
 * Reads only. Returns the first blocker found, or null when the product is
 * already parent-safe. Ordered so the most consequential loss is reported
 * first: history, then relationships, then identity, then commercial state.
 */
export async function conversionBlocker(
  em: EntityManager,
  organizationId: string,
  productId: string,
): Promise<ConversionBlocker | null> {
  const one = async (sql: string, params: unknown[]): Promise<number> =>
    ((await em.execute(sql, params)) as { n: number }[])[0].n;

  // 1. Inventory history. Entries are immutable, so a product that has ever
  //    moved cannot become a card: the card would own movements it can no
  //    longer explain, and deleting them is not a conversion, it is a loss.
  if (
    (await one(
      `select count(*)::int n from inventory_entries where organization_id = ?::uuid and product_id = ?::uuid`,
      [organizationId, productId],
    )) > 0
  ) {
    return { reason: 'it has inventory history, which a parent card cannot own and this import will not delete' };
  }
  if (
    (await one(
      `select count(*)::int n from inventory_balances where organization_id = ?::uuid and product_id = ?::uuid and quantity <> 0`,
      [organizationId, productId],
    )) > 0
  ) {
    return { reason: 'it still holds stock, and a parent card holds none' };
  }

  // Durable import identity. Something else already points at this product
  //    by an external id; converting it silently re-aims that pointer.
  if (
    (await one(
      `select count(*)::int n from import_external_identities where organization_id = ?::uuid and target_id = ?::uuid`,
      [organizationId, productId],
    )) > 0
  ) {
    return { reason: 'an earlier import identified it by an external id, which a conversion would silently re-aim' };
  }

  // 4. Identity a future import needs to find it by.
  const scalars = (
    await em.execute(
      // #292: the conversion reads the row it was handed, in whatever state.
      // The caller has already resolved that item through a filtered read, so
      // a removed one never reaches here; excluding it again would turn a
      // legitimate conversion into a silent empty result instead of an error.
      `select sku, manufacturer_code, sale_price, cost, track_inventory, stock_quantity
         from products where id = ?::uuid and organization_id = ?::uuid
         /* removed_at: resolved upstream through a filtered read */`,
      [productId, organizationId],
    )
  )[0] as
    | {
        sku: string | null;
        manufacturer_code: string | null;
        sale_price: string | null;
        cost: string | null;
        track_inventory: boolean;
        stock_quantity: number;
      }
    | undefined;
  if (!scalars) return { reason: 'it no longer exists' };
  if (scalars.sku)
    return { reason: 'it has a SKU, which is how a later import finds it and which a card may not hold' };
  if (scalars.manufacturer_code) {
    return { reason: 'it has a manufacturer code, which a card may not hold and which will not be cleared for it' };
  }

  // 5. Commercial state that only a sellable item can mean.
  if (scalars.sale_price !== null) return { reason: 'it has a sale price, which a card is never charged at' };
  if (scalars.cost !== null) return { reason: 'it has a cost, which belongs to the item that is actually bought' };
  if (scalars.track_inventory) return { reason: 'it tracks inventory, and a card holds no stock' };
  if (Number(scalars.stock_quantity) !== 0) return { reason: 'it has an opening stock figure, and a card holds none' };

  // 6. Per-store commercial decisions somebody made about selling it.
  if (
    (await one(
      `select count(*)::int n from store_products
        where product_id = ?::uuid
          and (price is not null or sale_price is not null or lead_time_days is not null or stock_quantity <> 0)`,
      [productId],
    )) > 0
  ) {
    return { reason: 'a branch has set its own price, lead time or stock for it, which a card cannot carry' };
  }

  return null;
}

/** The sentence an import row shows when conversion is refused. */
export function conversionRefusal(name: string, blocker: ConversionBlocker): string {
  return (
    `"${name}" cannot become a parent card because ${blocker.reason}. ` +
    'Create the card as a new row instead, and list this item as one of its children.'
  );
}
