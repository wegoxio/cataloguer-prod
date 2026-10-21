import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Product } from '../products/entities/product.entity';
import { Category } from '../categories/entities/category.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { ProductTranslation } from './entities/product-translation.entity';
import { CategoryTranslation } from './entities/category-translation.entity';
import { TenantScope, hasOrganizationWideAuthority, scopeAllowsStore } from '../auth/tenancy/tenant-scope';
import { UpsertTranslationDto } from './dto/translation.dto';
import { LOCALIZED_TEXT_FIELDS, LocaleVariant, normalizeLocale } from './shared/locale.util';

const notFound = (what: string) => new NotFoundException(`${what} not found`);

export type TranslatableKind = 'product' | 'category';

/**
 * Reading and writing catalogue translations (P5-W2).
 *
 * TENANCY IS NEVER INFERRED. Every read and every write carries the resolved
 * scope's company as a query predicate, and the item is re-resolved inside
 * that company before its translations are touched — an id alone is never
 * enough, exactly as it is not enough for relations, documents or field
 * values. The composite foreign key repeats the same rule at the database, so
 * neither layer is the only wall.
 *
 * AUTHORITY follows ADR 014 and the surfaces this most resembles. Catalogue
 * copy belongs to the whole company — every branch shows the same product — so
 * WRITING a translation needs company-wide authority; a narrowed actor is
 * acting as one branch and cannot rewrite what its siblings publish. READING
 * is open to a branch-bound actor for items its own branch carries.
 *
 * THE CANONICAL LOCALE IS NOT A TRANSLATION. Writing a translation for the
 * organization's own `default_content_locale` is refused, because the base
 * columns already are that copy and a second one would make "which Spanish is
 * the real Spanish" a live question. Editing the canonical copy is editing the
 * product.
 */
@Injectable()
export class TranslationsService {
  constructor(private readonly em: EntityManager) {}

  private organizationOf(scope: TenantScope | undefined): string {
    const organizationId = scope?.organizationId ?? null;
    if (!organizationId) {
      throw new BadRequestException(
        'Organization context required: choose a company before managing its catalogue translations',
      );
    }
    return organizationId;
  }

  private assertOrgWide(scope: TenantScope | undefined): void {
    if (!hasOrganizationWideAuthority(scope)) {
      throw new BadRequestException(
        'Catalogue copy belongs to the whole company, so translations can only be changed with company-wide access.',
      );
    }
  }

  /** The organization's canonical content locale, normalized. */
  async canonicalLocaleOf(organizationId: string): Promise<string> {
    const organization = await this.em.findOne(Organization, { id: organizationId });
    if (!organization) throw notFound('Organization');
    return normalizeLocale(organization.defaultContentLocale) ?? 'es';
  }

  /**
   * Resolves the item inside the caller's company, with the same branch
   * visibility rule the relation and document surfaces use.
   */
  private async resolveOwner(
    scope: TenantScope | undefined,
    kind: TranslatableKind,
    ownerId: string,
  ): Promise<{ organizationId: string; ownerId: string }> {
    const organization = this.organizationOf(scope);

    if (kind === 'product') {
      const product = await this.em.findOne(Product, { id: ownerId, organization });
      if (!product) throw notFound('Product');
      if (!hasOrganizationWideAuthority(scope)) {
        const storeId = scope?.storeId ?? null;
        if (!storeId || !scopeAllowsStore(scope, storeId)) throw notFound('Product');
        const visible = await this.em.count(Product, { id: ownerId, organization, stores: storeId });
        if (visible === 0) throw notFound('Product');
      }
      return { organizationId: organization, ownerId: product.id };
    }

    // A category belongs to the COMPANY and every branch shares it (Phase 4),
    // so there is no branch narrowing to apply here — only the company.
    const category = await this.em.findOne(Category, { id: ownerId, organization });
    if (!category) throw notFound('Category');
    return { organizationId: organization, ownerId: category.id };
  }

  private entityFor(kind: TranslatableKind) {
    return kind === 'product' ? ProductTranslation : CategoryTranslation;
  }

  private ownerFieldFor(kind: TranslatableKind): 'product' | 'category' {
    return kind === 'product' ? 'product' : 'category';
  }

