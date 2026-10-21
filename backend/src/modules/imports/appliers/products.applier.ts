import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ApplyContext, RowApplication, UnitApplier } from '../execution/import-executor';
import { assertInTransaction, txExecute } from '../execution/tx';
import { PlannedUnit } from '../execution/batch-planner';
import { LockSetWidenedError, PublicationGuardService } from '../../products/publication/publication-guard.service';
import { productFamilyLock } from '../../products/families/advisory-lock.util';
import { conversionBlocker, conversionRefusal } from '../../products/families/card-conversion';
import { RowOutcome } from '../entities/import-row-result.entity';

/**
 * Products and their variants.
 *
 * The rules that shape every write here come from what goes wrong when they are
 * absent, and every one of them has a test:
 *
 *  - **A store the plan did not name is not touched.** Not "left at its
 *    previous value by coincidence" — not written to at all. This is what stops
 *    one shop's prices appearing in another's.
 *  - **Publication is never a side effect.** A product whose row says nothing
 *    about being published keeps whatever it already had, and a NEW product is
 *    created as a draft. The legacy importer's most damaging surprise was a
 *    catalogue going live.
 *  - **Organization-level values are never copied into a store.** A store with
 *    no price of its own continues to have none.
 *  - **A family commits whole.** The parent and its variants are one atomic
 *    unit, because a parent without children is a card that sells nothing.
 *  - **An update writes only the fields the mapping provided.** A column the
 *    person did not map is a column they did not intend to change, and blanking
 *    it would silently erase a description somebody wrote by hand.
 *  - **Stock is never written.** Phase 5 made the inventory ledger the single
 *    owner of what is in stock, leaving `products.stock_quantity` and
 *    `store_products.stock_quantity` as caches with exactly one writer — the
 *    posting mechanism's ledger-derived refresh. An import that set them would
 *    be a second writer, and the number it wrote would immediately disagree
 *    with the ledger that everything else reads. A mapped stock column is
 *    therefore REFUSED with guidance rather than silently dropped.
 */

/** One product as the plan describes it, already normalized and matched. */
export interface ProductMutation {
  sourceRow: number;
  /** Set when matching resolved this row to an existing product. */
  targetId?: string | null;
  matchProvenance?: string | null;
  /** Only the fields the mapping actually provided. Absent means "do not change". */
  fields: {
    name?: string;
    sku?: string | null;
    manufacturerCode?: string | null;
    description?: string | null;
    shortDescription?: string | null;
    price?: number | null;
    salePrice?: number | null;
    cost?: number | null;
    /**
     * Present only so a mapping that asked for it can be refused by name.
     *
     * Silently ignoring it would leave somebody believing their stock had been
     * imported, which is worse than telling them where stock actually comes
     * from.
     */
    stock?: number | null;
    optionLabel?: string | null;
    /** Absent means "leave publication exactly as it is". */
    published?: boolean;
  };
  /** Category ids this product should belong to, already resolved. */
  categoryIds?: string[];
  /** Per-store values, only for stores the plan named. */
  storeValues?: {
    storeId: string;
    price?: number | null;
    published?: boolean;
    /** Refused, exactly as at organization level. See `fields.stock`. */
    stock?: number | null;
    /** Lead time is a per-shop fact: the same product ships faster from one. */
    leadTimeDays?: number | null;
  }[];
  /** Children, present only on the parent of a family. */
  children?: ProductMutation[];
  /**
   * WHAT THE SOURCE FILE CALLS THIS ROW, recorded so a later run can find the
   * record it produced without relying on a SKU the product may not keep.
   *
   * `import_external_identities` has existed since the DesignHof work and is
   * already READ by two places — `buildLookups`, which feeds it to `matchRow`
   * as the highest-confidence match, and the relationships applier's
   * `EXTERNAL_ID` resolver — but nothing has ever written it. Writing it is
   * what lets a family card give up the SKU it should never have carried.
   */
  externalIdentity?: { sourceSystem: string; externalId: string } | null;
}

const SLUG_MAX = 200;

@Injectable()
export class ProductsApplier implements UnitApplier {
  constructor(private readonly publicationGuard: PublicationGuardService) {}

