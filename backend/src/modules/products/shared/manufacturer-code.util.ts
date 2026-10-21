import { EntityManager } from '@mikro-orm/postgresql';

/**
 * The manufacturer code, in ONE place (P5-W1).
 *
 * Storage, normalization and matching all live here because they have to agree:
 * a row written one way and looked up another simply never matches, and the
 * bug looks like "the import created a duplicate" rather than like a
 * normalization mismatch.
 *
 * THE RULES, stated once:
 *
 *  - **Stored verbatim apart from surrounding and repeated whitespace.** Case,
 *    punctuation, hyphens and separators are the supplier's, not ours;
 *    governing decision 19 forbids silently rewriting owner-supplied product
 *    truth, and "KARE-71234" upper-cased or de-hyphenated is no longer the code
 *    the supplier prints on the box.
 *  - **Blank is null.** An empty cell, a cell of spaces, a tab — all of them
 *    mean "not stated", and storing `''` would make an absence look like a
 *    value that happens to match every other absence.
 *  - **Matched case-insensitively, on the normalized form.** Suppliers send the
 *    same reference shouted and whispered in the same file.
 *  - **Never unique.** A code identifies a supplier's article, not a
 *    Cataloguer product, so several products may answer to one. Every lookup
 *    therefore has three possible outcomes and "pick one" is not among them.
 */

/** How the value is STORED: trimmed, internal whitespace runs collapsed. */
export function normalizeManufacturerCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const collapsed = String(raw).replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/** How the value is COMPARED: the stored form, case-folded. */
export function manufacturerCodeMatchKey(raw: unknown): string | null {
  const normalized = normalizeManufacturerCode(raw);
  return normalized === null ? null : normalized.toLowerCase();
}

/**
 * What a lookup can conclude.
 *
 * `AMBIGUOUS` is a first-class outcome, not an error condition to be smoothed
 * over: it carries every candidate so a caller can report exactly which
 * products collided instead of saying "something went wrong".
 */
export type ManufacturerCodeMatch =
  | { outcome: 'BLANK' }
  | { outcome: 'NONE'; code: string }
  | { outcome: 'UNIQUE'; code: string; productId: string }
  | { outcome: 'AMBIGUOUS'; code: string; productIds: string[] };

/**
 * The tenant-safe resolver.
 *
 * `organizationId` is REQUIRED and is a predicate of the query, never a filter
 * applied to the results: an unscoped read here would let one company's import
 * file resolve another company's product, which is the precise failure P0-05
 * exists to prevent. Archived products are excluded — an import must not
 * resurrect one by matching it.
 *
 * Ordering is deterministic (id) so an ambiguity report reads the same twice.
 */
export async function resolveByManufacturerCode(
  em: EntityManager,
  organizationId: string,
  raw: unknown,
): Promise<ManufacturerCodeMatch> {
  const key = manufacturerCodeMatchKey(raw);
  if (key === null) return { outcome: 'BLANK' };
  if (!organizationId) {
    // Fail closed rather than widen. A caller without a company has no
    // catalogue to match against, and answering NONE would be a lie that
    // ends in a duplicate product.
    throw new Error('resolveByManufacturerCode requires an organization');
  }

  const rows: { id: string }[] = await em.execute(
    `select id from products
      where organization_id = ?::uuid
        and manufacturer_code is not null
        and lower(manufacturer_code) = ?
        and archived_at is null
        -- #292: import matching must never resolve to a removed item. This is
        -- the lookup that decides which product an incoming row updates, so a
        -- removed match would write into an invisible record.
        and removed_at is null
      order by id`,
    [organizationId, key],
  );

  const code = normalizeManufacturerCode(raw) as string;
  if (rows.length === 0) return { outcome: 'NONE', code };
  if (rows.length === 1) return { outcome: 'UNIQUE', code, productId: rows[0].id };
  return { outcome: 'AMBIGUOUS', code, productIds: rows.map((row) => row.id) };
}

/**
 * The message an ambiguous match produces, everywhere.
 *
 * One wording, one place: the wizard, the row-error channel and the tests all
 * read the same sentence, and it names the count rather than the ids because
 * a row error is read by a person deciding what to fix, not by a machine.
 */
export function ambiguousManufacturerCodeMessage(code: string, count: number): string {
  return (
    `Manufacturer code '${code}' matches ${count} products in this company; ` +
    `the row was not applied. Resolve the duplicate codes or match by SKU instead.`
  );
}
