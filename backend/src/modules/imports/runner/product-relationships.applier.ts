import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ApplyContext } from '../execution/import-executor';
import { txExecute } from '../execution/tx';
import { CategoriesApplier } from '../appliers/categories.applier';

/**
 * Everything a product row says BESIDES the product itself.
 *
 * Its categories, its specifications, its photographs and datasheets, the
 * products it relates to, and its text in other languages. Each of these is a
 * different authority with its own rules, and every one of them is written
 * inside the product's own transaction — a product that exists without the
 * specification the row gave it is a half-imported row, and the report would
 * call it a success.
 *
 * The shared principle is that everything here is ADDITIVE and EXPLICIT. A
 * spreadsheet column rarely lists every category a product is already in, so
 * treating it as authoritative would silently un-file things; a row that
 * mentions no documents is a row that says nothing about documents, not a row
 * that says there are none. Removal is a deliberate act somebody performs in
 * the catalogue, never a side effect of an import.
 *
 * What it refuses matters as much as what it writes:
 *
 *  - a specification whose value does not fit its definition's TYPE, or whose
 *    unit disagrees, is refused rather than coerced. "1,5 kg" into a number
 *    field that measures grams is not a rounding problem;
 *  - a related product that resolves to two candidates resolves to NEITHER,
 *    because picking one silently links the wrong thing;
 *  - a locale the organization does not use is refused at plan time, so
 *    nothing here has to guess.
 */

/** One row's non-product claims, already parsed by the compiler. */
export interface RowRelationships {
  /** Category paths, outermost level first. */
  categoryPaths?: string[][];
  createMissingCategories?: boolean;
  specifications?: {
    definitionKey: string;
    expectedType: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT' | 'DATE' | 'URL';
    unit?: string;
    value: string;
  }[];
  assets?: {
    url: string;
    target: 'GALLERY_IMAGE';
  }[];
  relations?: {
    type: 'RELATED' | 'ACCESSORY' | 'SIMILAR' | 'REPLACEMENT';
    matchBy: 'SKU' | 'MANUFACTURER_CODE' | 'EXTERNAL_ID';
    values: string[];
  }[];
  translations?: {
    locale: string;
    field: 'name' | 'description' | 'metaTitle' | 'metaDescription';
    value: string;
  }[];
}
/** What could not be attached, in the person's words. One line per problem. */
export type RelationshipNotes = string[];

/**
 * What actually happened to this row's categories.
 *
 * Carried out of the applier because only IT can know. `resolvePath` is the one
 * place that can tell a path it created from a path that already existed, and
 * that distinction is the difference between "we filed this product" and "we
 * added a branch to somebody's catalogue". Reporting the association alone
 * would answer the smaller question under the bigger question's name.
 *
 * Every list holds PATHS as a person wrote them, not identifiers.
 */
export interface CategoryProvenance {
  /** Paths this import created, because they did not exist. */
  created: string[];
  /** Paths that already existed and were reused. */
  reused: string[];
  /** Paths linked to the product by this row, whether created or reused. */
  associated: string[];
  /** Paths that could not be applied — absent, and creation not permitted. */
  blocked: string[];
}

export interface RelationshipOutcome {
  notes: RelationshipNotes;
  categories: CategoryProvenance;
}

@Injectable()
export class ProductRelationshipsApplier {
  constructor(private readonly categories: CategoriesApplier) {}

  async apply(
    productId: string,
    sourceRow: number,
    relationships: RowRelationships,
    context: ApplyContext,
  ): Promise<RelationshipOutcome> {
    const notes: RelationshipNotes = [];
    const categories: CategoryProvenance = { created: [], reused: [], associated: [], blocked: [] };

    await this.applyCategories(productId, sourceRow, relationships, context, notes, categories);
    await this.applySpecifications(productId, relationships, context, notes);
    await this.applyAssets(productId, relationships, context, notes);
    await this.applyRelations(productId, relationships, context, notes);
    await this.applyTranslations(productId, relationships, context, notes);

    return { notes, categories };
  }