  async apply(unit: PlannedUnit, context: ApplyContext): Promise<RowApplication[]> {
    const mutations = unit.mutations as ProductMutation[];
    const results: RowApplication[] = [];

    for (const mutation of mutations) {
      const refusal = refuseStock(mutation);
      if (refusal) {
        results.push({ sourceRow: mutation.sourceRow, outcome: RowOutcome.BLOCKED, reason: refusal });
        for (const child of mutation.children ?? []) {
          results.push({ sourceRow: child.sourceRow, outcome: RowOutcome.BLOCKED, reason: refusal });
        }
        continue;
      }

      // WHAT THE CARD ROW MAY SAY ABOUT ITSELF.
      //
      // Refused, never normalized. The first design cleared these after the
      // insert; that destroys the identity a repeated import matches by —
      // `matchRow` tries prior source identity, then SKU, then manufacturer
      // code, and its name step deliberately returns UNRESOLVED rather than
      // updating — so a second run of the same file would stall on a human
      // decision. Refusing the row up front creates nothing to clean.
      if ((mutation.children?.length ?? 0) > 0) {
        const refusal = refuseCardFields(mutation);
        if (refusal) {
          results.push({ sourceRow: mutation.sourceRow, outcome: RowOutcome.BLOCKED, reason: refusal });
          for (const child of mutation.children ?? []) {
            results.push({ sourceRow: child.sourceRow, outcome: RowOutcome.BLOCKED, reason: refusal });
          }
          continue;
        }
      }

      // CONVERTING AN EXISTING PRODUCT into a card is allowed only when it is
      // already in the shape a card must have — no ledger history, no supplier
      // line, no durable import identity, no commercial state. Nothing is ever
      // cleared to make room.
      if (mutation.targetId && (mutation.children?.length ?? 0) > 0) {
        const blocker = await conversionBlocker(context.em as EntityManager, context.organizationId, mutation.targetId);
        const alreadyCard =
          (
            await txExecute<{ n: number }[]>(
              context.em,
              `select count(*)::int n from products where parent_id = ?::uuid`,
              [mutation.targetId],
            )
          )[0].n > 0;
        if (!alreadyCard && blocker) {
          const reason = conversionRefusal(mutation.fields.name?.trim() || 'This item', blocker);
          results.push({ sourceRow: mutation.sourceRow, outcome: RowOutcome.BLOCKED, reason });
          for (const child of mutation.children ?? []) {
            results.push({ sourceRow: child.sourceRow, outcome: RowOutcome.BLOCKED, reason });
          }
          continue;
        }
      }

      // AN EXISTING CARD IS NOT RE-STAMPED WITH A SKU.
      //
      // The update SET list writes whatever the mapping provided, so a family
      // row naming its parent by a SKU column would put that SKU back on a card
      // this rule had already taken it off — and the next row to carry it would
      // then collide on the unique index. Same three answers as everywhere
      // else: an unchanged value is a no-op, a card with none simply is not
      // given one (its identity is recorded instead), and a DIFFERENT value is
      // refused rather than silently applied.
      if (mutation.targetId && (mutation.children?.length ?? 0) > 0) {
        const [current] = await txExecute<{ sku: string | null; manufacturer_code: string | null; kids: number }[]>(
          context.em,
          // #292: the target must be live. `products c` needs no predicate —
          // removal detaches a version, so a removed item is nobody's child.
          `select p.sku, p.manufacturer_code,
                  (select count(*)::int from products c where c.parent_id = p.id) as kids
             from products p
            where p.id = ?::uuid and p.organization_id = ? and p.removed_at is null`,
          [mutation.targetId, context.organizationId],
        );
        if (current && current.kids > 0) {
          const settle = (field: 'sku' | 'manufacturerCode', stored: string | null, label: string): string | null => {
            const submitted = mutation.fields[field];
            if (submitted === undefined || submitted === null || String(submitted).trim() === '') return null;
            const next = String(submitted).trim();
            if (stored !== null && next === stored.trim()) {
              delete mutation.fields[field]; // an unchanged legacy value: leave it alone
              return null;
            }
            if (stored === null) {
              delete mutation.fields[field]; // a card is never given one
              return null;
            }
            return (
              `This parent card already has the ${label} "${stored}". A card is never ordered, sold or ` +
              'received, so its identifier is not changed by an import. Nothing has been saved for this row.'
            );
          };
          const refusal =
            settle('sku', current.sku, 'SKU') ??
            settle('manufacturerCode', current.manufacturer_code, 'manufacturer code');
          if (refusal) {
            results.push({ sourceRow: mutation.sourceRow, outcome: RowOutcome.BLOCKED, reason: refusal });
            for (const child of mutation.children ?? []) {
              results.push({ sourceRow: child.sourceRow, outcome: RowOutcome.BLOCKED, reason: refusal });
            }
            continue;
          }
        }
      }

      const parent = await this.applyOne(mutation, context, null);
      results.push(parent.result);
      const touched: string[] = parent.productId ? [parent.productId] : [];

      // NO PARENT, NO CHILDREN. The parent row can fail on its own (a row with
      // no name, for instance), and applying the children anyway attached them
      // to `null` — quietly turning a family into loose standalone products
      // while the unit reported partial success.
      if (!parent.productId) {
        for (const child of mutation.children ?? []) {
          results.push({
            sourceRow: child.sourceRow,
            outcome: RowOutcome.BLOCKED,
            reason: 'Its parent row could not be applied, so this child was not created on its own.',
          });
        }
        continue;
      }

      // Children commit inside the same transaction as their parent. The
      // executor never splits a FAMILY unit, so either the whole card exists or
      // none of it does.
      for (const child of mutation.children ?? []) {
        const applied = await this.applyOne(child, context, parent.productId);
        results.push(applied.result);
        if (applied.productId) touched.push(applied.productId);
      }

      // THE CARD GIVES UP ITS SELLABLE-ITEM IDENTIFIERS, once its own identity
      // is recorded somewhere that survives.
      //
      // A card is never ordered, sold or received, so a SKU on one is an
      // identifier no shop can use and a target an import can hit by mistake —
      // the unique index makes it scarce, too. What the file called the row is
      // recorded in `import_external_identities` instead, which `matchRow`
      // consults first, so the next run of the same file still resolves to this
      // card. An existing card that already carries an identifier keeps it:
      // clearing a long-standing one is a migration, not an import.
      //
      // NARROW ON PURPOSE: only a row that declared a family is treated this
      // way. An ordinary product keeps its SKU, because an ordinary product is
      // exactly what a SKU is for.
      if ((mutation.children?.length ?? 0) > 0) {
        if (mutation.externalIdentity) {
          const conflict = await this.recordExternalIdentity(context, parent.productId, mutation.externalIdentity);
          if (conflict) throw new BadRequestException(conflict);
        }
        // Only a card this unit CREATED. One that already existed keeps what it
        // has: clearing a long-standing identifier is a migration, not an
        // import, and the compatibility exception stands until one is run.
        if (!mutation.targetId) {
          await this.clearCardIdentifiers(context, parent.productId);
        }
      }

      // FINAL STATE, for a row that DECLARED a family: it must end this unit
      // with at least one child. Zero children is a sellable ghost —
      // `isSellableShape`, the public projection and checkout all treat a
      // childless product as an ordinary item, so a card that ended up with
      // none would be silently for sale.
      //
      // A plain product row is not a family and is not asked this. An
      // explicitly declared family may have exactly one child: that shape
      // exists in this catalogue and the storefront renders it (the widget
      // admits `versions.length >= 1`). Two remains the rule for the paths a
      // person drives — manual grouping and the suggestion heuristic.
      if ((mutation.children?.length ?? 0) > 0) {
        const attached = (
          await txExecute<{ n: number }[]>(
            context.em,
            `select count(*)::int n from products where parent_id = ?::uuid`,
            [parent.productId],
          )
        )[0].n;
        if (attached === 0) {
          throw new BadRequestException(
            'A family row produced a parent with no children. Nothing has been saved for this import.',
          );
        }
      }

      // The card's listings are DERIVED from its children's, so they are
      // settled only once every row of this unit has been applied.
      //
      // BOTH shapes matter, and the first correction round covered only the
      // first: a family imported whole (the card is `parent.productId`), and a
      // row that UPDATES an existing child, whose card is a product this unit
      // never mentions. The second is the commoner spreadsheet by far.
      const cards = new Set<string>();
      if (parent.productId && (mutation.children?.length ?? 0) > 0) cards.add(parent.productId);
      for (const card of await this.cardsOf(context, touched)) cards.add(card);
      for (const card of cards) {
        await this.reconcileParentStores(context, card);
      }
    }

    return results;
  }

