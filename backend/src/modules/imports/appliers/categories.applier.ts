import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ApplyContext, RowApplication, UnitApplier } from '../execution/import-executor';
import { txExecute } from '../execution/tx';
import { PlannedUnit } from '../execution/batch-planner';
import { RowOutcome } from '../entities/import-row-result.entity';
import { slugify } from './products.applier';

/**
 * Categories, and the paths that describe them.
 *
 * A category import is deceptively small and unusually easy to get wrong,
 * because the thing being imported is a TREE flattened into text. "Ropa >
 * Camisetas" is two categories and a relationship, and every mistake here is
 * structural rather than cosmetic:
 *
 *  - creating "Ropa > Camisetas" as a single category with a chevron in its
 *    name is the failure that makes a navigation menu nonsense;
 *  - creating a second "Camisetas" under a different parent, because the
 *    lookup ignored the path, splits a catalogue in half;
 *  - inventing categories from a typo puts a permanent branch in somebody's
 *    menu, which is why creation is opt-in.
 *
 * A path is therefore resolved LEVEL BY LEVEL, each level within its parent, so
 * "Ropa > Camisetas" and "Hogar > Camisetas" stay two different categories.
 */

export interface CategoryMutation {
  sourceRow: number;
  /** Levels of one path, outermost first. Already split and trimmed. */
  path: string[];
  /** Whether a level that does not exist may be created. */
  createMissing: boolean;
  /** Optional per-level detail, applied only to the deepest level. */
  description?: string | null;
}

export interface ResolvedCategory {
  id: string;
  created: boolean;
}

@Injectable()
export class CategoriesApplier implements UnitApplier {
  async apply(unit: PlannedUnit, context: ApplyContext): Promise<RowApplication[]> {
    const mutations = unit.mutations as CategoryMutation[];
    const results: RowApplication[] = [];

    for (const mutation of mutations) {
      if (mutation.path.length === 0) {
        results.push({
          sourceRow: mutation.sourceRow,
          outcome: RowOutcome.SKIPPED,
          reason: 'This row named no category.',
        });
        continue;
      }

      try {
        const resolved = await this.resolvePath(mutation, context);
        if (!resolved) {
          results.push({
            sourceRow: mutation.sourceRow,
            outcome: RowOutcome.UNRESOLVED,
            reason: `The category "${mutation.path.join(' > ')}" does not exist, and this import was not allowed to create categories.`,
          });
          continue;
        }

        if (mutation.description !== undefined && mutation.description !== null) {
          await txExecute(
            context.em,
            // #292: an import never writes to a removed category. `resolvePath`
            // already matches live rows only, so this predicate is the second
            // reader of the same rule rather than the only one.
            `update categories set description = ?, updated_at = now()
              where id = ? and organization_id = ? and removed_at is null`,
            [mutation.description, resolved.id, context.organizationId],
          );
        }

        results.push({
          sourceRow: mutation.sourceRow,
          outcome: resolved.created ? RowOutcome.CREATED : RowOutcome.UPDATED,
          targetType: 'category',
          targetId: resolved.id,
          reason: resolved.created ? null : 'This category already existed.',
        });
      } catch (error) {
        results.push({
          sourceRow: mutation.sourceRow,
          outcome: RowOutcome.FAILED,
          reason: error instanceof Error ? error.message : 'The category could not be created.',
        });
      }
    }

    return results;
  }

  /**
   * Walk a path, resolving each level within the previous one.
   *
   * Matching is by name WITHIN a parent, case-insensitively, because a
   * spreadsheet's casing is not a decision anyone made. Matching globally would
   * merge "Ropa > Camisetas" with "Hogar > Camisetas", which are two different
   * things in every catalogue that has both.
   */
  async resolvePath(mutation: CategoryMutation, context: ApplyContext): Promise<ResolvedCategory | null> {
    // Bound to the batch transaction. This matters twice over here: a category
    // this batch created must be VISIBLE to the next row that names the same
    // path — otherwise every row creates its own duplicate — and it must
    // disappear with the batch if a later row fails.
    const exec = <T>(sql: string, params: unknown[] = []) => txExecute<T>(context.em, sql, params);
    // Annotated because the loop below assigns from a query whose result type
    // TypeScript would otherwise infer from this very variable.
    let parentId: string | null = null;
    let created = false;

    for (const level of mutation.path) {
      const name = level.trim();
      if (name === '') continue;

      const existing: { id: string }[] = await exec<{ id: string }[]>(
        // #292: a removed category is not a level of any live path. Skipping
        // it makes the loop create a fresh one — which the partial slug index
        // permits, because removal releases the slug — instead of resolving to
        // a record the catalogue no longer shows and then being refused by the
        // lifecycle triggers when a product is filed under it.
        `select id from categories
          where organization_id = ?
            and lower(name) = lower(?)
            and parent_category_id is not distinct from ?
            and removed_at is null
          limit 1`,
        [context.organizationId, name, parentId],
      );

      if (Array.isArray(existing) && existing.length === 1) {
        parentId = existing[0].id;
        continue;
      }

      if (!mutation.createMissing) return null;

      const inserted: { id: string }[] = await exec<{ id: string }[]>(
        `insert into categories (organization_id, name, slug, parent_category_id, created_at, updated_at)
         values (?, ?, ?, ?, now(), now()) returning id`,
        [context.organizationId, name, await this.uniqueSlug(context.em, context.organizationId, name), parentId],
      );
      parentId = inserted[0].id;
      created = true;
    }

    return parentId ? { id: parentId, created } : null;
  }

  /** Slugs are unique per organization, and two branches may share a name. */
  private async uniqueSlug(em: EntityManager, organizationId: string, name: string): Promise<string> {
    const base = slugify(name) || 'categoria';
    const rows = await txExecute<{ slug: string }[]>(
      em,
      // #292: exactly what `categories_organization_id_slug_unique` now
      // constrains — live rows only.
      `select slug from categories
        where organization_id = ? and removed_at is null and (slug = ? or slug like ?)`,
      [organizationId, base, `${base}-%`],
    );

    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 10_000; n++) {
      if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
    return `${base}-${Date.now()}`;
  }
}