  private async applyCategories(
    productId: string,
    sourceRow: number,
    relationships: RowRelationships,
    context: ApplyContext,
    notes: RelationshipNotes,
    provenance: CategoryProvenance,
  ): Promise<void> {
    for (const path of relationships.categoryPaths ?? []) {
      const label = path.join(' > ');
      const resolved = await this.categories.resolvePath(
        { sourceRow, path, createMissing: relationships.createMissingCategories ?? false },
        context,
      );
      if (!resolved) {
        // Not an error. Creating categories is opt-in precisely because a typo
        // in one row would otherwise become a permanent branch of somebody's
        // menu, and saying so is more useful than inventing it.
        provenance.blocked.push(label);
        notes.push(`The category "${label}" does not exist, so it was not applied.`);
        continue;
      }

      // `resolved.created` is the only honest source for this. It is set by the
      // resolver at the moment it inserted the category, and nothing later can
      // reconstruct whether the path was already there.
      (resolved.created ? provenance.created : provenance.reused).push(label);
      provenance.associated.push(label);

      await txExecute(
        context.em,
        // #292: the lifecycle triggers on `product_categories` are the
        // authority for this insert. A SELECT here would only widen the
        // window — the trigger takes `FOR KEY SHARE` on both parents and
        // re-reads them, so it refuses even a writer whose snapshot
        // predates the removal. A refusal (SQLSTATE WGR01) aborts the
        // batch, which is the only honest outcome: every row of an import
        // unit shares one transaction.
        `insert into product_categories (product_id, category_id, organization_id)
           values (?, ?, ?) on conflict do nothing`,
        [productId, resolved.id, context.organizationId],
      );
    }
  }

  private async applySpecifications(
    productId: string,
    relationships: RowRelationships,
    context: ApplyContext,
    notes: RelationshipNotes,
  ): Promise<void> {
    for (const specification of relationships.specifications ?? []) {
      const definition = (
        await txExecute<{ id: string; type: string; unit: string | null; options: string[] | null }[]>(
          context.em,
          `select id, type, unit, options from product_field_definitions
            where organization_id = ? and key = ? and archived_at is null`,
          [context.organizationId, specification.definitionKey],
        )
      )[0];

      if (!definition) {
        notes.push(`The specification "${specification.definitionKey}" is not set up, so it was not filled in.`);
        continue;
      }
      if (definition.type !== specification.expectedType) {
        // The mapping stated a type. A definition of a different type is not
        // something to coerce into — it is a mapping built against a catalogue
        // that has since changed.
        notes.push(
          `"${specification.definitionKey}" now holds ${describeType(definition.type)}, not ${describeType(specification.expectedType)}, so it was not filled in.`,
        );
        continue;
      }
      if (specification.expectedType === 'NUMBER' && (definition.unit ?? null) !== (specification.unit ?? null)) {
        // A number without its unit is not a number. Writing 1.5 into a field
        // that measures grams when the file meant kilograms is a thousandfold
        // error that looks perfectly reasonable on screen.
        notes.push(
          `"${specification.definitionKey}" is measured in ${definition.unit ?? 'no unit'}, but this file gives ${specification.unit ?? 'no unit'}, so it was not filled in.`,
        );
        continue;
      }

      const columns = this.valueColumns(specification.expectedType, specification.value, definition.options);
      if (!columns) {
        notes.push(
          `"${specification.value}" is not a valid ${describeType(specification.expectedType)}, so it was not filled in.`,
        );
        continue;
      }

      await txExecute(
        context.em,
        `insert into product_field_values
           (id, organization_id, product_id, definition_id, definition_type,
            value_text, value_number, value_boolean, value_date, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?, ?, ?, ?, ?, ?, now(), now())
         on conflict (product_id, definition_id) do update
           set value_text = excluded.value_text,
               value_number = excluded.value_number,
               value_boolean = excluded.value_boolean,
               value_date = excluded.value_date,
               updated_at = now()`,
        [
          context.organizationId,
          productId,
          definition.id,
          specification.expectedType,
          columns.text,
          columns.number,
          columns.boolean,
          columns.date,
        ],
      );
    }
  }