  /**
   * Record what the source file calls this product — durably, and only ever
   * pointing at one record.
   *
   * FAILS CLOSED on a conflict. The unique key is
   * `(organization, source_system, external_id, target_type)`, so a second row
   * claiming the same identity for a DIFFERENT product is not a race to be
   * resolved by whoever writes last: it means two rows of somebody's file
   * disagree about which record an identifier names, and silently re-aiming the
   * pointer would make every later run update the wrong product. `do nothing`
   * then read back, and refuse when what is stored is not ours.
   */
  private async recordExternalIdentity(
    context: ApplyContext,
    productId: string,
    identity: { sourceSystem: string; externalId: string },
  ): Promise<string | null> {
    const exec = <T>(sql: string, params: unknown[] = []) => txExecute<T>(context.em, sql, params);
    await exec(
      `insert into import_external_identities
         (organization_id, source_system, external_id, target_type, target_id, first_seen_at, last_seen_at)
       values (?, ?, ?, 'product', ?, now(), now())
       on conflict (organization_id, source_system, external_id, target_type) do nothing`,
      [context.organizationId, identity.sourceSystem, identity.externalId, productId],
    );
    const [stored] = await exec<{ target_id: string }[]>(
      `select target_id from import_external_identities
        where organization_id = ? and source_system = ? and external_id = ? and target_type = 'product'`,
      [context.organizationId, identity.sourceSystem, identity.externalId],
    );
    if (!stored) return 'the identity could not be recorded';
    if (stored.target_id !== productId) {
      return (
        `"${identity.externalId}" already identifies a different product in this catalogue. ` +
        'Two rows cannot claim the same identifier; nothing has been saved for this row.'
      );
    }
    // A repeated run refreshes when it was last seen, and nothing else.
    await exec(
      `update import_external_identities set last_seen_at = now()
        where organization_id = ? and source_system = ? and external_id = ? and target_type = 'product'`,
      [context.organizationId, identity.sourceSystem, identity.externalId],
    );
    return null;
  }