  /** Every stored translation of one item, ordered by locale. */
  async list(scope: TenantScope | undefined, kind: TranslatableKind, ownerId: string) {
    const { organizationId, ownerId: resolved } = await this.resolveOwner(scope, kind, ownerId);
    const rows = await this.em.find(
      this.entityFor(kind) as never,
      { organization: organizationId, [this.ownerFieldFor(kind)]: resolved } as never,
      { orderBy: { locale: 'ASC' } as never },
    );
    return {
      canonicalLocale: await this.canonicalLocaleOf(organizationId),
      translations: (rows as unknown as LocaleVariant[]).map((row) => ({
        locale: row.locale,
        name: row.name ?? null,
        description: row.description ?? null,
        metaTitle: row.metaTitle ?? null,
        metaDescription: row.metaDescription ?? null,
      })),
    };
  }

  /**
   * Creates or updates ONE locale's copy.
   *
   * Omitted fields keep their stored value; a field sent as an empty string is
   * cleared. When nothing is left, the row is deleted rather than kept as an
   * empty shell — the database refuses an all-null translation, and an empty
   * row would otherwise advertise a translation that does not exist.
   */
  async upsert(
    scope: TenantScope | undefined,
    kind: TranslatableKind,
    ownerId: string,
    rawLocale: string,
    dto: UpsertTranslationDto,
  ) {
    this.assertOrgWide(scope);
    const { organizationId, ownerId: resolved } = await this.resolveOwner(scope, kind, ownerId);

    const locale = normalizeLocale(rawLocale);
    if (locale === null) {
      throw new BadRequestException(
        `'${rawLocale}' is not a language tag. Use a form like 'en', 'pt-BR' or 'zh-Hant-TW'.`,
      );
    }
    const canonical = await this.canonicalLocaleOf(organizationId);
    if (locale === canonical) {
      throw new BadRequestException(
        `'${locale}' is this company's canonical content language: edit the item itself rather than storing a translation of it.`,
      );
    }

    const entity = this.entityFor(kind);
    const ownerField = this.ownerFieldFor(kind);
    const where = { organization: organizationId, [ownerField]: resolved, locale } as never;

    return this.em.transactional(async (tem) => {
      const existing = (await tem.findOne(entity as never, where)) as Record<string, unknown> | null;

      const next: Record<string, string | null> = {};
      for (const field of LOCALIZED_TEXT_FIELDS) {
        const sent = (dto as Record<string, unknown>)[field];
        if (sent === undefined) {
          next[field] = (existing?.[field] as string | null | undefined) ?? null;
          continue;
        }
        const trimmed = String(sent).trim();
        next[field] = trimmed === '' ? null : trimmed;
      }

      const empty = LOCALIZED_TEXT_FIELDS.every((field) => next[field] === null);
      if (empty) {
        if (existing) await tem.nativeDelete(entity as never, where);
        return { locale, deleted: true, name: null, description: null, metaTitle: null, metaDescription: null };
      }

      if (existing) {
        Object.assign(existing, next);
        await tem.flush();
      } else {
        const created = tem.create(
          entity as never,
          {
            organization: tem.getReference(Organization, organizationId),
            [ownerField]:
              kind === 'product' ? tem.getReference(Product, resolved) : tem.getReference(Category, resolved),
            locale,
            ...next,
          } as never,
        );
        tem.persist(created);
        await tem.flush();
      }
      return { locale, deleted: false, ...next };
    });
  }

  /** Removes one locale's copy. Absent is not an error — the end state matches. */
  async remove(scope: TenantScope | undefined, kind: TranslatableKind, ownerId: string, rawLocale: string) {
    this.assertOrgWide(scope);
    const { organizationId, ownerId: resolved } = await this.resolveOwner(scope, kind, ownerId);
    const locale = normalizeLocale(rawLocale);
    if (locale === null) throw new BadRequestException(`'${rawLocale}' is not a language tag.`);
    const removed = await this.em.nativeDelete(
      this.entityFor(kind) as never,
      {
        organization: organizationId,
        [this.ownerFieldFor(kind)]: resolved,
        locale,
      } as never,
    );
    return { locale, removed };
  }
}