  /**
   * Which column a value belongs in, and whether it belongs there at all.
   *
   * `null` means the value cannot be stored as the stated type — the caller
   * turns that into a sentence rather than writing something approximate.
   */
  private valueColumns(
    type: RowRelationships['specifications'] extends (infer S)[] | undefined
      ? S extends { expectedType: infer T }
        ? T
        : never
      : never,
    raw: string,
    options: string[] | null,
  ): { text: string | null; number: string | null; boolean: boolean | null; date: string | null } | null {
    const empty = { text: null, number: null, boolean: null, date: null };
    const value = raw.trim();
    if (value === '') return null;

    switch (type) {
      case 'NUMBER': {
        const parsed = Number(value.replace(',', '.'));
        return Number.isFinite(parsed) ? { ...empty, number: String(parsed) } : null;
      }
      case 'BOOLEAN': {
        const yes = ['true', 'yes', 'si', 'sí', '1'];
        const no = ['false', 'no', '0'];
        const lower = value.toLowerCase();
        if (yes.includes(lower)) return { ...empty, boolean: true };
        if (no.includes(lower)) return { ...empty, boolean: false };
        return null;
      }
      case 'DATE': {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : { ...empty, date: parsed.toISOString().slice(0, 10) };
      }
      case 'SELECT':
        // A value outside the list is refused rather than added. The list is
        // the point of a SELECT; widening it from a spreadsheet would make it
        // whatever the last import happened to contain.
        return (options ?? []).includes(value) ? { ...empty, text: value } : null;
      case 'URL':
        return /^https?:\/\//i.test(value) ? { ...empty, text: value } : null;
      default:
        return { ...empty, text: value };
    }
  }

  private async applyAssets(
    productId: string,
    relationships: RowRelationships,
    context: ApplyContext,
    notes: RelationshipNotes,
  ): Promise<void> {
    for (const asset of relationships.assets ?? []) {
      if (!/^https?:\/\//i.test(asset.url)) {
        notes.push(`"${asset.url}" is not a web address, so it was not attached.`);
        continue;
      }

      await this.attachImage(context.em, productId, asset.url);
    }
  }

  /**
   * Add a photograph to the end of the gallery.
   *
   * NEVER as the primary image, and never reordering what is there. Phase 3
   * left the primary image where it was on purpose, and an import that
   * rearranged somebody's photographs as a side effect of adding one would be
   * changing something nobody asked it to change.
   */
  private async attachImage(em: EntityManager, productId: string, url: string): Promise<void> {
    const exec = <T>(sql: string, params: unknown[] = []) => txExecute<T>(em, sql, params);

    const already = await exec<{ id: string }[]>(
      `select id from product_images where product_id = ? and url = ? limit 1`,
      [productId, url],
    );
    if (Array.isArray(already) && already.length > 0) return;

    const last = (
      await exec<{ next: number }[]>(
        `select coalesce(max(sort_order), -1) + 1 as next from product_images where product_id = ?`,
        [productId],
      )
    )[0].next;

    await exec(
      `insert into product_images (id, product_id, url, is_primary, sort_order, created_at)
       values (gen_random_uuid(), ?, ?, false, ?, now())`,
      [productId, url, last],
    );
  }

  private async applyRelations(
    productId: string,
    relationships: RowRelationships,
    context: ApplyContext,
    notes: RelationshipNotes,
  ): Promise<void> {
    for (const rule of relationships.relations ?? []) {
      for (const value of rule.values) {
        const candidates = await this.findByIdentifier(context.em, rule.matchBy, value, context.organizationId);

        if (candidates.length === 0) {
          notes.push(`No product matches "${value}", so that link was not made.`);
          continue;
        }
        if (candidates.length > 1) {
          // Two candidates resolve to NEITHER. Linking the wrong product is
          // worse than linking none, and only a person can say which.
          notes.push(`"${value}" matches ${candidates.length} products, so that link was not made.`);
          continue;
        }
        if (candidates[0] === productId) {
          notes.push(`A product cannot be linked to itself, so "${value}" was skipped.`);
          continue;
        }

        await txExecute(
          context.em,
          `insert into product_relations (id, organization_id, source_product_id, target_product_id, type, created_at)
           values (gen_random_uuid(), ?, ?, ?, ?, now())
           on conflict (source_product_id, target_product_id, type) do nothing`,
          [context.organizationId, productId, candidates[0], rule.type],
        );
      }
    }
  }