  /**
   * A committed card carries no sellable-item identifiers.
   *
   * Its SKU and manufacturer code are cleared at the end of the unit, once the
   * durable identity above has been recorded — never before, and never without
   * it. An EXISTING card that already carries one keeps it: clearing somebody's
   * long-standing identifier is a migration, not an import, and the compatibility
   * exception stands until one is run.
   */
  private async clearCardIdentifiers(context: ApplyContext, cardId: string): Promise<void> {
    await txExecute(
      context.em,
      // #292: an import never writes to a removed item.
      `update products set sku = null, manufacturer_code = null, updated_at = now()
        where id = ?::uuid and organization_id = ? and removed_at is null`,
      [cardId, context.organizationId],
    );
  }

  private async applyOne(
    mutation: ProductMutation,
    context: ApplyContext,
    parentId: string | null,
  ): Promise<{ result: RowApplication; productId: string | null }> {
    // Bound to the batch's transaction, not to a pooled connection. Every
    // statement below has to roll back with the batch if a later row fails.
    const exec = <T>(sql: string, params: unknown[] = []) => txExecute<T>(context.em, sql, params);

    if (mutation.targetId) {
      const updated = await this.update(mutation, context);
      if (!updated) {
        // Matching found it; it has gone since. The pre-execution check catches
        // this for the plan as a whole, but a delete between that check and
        // this row is still possible, and inventing a product here would apply
        // a CREATE nobody approved.
        return {
          productId: null,
          result: {
            sourceRow: mutation.sourceRow,
            outcome: RowOutcome.FAILED,
            reason: 'The product this row would have updated is no longer in the catalogue.',
          },
        };
      }
      await this.applyRelations(mutation, context, updated);
      return {
        productId: updated,
        result: {
          sourceRow: mutation.sourceRow,
          outcome: RowOutcome.UPDATED,
          targetType: 'product',
          targetId: updated,
          matchProvenance: mutation.matchProvenance ?? null,
        },
      };
    }

    const name = mutation.fields.name?.trim();
    if (!name) {
      return {
        productId: null,
        result: {
          sourceRow: mutation.sourceRow,
          outcome: RowOutcome.FAILED,
          reason: 'This row has no name, so no product could be created from it.',
        },
      };
    }

    // A NEW product is a DRAFT unless the mapping said otherwise. Creating
    // hundreds of published products from a spreadsheet is the surprise this
    // avoids.
    const status = mutation.fields.published === true ? 'PUBLISHED' : 'DRAFT';

    const created = await exec<{ id: string }[]>(
      `insert into products
         (organization_id, name, slug, sku, manufacturer_code, description, meta_description,
          status, price, sale_price, cost, option_label, parent_id,
          created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, 0), ?, ?, ?, ?, now(), now())
       returning id`,
      [
        context.organizationId,
        name,
        await this.uniqueSlug(context.em, context.organizationId, name),
        mutation.fields.sku ?? null,
        mutation.fields.manufacturerCode ?? null,
        mutation.fields.description ?? null,
        mutation.fields.shortDescription ?? null,
        status,
        mutation.fields.price ?? null,
        mutation.fields.salePrice ?? null,
        mutation.fields.cost ?? null,
        mutation.fields.optionLabel ?? null,
        parentId,
      ],
    );

    const productId = created[0].id;
    // Nothing outside this transaction can see the row, so nothing outside it
    // can be waiting on a key named after it.
    context.batchLocks?.created.add(productId);
    await this.applyRelations(mutation, context, productId);

    return {
      productId,
      result: {
        sourceRow: mutation.sourceRow,
        outcome: RowOutcome.CREATED,
        targetType: 'product',
        targetId: productId,
        reason: status === 'DRAFT' ? 'Created as a draft. Publish it when you are ready.' : null,
      },
    };
  }

  /**
   * Update only what the mapping provided.
   *
   * The SET list is built from the fields that are PRESENT, so a column the
   * person did not map cannot blank a description somebody wrote by hand. An
   * update with nothing to set still touches `updated_at`, which is honest: the
   * row was considered.
   */
  private async update(mutation: ProductMutation, context: ApplyContext): Promise<string | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    const set = (column: string, value: unknown) => {
      assignments.push(`"${column}" = ?`);
      values.push(value);
    };

    const f = mutation.fields;
    if (f.name !== undefined) set('name', f.name);
    if (f.sku !== undefined) set('sku', f.sku);
    if (f.manufacturerCode !== undefined) set('manufacturer_code', f.manufacturerCode);
    if (f.description !== undefined) set('description', f.description);
    if (f.shortDescription !== undefined) set('meta_description', f.shortDescription);
    if (f.price !== undefined && f.price !== null) set('price', f.price);
    if (f.salePrice !== undefined) set('sale_price', f.salePrice);
    if (f.cost !== undefined) set('cost', f.cost);
    if (f.optionLabel !== undefined) set('option_label', f.optionLabel);
    // Publication changes ONLY when the mapping said so. Absent leaves whatever
    // the product already had.
    if (f.published !== undefined) set('status', f.published ? 'PUBLISHED' : 'DRAFT');

    assignments.push(`"updated_at" = now()`);
    values.push(mutation.targetId, context.organizationId);

    const rows = await txExecute<{ id: string }[]>(
      context.em,
      // #292: a removed item matches nothing here, so the caller takes the
      // `!updated` branch and reports the row FAILED instead of writing to a
      // record the operator has taken out of the catalogue.
      `update products set ${assignments.join(', ')}
        where id = ? and organization_id = ? and removed_at is null returning id`,
      values,
    );