  private async findByIdentifier(
    em: EntityManager,
    matchBy: 'SKU' | 'MANUFACTURER_CODE' | 'EXTERNAL_ID',
    value: string,
    organizationId: string,
  ): Promise<string[]> {
    if (matchBy === 'EXTERNAL_ID') {
      const rows = await txExecute<{ target_id: string }[]>(
        em,
        // #292: a recorded external identity may name an item that has since
        // been removed; the join drops it, exactly as the SKU and code
        // matchers below do.
        `select i.target_id from import_external_identities i
           join products p on p.id = i.target_id and p.removed_at is null
          where i.organization_id = ? and i.external_id = ? and i.target_type = 'product'`,
        [organizationId, value],
      );
      return rows.map((r) => r.target_id);
    }

    const column = matchBy === 'SKU' ? 'sku' : 'manufacturer_code';
    // SKU is exact and case-sensitive; a manufacturer code is not, because the
    // same code arrives cased differently from every supplier.
    const predicate = matchBy === 'SKU' ? `${column} = ?` : `upper(${column}) = upper(?)`;
    const rows = await txExecute<{ id: string }[]>(
      em,
      // #292: an import row never matches a removed item. Its SKU and
      // manufacturer code are released the moment it is removed (the unique
      // indexes are partial), so matching one would resolve to a record the
      // catalogue no longer shows.
      `select id from products where organization_id = ? and removed_at is null and ${predicate}`,
      [organizationId, value],
    );
    return rows.map((r) => r.id);
  }

  private async applyTranslations(
    productId: string,
    relationships: RowRelationships,
    context: ApplyContext,
    notes: RelationshipNotes,
  ): Promise<void> {
    // Grouped by locale, because one row is one translation per language and
    // the table holds one row per (product, locale). Writing them one field at
    // a time would have each overwrite the last.
    const byLocale = new Map<string, Record<string, string>>();
    for (const translation of relationships.translations ?? []) {
      const fields = byLocale.get(translation.locale) ?? {};
      fields[translation.field] = translation.value;
      byLocale.set(translation.locale, fields);
    }

    for (const [locale, fields] of byLocale) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const [field, value] of Object.entries(fields)) {
        const column = TRANSLATION_COLUMNS[field];
        if (!column) {
          notes.push(`"${field}" cannot be translated, so it was skipped.`);
          continue;
        }
        assignments.push(`"${column}" = ?`);
        values.push(value);
      }
      if (assignments.length === 0) continue;

      await txExecute(
        context.em,
        `insert into product_translations
           (id, organization_id, product_id, locale, name, description, meta_title, meta_description, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?, ?, ?, ?, ?, now(), now())
         on conflict (product_id, locale) do update set ${assignments.join(', ')}, "updated_at" = now()`,
        [
          context.organizationId,
          productId,
          locale,
          fields.name ?? null,
          fields.description ?? null,
          fields.metaTitle ?? null,
          fields.metaDescription ?? null,
          ...values,
        ],
      );
    }
  }
}

const TRANSLATION_COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  metaTitle: 'meta_title',
  metaDescription: 'meta_description',
};

/** Types in the words the person chose them by, not the database's. */
function describeType(type: string): string {
  switch (type) {
    case 'NUMBER':
      return 'a number';
    case 'BOOLEAN':
      return 'a yes or no';
    case 'DATE':
      return 'a date';
    case 'SELECT':
      return 'one of a fixed list';
    case 'URL':
      return 'a web address';
    default:
      return 'text';
  }
}