    return Array.isArray(rows) && rows.length === 1 ? rows[0].id : null;
  }

  /**
   * Categories and per-store values.
   *
   * Both are additive and both are explicit. Categories the row names are
   * added; categories it does not name are left alone, because a spreadsheet
   * column rarely lists every category a product is already in and treating it
   * as authoritative would silently un-file things.
   */
  private async applyRelations(mutation: ProductMutation, context: ApplyContext, productId: string): Promise<void> {
    const exec = <T>(sql: string, params: unknown[] = []) => txExecute<T>(context.em, sql, params);

    for (const categoryId of mutation.categoryIds ?? []) {
      await exec(
        // #292: the lifecycle triggers on `product_categories` are the
        // authority for this insert. A SELECT here would only widen the
        // window — the trigger takes `FOR KEY SHARE` on both parents and
        // re-reads them, so it refuses even a writer whose snapshot
        // predates the removal. A refusal (SQLSTATE WGR01) aborts the
        // batch, which is the only honest outcome: every row of an import
        // unit shares one transaction.
        `insert into product_categories (product_id, category_id, organization_id)
         values (?, ?, ?) on conflict do nothing`,
        [productId, categoryId, context.organizationId],
      );
    }

    // ONLY the stores the plan named. A store absent from this list is not
    // written to at all — not set to a default, not given the organization's
    // price. That is what keeps one shop's commercial decisions its own.
    for (const store of mutation.storeValues ?? []) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (store.price !== undefined) {
        assignments.push('"price" = ?');
        values.push(store.price);
      }
      if (store.published !== undefined) {
        assignments.push('"published" = ?');
        values.push(store.published);
      }
      if (store.leadTimeDays !== undefined) {
        assignments.push('"lead_time_days" = ?');
        values.push(store.leadTimeDays);
      }

      // The pivot may not exist yet. It is created with exactly the values
      // given and nothing else — a new pivot is unpublished unless the mapping
      // said otherwise, and carries no price unless one was provided.
      //
      // With no values at all the listing itself is still the point: the plan
      // named this shop, so the product belongs to it. Such a row used to be
      // skipped entirely, which is how an import could report success while
      // listing nothing anywhere. It creates the pivot and, on conflict, does
      // NOTHING — an existing listing's price and publication are somebody's
      // commercial decisions, and an import that states neither must not
      // silently reset them.
      const onConflict = assignments.length
        ? `do update set ${assignments.join(', ')}, "updated_at" = now()`
        : 'do nothing';

      await exec(
        `insert into store_products
           (organization_id, store_id, product_id, published, price, track_inventory, created_at, updated_at)
         values (?, ?, ?, ?, ?, false, now(), now())
         on conflict (store_id, product_id) ${onConflict}`,
        [context.organizationId, store.storeId, productId, store.published ?? false, store.price ?? null, ...values],
      );
    }
  }

  /**
   * The cards whose listings these products could have moved.
   *
   * TWO shapes reach a card, and both are resolved here:
   *
   *   - a touched product that is a CHILD moves its parent's union;
   *   - a touched product that IS a card moves its own, because
   *     `applyRelations` will have written whatever listings the plan named
   *     for it — including a shop that carries none of its children.
   *
   * The second shape is why a row targeting an existing parent directly, with
   * no nested `children`, used to leave an unbacked listing behind.
   *
   * The relationship is read from the DATABASE, inside the batch transaction,
   * never inferred from the plan's shape. A plan is compiled at approval time
   * and the family may have changed since; a product the plan believed was a
   * card may have been dissolved, and one it believed standalone may have
   * acquired children.
   *
   * A childless standalone product matches neither arm and is left alone,
   * which is what keeps the owner's dissolve decision intact: once a former
   * parent has no children its listings are its own.
   */
  private async cardsOf(context: ApplyContext, productIds: string[]): Promise<string[]> {
    if (productIds.length === 0) return [];
    const placeholders = productIds.map(() => '?').join(', ');
    const rows = await txExecute<{ card_id: string }[]>(
      context.em,
      // #292: reconciliation touches live cards only. The `c` subquery needs
      // no predicate: a removed version carries no `parent_id`.
      `select distinct p.parent_id as card_id
         from products p
        where p.id in (${placeholders}) and p.parent_id is not null and p.removed_at is null
        union
       select distinct p.id as card_id
         from products p
        where p.id in (${placeholders}) and p.removed_at is null
          and exists (select 1 from products c where c.parent_id = p.id)`,
      [...productIds, ...productIds],
    );
    return rows.map((row) => row.card_id);
  }

  /**
   * A parent's listings are exactly the union of its children's.
   *
   * There is ONE implementation of that rule, and this is not a second one:
   * it calls `PublicationGuardService.reconcileStoresOfParent`, the same
   * primitive every ORM writer goes through. An earlier revision restated the
   * rule as raw SQL here, which bought nothing and gave up what the guard
   * provides on this path:
   *
   *   - the caller's TRANSACTION, so the card's listings commit and roll back
   *     with the batch;
   *   - the family and store ADVISORY LOCKS, in the one canonical order, with
   *     the union read under them;
   *   - ORGANIZATION-SCOPED store resolution, so a store outside the company
   *     never resolves and the card cannot be listed across a tenant line;
   *   - the RETAINED-PIVOT guarantee — a shop that deliberately hid a card, or
   *     priced it itself, keeps that decision, because a retained pivot is
   *     never written to;
   *   - the EXPOSURE protocol: derive to name the locks, acquire, derive again
   *     to decide, refuse if the second derivation needs a key the first did
   *     not take.
   *
   * Plan-time validation is not a substitute for any of it: store
   * requirements and family shape can both change between approval and
   * execution.
   *
   * REQUIRED FIELDS ARE DELIBERATELY NOT IN THAT LIST. A family card is not
   * sellable, and `isSellableShape` exempts it from required-field
   * completeness by design — demanding a value of a card would refuse
   * publication of something nobody can buy. So this path cannot produce a
   * required-field refusal for the card, and claiming it could would be
   * describing a check that cannot fire. The CHILD's own listing is written by
   * `applyRelations` with raw SQL and does not pass through the guard at all;
   * that is pre-existing importer behaviour, recorded rather than changed
   * here.
   *
   * The guard is an ORM writer, and this applier deliberately is not — it
   * writes rows with SQL so that nothing depends on an entity graph. The two
   * are reconciled by handing the guard a FORK bound to this batch's
   * transaction: `setTransactionContext` puts every statement it issues,
   * advisory locks included, on the transaction's own connection, so its
   * writes commit and roll back with the batch. The fork starts empty, so
   * flushing inside the guard cannot touch pending state belonging to the
   * batch's other appliers, and its reads (`refresh: true` throughout) see the
   * rows this applier has just written with SQL.
   *
   * `assertInTransaction` is the same guard `tx.ts` documents: without a
   * transaction the fork's statements would autocommit, and a rolled-back
   * import would leave the card listed in a shop whose rows were undone.
   */
  private async reconcileParentStores(context: ApplyContext, parentId: string): Promise<void> {
    assertInTransaction(context.em, "Reconciling a card's listings");
    const bound = context.em.fork({ clear: true });
    bound.setTransactionContext(context.em.getTransactionContext());
    const held = await this.keysHeldFor(context, bound, parentId);
    await this.publicationGuard.reconcileStoresOfParent(bound, parentId, context.organizationId, held);
  }

  /**
   * In a prepared batch, the reconciliation may only use keys the batch took
   * before it wrote anything — and is told which those are, so that it
   * acquires none.
   *
   * A CARD THAT APPEARED LATE. The batch named its cards from the rows as they
   * stood at its first statement. A product attached to a card after that is a
   * child of a card the batch does not hold, and reconciling it would take
   * that card's key after this product's rows were written. Refused as a
   * widened key set instead: the batch rolls back and starts again, and this
   * time the card is there to be named.
   *
   * A STORE THE CARD WOULD GAIN that the batch does not hold gets the same
   * answer one namespace down, from the guard: it is handed the keys held and
   * refuses a derivation that needs another.
   *
   * A card this transaction CREATED is the exception. Its row is invisible to
   * everybody else, so its key cannot be waited on by anybody; it is taken
   * here, the first time the card is reconciled, and joins the rest.
   *
   * Outside a prepared batch nothing is held, and the guard takes its own keys
   * as it always did.
   */
  private async keysHeldFor(
    context: ApplyContext,
    bound: EntityManager,
    parentId: string,
  ): Promise<{ ns: number; key: number }[] | undefined> {
    const held = context.batchLocks;
    if (!held) return undefined;
    if (!held.cards.has(parentId)) {
      if (!held.created.has(parentId)) throw new LockSetWidenedError([productFamilyLock(parentId)]);
      const [own] = await this.publicationGuard.acquire(bound, [productFamilyLock(parentId)]);
      held.cards.add(parentId);
      held.keys.push(own);
    }
    return held.keys;
  }

  /**
   * A slug that does not collide.
   *
   * Slugs are unique per organization, so a second "Silla Nordic" needs a
   * suffix. Derived from the name rather than from a counter, so the result is
   * readable and stable for the same input.
   */
  private async uniqueSlug(em: EntityManager, organizationId: string, name: string): Promise<string> {
    const base = slugify(name) || 'producto';
    // Reads through the batch transaction too: a slug taken by a product
    // created earlier in this same batch is not visible on a pooled connection,
    // and the insert would then collide.
    const rows = await txExecute<{ slug: string }[]>(
      em,
      // #292: the taken set is exactly what the partial unique index
      // constrains — `(organization_id, slug) where removed_at is null`. A
      // removed item's slug is free, and asking otherwise would make the
      // importer invent suffixes for names nothing is holding.
      `select slug from products
        where organization_id = ? and removed_at is null and (slug = ? or slug like ?)`,
      [organizationId, base, `${base}-%`],
    );

    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 10_000; n++) {
      const candidate = `${base}-${n}`.slice(0, SLUG_MAX);
      if (!taken.has(candidate)) return candidate;
    }
    // Ten thousand products with one name is not a case worth a cleverer
    // answer; a unique suffix ends the loop honestly.
    return `${base}-${Date.now()}`.slice(0, SLUG_MAX);
  }
}

/**
 * Why a mapping that provides stock is refused.
 *
 * The inventory ledger owns what is in stock (Phase 5). The columns an import
 * would write are caches with exactly one writer — the posting mechanism's
 * ledger-derived refresh — and a second writer would put a number there that
 * disagrees with the ledger everything else reads.
 *
 * A sentence rather than a throw, so the row is BLOCKED with an explanation and
 * the rest of the batch survives.
 */
export function refuseStock(mutation: ProductMutation): string | null {
  const wantsStock =
    mutation.fields.stock !== undefined ||
    (mutation.storeValues ?? []).some((s) => s.stock !== undefined) ||
    (mutation.children ?? []).some((c) => refuseStock(c) !== null);

  if (!wantsStock) return null;
  return STOCK_COMES_FROM_INVENTORY;
}

/**
 * What a FAMILY row may not say about its own card.
 *
 * Refused, never normalized away: a card that briefly held a value and then
 * lost it is a card the next run can no longer reason about, and clearing
 * fields after an insert is how an import quietly rewrites somebody's data.
 *
 * A SKU ON THE CARD ROW IS ACCEPTED AND THEN GIVEN UP. It is not refused,
 * because a family CSV legitimately names its parent through the SKU column
 * (`acceptance-matrix.pg.spec.ts`, "imports a parent with several children as
 * one atomic unit") — but it does not survive the commit. What the file called
 * the row is recorded in `import_external_identities` instead, and `matchRow`
 * consults that first, so the next run of the same file finds the same card
 * without the card holding an identifier no shop can use.
 *
 * The manual path accepts no SKU at all: `POST /products/families` has no file
 * to re-run and nothing to record.
 *
 * `price` is absent on purpose too — a card carries one, as the sorting figure
 * that places the family in listings and price filters. It is never charged.
 */
export function refuseCardFields(mutation: ProductMutation): string | null {
  const f = mutation.fields;
  const named: string[] = [];
  if (f.salePrice !== undefined && f.salePrice !== null) named.push('a sale price');
  if (f.cost !== undefined && f.cost !== null) named.push('a cost');
  const storeOverride = (mutation.storeValues ?? []).some((s) => s.price !== undefined || s.leadTimeDays !== undefined);
  if (storeOverride) named.push('a shop price or lead time');
  if (named.length === 0) return null;
  return (
    `A parent card cannot carry ${named.join(', ')}. A card is never sold, so nothing is ever charged for it — ` +
    'those belong on its child rows. Remove those columns from the parent row and import again.'
  );
}

export const STOCK_COMES_FROM_INVENTORY =
  'Stock cannot be set by a product import. Your stock comes from your inventory records, so a number imported here would immediately disagree with them. Remove the stock column from the mapping, then set opening balances from Inventory.';

export function slugify(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}
