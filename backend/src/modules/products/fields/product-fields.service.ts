import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { LockMode } from '@mikro-orm/core';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import {
  FieldApplicability,
  ProductFieldDefinition,
  ProductFieldType,
} from '../entities/product-field-definition.entity';
import { StoreFieldSetting } from '../entities/store-field-setting.entity';
import { ProductFieldValue } from '../entities/product-field-value.entity';
import { Product } from '../entities/product.entity';
import { Store } from '../../stores/entities/store.entity';
import { TenantScope, hasOrganizationWideAuthority, scopeAllowsStore } from '../../auth/tenancy/tenant-scope';
import {
  canonicalizeDate,
  canonicalizeDecimal,
  canonicalizeUrl,
  normalizeFieldKey,
  readFieldValue,
} from './product-field.util';
import { allowedUnitsFor, compareDecimal, curatedFieldByKey, isWholeDecimal } from './curated-field-registry';
import { PublicationGuardService } from '../publication/publication-guard.service';
import {
  CreateProductFieldDto,
  UpdateProductFieldDto,
  UpsertProductFieldValueDto,
  UpsertStoreFieldSettingDto,
} from '../dto/product-field.dto';

/**
 * Where a product stands in its family — the fact applicability rules on.
 * A standalone product (neither side) satisfies every applicability: it is
 * its own family.
 */
export interface FamilyPosition {
  hasParent: boolean;
  hasChildren: boolean;
}

/** How one effective value was resolved. */
export type EffectiveValueSource = 'DIRECT' | 'INHERITED';

/** Same shape for a foreign tenant and a missing row: neither confirms the other. */
const notFound = (what: string) => new NotFoundException(`${what} not found`);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Import field mappings the commit-level validation has ACCEPTED (B4a3).
 *
 * The constructor is private and the ONE factory below performs the whole
 * validation, so an instance is unforgeable proof that it ran: every
 * definition id was a well-formed identifier of THIS organization's live
 * vocabulary, adopted as `active && importable` by the resolved target store,
 * each mapping claimed its own column, and no column a canonical mapping
 * already uses. The per-row writer can therefore skip re-resolving without
 * weakening `writeCreationValues`, whose public checks stay exactly as they
 * are.
 */
export class VerifiedImportFieldMappings {
  private constructor(readonly entries: ReadonlyArray<{ definition: ProductFieldDefinition; columnIndex: number }>) {}

  static empty(): VerifiedImportFieldMappings {
    return new VerifiedImportFieldMappings([]);
  }

  static async resolve(input: {
    em: EntityManager;
    organizationId: string;
    /** From the canonical TenantScope ONLY — never actor or request identity. */
    storeId: string | null;
    accepted: Record<string, number>;
    /** Columns the canonical product mapping already claims. */
    canonicalColumns: ReadonlySet<number>;
    /**
     * The widest submitted row. Preview shapes every row to the header
     * width, so a column at or past this bound exists in NO row — accepting
     * it would silently read an empty cell for the whole import.
     */
    importWidth: number;
  }): Promise<VerifiedImportFieldMappings> {
    const entries = Object.entries(input.accepted ?? {});
    if (entries.length === 0) return VerifiedImportFieldMappings.empty();
    // Without a resolved branch there is no adoption to check against, and
    // organization-wide definitions must not be accepted silently.
    if (!input.storeId) {
      throw new BadRequestException(
        'Field mappings need a branch context — imports write values for the branch that adopted the fields',
      );
    }

    const seenColumns = new Set<number>();
    for (const [definitionId, columnIndex] of entries) {
      if (!UUID_PATTERN.test(definitionId)) {
        throw new BadRequestException('Field mappings must reference definitions by id');
      }
      if (!Number.isInteger(columnIndex) || columnIndex < 0) {
        throw new BadRequestException('Field mappings must name a column by non-negative index');
      }
      if (columnIndex >= input.importWidth) {
        throw new BadRequestException('Field mappings must name a column inside the imported width');
      }
      if (seenColumns.has(columnIndex)) {
        throw new BadRequestException('Two field mappings cannot claim the same column');
      }
      seenColumns.add(columnIndex);
      if (input.canonicalColumns.has(columnIndex)) {
        throw new BadRequestException('A field mapping cannot claim a column the canonical mapping already uses');
      }
    }

    const ids = entries.map(([definitionId]) => definitionId);
    const definitions = await input.em.find(ProductFieldDefinition, {
      id: { $in: ids },
      organization: input.organizationId,
    });
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    for (const id of ids) {
      const definition = byId.get(id);
      // Foreign and missing look identical; archived-in-organization keeps
      // its established 400, because the caller may restore it.
      if (!definition) throw notFound('Field');
      if (definition.archivedAt) {
        throw new BadRequestException('This field is archived and no longer accepts values');
      }
    }

    const settings = await input.em.find(StoreFieldSetting, {
      store: input.storeId,
      definition: { $in: ids },
      active: true,
      importable: true,
    });
    const adopted = new Set(
      settings.map((setting) => (typeof setting.definition === 'string' ? setting.definition : setting.definition?.id)),
    );
    for (const id of ids) {
      // Not adopted for import by THIS branch — indistinguishable from a
      // field that does not exist, so sibling adoption leaks nothing.
      if (!adopted.has(id)) throw notFound('Field');
    }

    return new VerifiedImportFieldMappings(
      entries.map(([definitionId, columnIndex]) => ({ definition: byId.get(definitionId)!, columnIndex })),
    );
  }
}

@Injectable()
export class ProductFieldsService {
  constructor(
    @InjectRepository(ProductFieldDefinition)
    private readonly definitionRepository: EntityRepository<ProductFieldDefinition>,
    private readonly em: EntityManager,
    private readonly publicationGuard: PublicationGuardService,
  ) {}

  /**
   * The company whose vocabulary this request is about.
   *
   * An unscoped platform owner has no company in context, so "this
   * organization's fields" identifies nothing. That is a malformed request —
   * 400, not the 404 used for resources belonging to somebody else.
   */
  private organizationOf(scope: TenantScope | undefined): string {
    const organizationId = scope?.organizationId ?? null;
    if (!organizationId) {
      throw new BadRequestException('Organization context required: choose a company before managing its fields');
    }
    return organizationId;
  }

  // ---------------------------------------------------------------- definitions

  async listDefinitions(scope: TenantScope | undefined, includeArchived = false) {
    const organization = this.organizationOf(scope);
    const where: any = { organization };
    if (!includeArchived) where.archivedAt = null;
    const rows = await this.definitionRepository.find(where, { orderBy: { sortOrder: 'ASC', key: 'ASC' } });
    return rows.map((d) => this.toDefinitionDto(d));
  }

  async createDefinition(scope: TenantScope | undefined, dto: CreateProductFieldDto) {
    const organization = this.organizationOf(scope);
    // Explicit key wins; otherwise the label becomes the identity.
    const key = normalizeFieldKey(dto.key?.trim() ? dto.key : dto.label);
    const unit = this.resolveUnit(dto.type, dto.unit ?? null);
    const options = this.resolveOptions(dto.type, dto.options);

    return this.em.transactional(async (tem) => {
      // Archived definitions still own their key, so this also refuses a
      // redefinition of something that was retired.
      const clash = await tem.findOne(ProductFieldDefinition, { organization, key });
      if (clash) {
        throw new ConflictException(`The field key "${key}" already exists for this company`);
      }
      const definition = tem.create(ProductFieldDefinition, {
        organization: organization as any,
        key,
        label: dto.label.trim(),
        type: dto.type,
        unit,
        source: 'CUSTOM',
        fieldGroup: dto.group?.trim() || null,
        applicability: dto.applicability ?? 'BOTH',
        childOverrideAllowed: dto.childOverrideAllowed ?? true,
        options,
        sortOrder: dto.sortOrder ?? 0,
      } as any);
      await tem.persistAndFlush(definition);
      return this.toDefinitionDto(definition);
    });
  }

  async updateDefinition(scope: TenantScope | undefined, id: string, dto: UpdateProductFieldDto) {
    const organization = this.organizationOf(scope);
    return this.em.transactional(async (tem) => {
      // FOR UPDATE: value writers hold the row FOR SHARE, so a semantic
      // change (unit, options, applicability, override policy) serializes
      // against in-flight writes instead of racing them.
      const definition = await tem.findOne(
        ProductFieldDefinition,
        { id, organization },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!definition) throw notFound('Field');

      if (dto.label !== undefined) definition.label = dto.label.trim();
      if (dto.group !== undefined) definition.fieldGroup = dto.group?.trim() || null;
      if (dto.sortOrder !== undefined) definition.sortOrder = dto.sortOrder;

      // Meaning-changing edits are refused while values exist: a stored
      // number's unit and a stored selection's option list ARE its meaning.
      if (dto.unit !== undefined) {
        const next = this.resolveUnit(definition.type, dto.unit);
        if (next !== (definition.unit ?? null) && (await tem.count(ProductFieldValue, { definition: id })) > 0) {
          throw new BadRequestException({
            code: 'FIELD_UNIT_IMMUTABLE_WITH_VALUES',
            definitionKey: definition.key,
            reason: 'Changing the canonical unit would silently reinterpret every stored value',
          });
        }
        definition.unit = next;
      }
      if (dto.options !== undefined) {
        const next = this.resolveOptions(definition.type, dto.options);
        if ((await tem.count(ProductFieldValue, { definition: id })) > 0) {
          throw new BadRequestException({
            code: 'FIELD_OPTIONS_IMMUTABLE_WITH_VALUES',
            definitionKey: definition.key,
            reason: 'Changing the option list would orphan stored answers',
          });
        }
        definition.options = next;
      }
      if (dto.applicability !== undefined && dto.applicability !== definition.applicability) {
        await this.assertApplicabilityChangeLegal(tem, definition, dto.applicability);
        definition.applicability = dto.applicability;
      }
      if (dto.childOverrideAllowed !== undefined && dto.childOverrideAllowed !== definition.childOverrideAllowed) {
        if (!dto.childOverrideAllowed) {
          await this.assertNoChildRows(
            tem,
            definition,
            'FIELD_OVERRIDES_IN_USE',
            'Child products override this field; remove those answers before disabling overrides',
          );
        }
        definition.childOverrideAllowed = dto.childOverrideAllowed;
      }
      await tem.flush();
      return this.toDefinitionDto(definition);
    });
  }

  /**
   * Narrowing applicability is refused while rows exist on the newly
   * excluded side. The COMPLETE affected set is evaluated (counts over all
   * rows); only the report is bounded. After a successful narrowing no row
   * sits on the excluded side, so no published child can be relying on an
   * inheritance the narrowing removes — the row refusal subsumes the
   * effective-value hazard.
   */
  private async assertApplicabilityChangeLegal(
    tem: EntityManager,
    definition: ProductFieldDefinition,
    next: FieldApplicability,
  ): Promise<void> {
    if (next === 'PARENT') {
      // Products WITH a parent may no longer hold direct rows.
      const offending = await tem.execute(
        // #292: applicability is decided against the LIVE catalogue. A removed
        // item's field values are retained and invisible, so counting them
        // would refuse a change on the strength of rows nobody can edit.
        `select count(*)::int as n from product_field_values v
           join products p on p.id = v.product_id
          where v.definition_id = ? and p.parent_id is not null and p.removed_at is null`,
        [definition.id],
      );
      if (offending[0].n > 0) {
        await this.refuseWithSample(
          tem,
          definition,
          'parent_id is not null',
          offending[0].n,
          'FIELD_APPLICABILITY_ROWS',
          'Versions hold direct values this applicability would exclude',
        );
      }
    }
    if (next === 'CHILD') {
      const offending = await tem.execute(
        // #292: a removed child does not make its parent a card for this rule.
        `select count(*)::int as n from product_field_values v
          where v.definition_id = ?
            and exists (select 1 from products c where c.parent_id = v.product_id and c.removed_at is null)`,
        [definition.id],
      );
      if (offending[0].n > 0) {
        const sample = await tem.execute(
          // #292: the sample must match the count above, or the refusal names
          // rows the count did not include.
          `select v.product_id from product_field_values v
            where v.definition_id = ?
              and exists (select 1 from products c where c.parent_id = v.product_id and c.removed_at is null)
            order by v.product_id limit 10`,
          [definition.id],
        );
        throw new ConflictException({
          code: 'FIELD_APPLICABILITY_ROWS',
          definitionKey: definition.key,
          reason: 'Parent products hold direct values this applicability would exclude',
          offendingProductCount: offending[0].n,
          offendingProductIds: sample.map((r: any) => r.product_id),
          truncated: offending[0].n > sample.length,
        });
      }
    }
  }

  private async refuseWithSample(
    tem: EntityManager,
    definition: ProductFieldDefinition,
    parentPredicate: string,
    total: number,
    code: string,
    reason: string,
  ): Promise<never> {
    const sample = await tem.execute(
      // #292: the sample lists live items only, matching every count that
      // leads here — a refusal that names an invisible row cannot be acted on.
      `select v.product_id from product_field_values v
         join products p on p.id = v.product_id
        where v.definition_id = ? and p.${parentPredicate} and p.removed_at is null
        order by v.product_id limit 10`,
      [definition.id],
    );
    throw new ConflictException({
      code,
      definitionKey: definition.key,
      reason,
      offendingProductCount: total,
      offendingProductIds: sample.map((r: any) => r.product_id),
      truncated: total > sample.length,
    });
  }

  private async assertNoChildRows(
    tem: EntityManager,
    definition: ProductFieldDefinition,
    code: string,
    reason: string,
  ): Promise<void> {
    // #292: live catalogue only; see the applicability checks above.
    const offending = await tem.execute(
      `select count(*)::int as n from product_field_values v
         join products p on p.id = v.product_id
        where v.definition_id = ? and p.parent_id is not null and p.removed_at is null`,
      [definition.id],
    );
    if (offending[0].n > 0) {
      await this.refuseWithSample(tem, definition, 'parent_id is not null', offending[0].n, code, reason);
    }
  }

  async archiveDefinition(scope: TenantScope | undefined, id: string) {
    const organization = this.organizationOf(scope);
    return this.em.transactional(async (tem) => {
      const definition = await tem.findOne(ProductFieldDefinition, { id, organization });
      if (!definition) throw notFound('Field');
      if (definition.archivedAt) return this.toDefinitionDto(definition);

      // A field still in use by a branch cannot be retired behind its back.
      const active = await tem.count(StoreFieldSetting, { definition: definition.id, active: true });
      if (active > 0) {
        throw new BadRequestException(
          `${active} store(s) still use this field. Deactivate it there before archiving it.`,
        );
      }
      definition.archivedAt = new Date();
      await tem.flush();
      return this.toDefinitionDto(definition);
    });
  }

  /** Clears archivedAt only. Store activation is never restored implicitly. */
  async restoreDefinition(scope: TenantScope | undefined, id: string) {
    const organization = this.organizationOf(scope);
    return this.em.transactional(async (tem) => {
      const definition = await tem.findOne(ProductFieldDefinition, { id, organization });
      if (!definition) throw notFound('Field');
      definition.archivedAt = null;
      await tem.flush();
      return this.toDefinitionDto(definition);
    });
  }

  // ------------------------------------------------------------ store settings

  /** Every live definition with this branch's setting, or null where unused. */
  async listStoreSettings(scope: TenantScope | undefined, storeId: string) {
    const organization = this.organizationOf(scope);
    await this.assertStoreInScope(scope, storeId, organization);

    const [definitions, settings] = await Promise.all([
      this.definitionRepository.find({ organization, archivedAt: null }, { orderBy: { sortOrder: 'ASC', key: 'ASC' } }),
      this.em.find(StoreFieldSetting, { store: storeId }),
    ]);
    const byDefinition = new Map(settings.map((s) => [(s.definition as any).id ?? (s.definition as any), s]));
    return definitions.map((definition) => {
      const setting = byDefinition.get(definition.id) ?? null;
      return {
        definition: this.toDefinitionDto(definition),
        setting: setting ? this.toSettingDto(setting) : null,
      };
    });
  }

  async upsertStoreSetting(
    scope: TenantScope | undefined,
    storeId: string,
    definitionId: string,
    dto: UpsertStoreFieldSettingDto,
  ) {
    const organization = this.organizationOf(scope);
    await this.assertStoreInScope(scope, storeId, organization);

    return this.em.transactional(async (tem) => {
      // The store's publication lock comes FIRST (B4a3): every read below —
      // definition, setting, and the published catalogue a new requirement
      // scans — happens under the same key every publication writer holds,
      // so both sides decide against settled state.
      await this.publicationGuard.lockStoreRequirements(tem, storeId);

      const definition = await tem.findOne(ProductFieldDefinition, { id: definitionId, organization });
      if (!definition) throw notFound('Field');
      if (definition.archivedAt) {
        throw new BadRequestException('This field is archived; restore it before activating it in a store');
      }
      const store = await tem.findOne(Store, { id: storeId });
      if (!store) throw notFound('Store');

      const setting = await tem.findOne(StoreFieldSetting, { store: storeId, definition: definitionId });
      const wasEffectivelyRequired = !!setting && setting.active && setting.required;

      // The FINAL state is what gets ruled on: omission preserves, so a
      // partial update can never flip a flag behind the caller's back. A
      // missing row contributes the column defaults (everything off).
      const finalActive = dto.active ?? setting?.active ?? false;
      const finalRequired = dto.required ?? setting?.required ?? false;
      const finalPubliclyVisible = dto.publiclyVisible ?? setting?.publiclyVisible ?? false;
      const finalImportable = dto.importable ?? setting?.importable ?? false;
      const finalFilterable = dto.filterable ?? setting?.filterable ?? false;

      // Deactivating must not silently drop the other flags: the caller is
      // told to turn them off explicitly, so nothing changes behind their
      // back — and required-while-inactive can never exist, in any order the
      // flags arrive. Values are untouched either way: deactivation only
      // stops this branch serving, requiring, importing or filtering by them.
      if (!finalActive && (finalPubliclyVisible || finalImportable || finalRequired || finalFilterable)) {
        throw new BadRequestException(
          'An inactive field cannot be public, importable, filterable or required. Turn those off in the same request.',
        );
      }

      // A display unit is a CONVERSION, so it needs a conversion to exist:
      // a CURATED NUMBER definition whose registry family contains the unit.
      // The canonical stored value is never rewritten by any of this.
      if (dto.displayUnit !== undefined && dto.displayUnit !== null) {
        const wanted = dto.displayUnit.trim();
        if (!wanted) throw new BadRequestException('A display unit cannot be blank; send null to clear it');
        if (definition.type !== ProductFieldType.NUMBER) {
          throw new BadRequestException('Only a NUMBER field can have a display unit');
        }
        const entry = definition.source === 'CURATED' ? curatedFieldByKey(definition.key) : null;
        if (!entry || !entry.unitFamily) {
          throw new BadRequestException('This field has no known unit family, so no display conversion exists for it');
        }
        if (!allowedUnitsFor(entry).includes(wanted)) {
          throw new BadRequestException(
            `"${wanted}" is not a unit of this field's family (${allowedUnitsFor(entry).join(', ')})`,
          );
        }
      }

      // Only the transition INTO effective requirement scans: what is already
      // required stays required, and what is not becoming required demands
      // nothing of anybody. Validation runs strictly before anything is
      // persisted — a refusal leaves no half-written setting behind.
      if (finalActive && finalRequired && !wasEffectivelyRequired) {
        await this.publicationGuard.assertRequirableInStore(tem, storeId, definitionId);
      }

      const row =
        setting ??
        tem.create(StoreFieldSetting, {
          organization: organization as any,
          store,
          definition,
        } as any);
      row.active = finalActive;
      row.required = finalRequired;
      row.publiclyVisible = finalPubliclyVisible;
      row.importable = finalImportable;
      row.filterable = finalFilterable;
      if (dto.sortOrder !== undefined) row.sortOrder = dto.sortOrder;
      if (dto.labelOverride !== undefined) row.labelOverride = dto.labelOverride?.trim() || null;
      if (dto.groupOverride !== undefined) row.groupOverride = dto.groupOverride?.trim() || null;
      if (dto.displayUnit !== undefined) row.displayUnit = dto.displayUnit?.trim() || null;
      tem.persist(row);
      await tem.flush();

      return {
        definition: this.toDefinitionDto(definition),
        setting: this.toSettingDto(row),
      };
    });
  }

  private toSettingDto(setting: StoreFieldSetting) {
    return {
      active: setting.active,
      required: setting.required,
      publiclyVisible: setting.publiclyVisible,
      importable: setting.importable,
      filterable: setting.filterable,
      sortOrder: setting.sortOrder ?? null,
      labelOverride: setting.labelOverride ?? null,
      groupOverride: setting.groupOverride ?? null,
      displayUnit: setting.displayUnit ?? null,
    };
  }

  // ------------------------------------------------------------------- values

  /** Readable by any actor whose scope covers the product's company. */
  async listValues(scope: TenantScope | undefined, productId: string) {
    const organization = this.organizationOf(scope);
    const product = await this.em.findOne(Product, { id: productId, organization });
    if (!product) throw notFound('Product');

    const values = await this.em.find(ProductFieldValue, { product: productId }, { populate: ['definition'] as never });
    return values
      .map((v) => {
        const definition = v.definition as any as ProductFieldDefinition;
        return { definition, value: v };
      })
      .filter(({ definition }) => !definition.archivedAt)
      .sort(
        (a, b) => a.definition.sortOrder - b.definition.sortOrder || a.definition.key.localeCompare(b.definition.key),
      )
      .map(({ definition, value }) => ({
        definitionId: definition.id,
        key: definition.key,
        label: definition.label,
        type: definition.type,
        unit: definition.unit ?? null,
        value: this.readValue(definition.type, value),
      }));
  }

  /**
   * Writing a value changes what EVERY branch showing this product reads, so
   * it needs company-wide authority. Seeing the product in your own branch is
   * not the same entitlement (B4a2).
   */
  async upsertValue(
    scope: TenantScope | undefined,
    productId: string,
    definitionId: string,
    dto: UpsertProductFieldValueDto,
  ) {
    const organization = this.organizationOf(scope);
    if (!hasOrganizationWideAuthority(scope)) {
      throw new BadRequestException(
        'Field values are shared by every branch showing this product, so they can only be changed with company-wide access.',
      );
    }

    return this.em.transactional(async (tem) => {
      const product = await tem.findOne(Product, { id: productId, organization });
      if (!product) throw notFound('Product');
      // FOR SHARE: semantic definition changes take the row FOR UPDATE, so a
      // write in flight and a narrowing in flight cannot both commit.
      const definition = await tem.findOne(
        ProductFieldDefinition,
        { id: definitionId, organization },
        { lockMode: LockMode.PESSIMISTIC_READ },
      );
      if (!definition) throw notFound('Field');
      if (definition.archivedAt) {
        throw new BadRequestException('This field is archived and no longer accepts values');
      }
      this.assertDirectValueAllowed(definition, await this.familyPositionOf(tem, product));

      let value = await tem.findOne(ProductFieldValue, { product: productId, definition: definitionId });
      if (!value) {
        value = tem.create(ProductFieldValue, {
          organization: organization as any,
          product,
          definition,
          definitionType: definition.type,
        } as any);
        tem.persist(value);
      }
      this.writeValue(definition, value, dto.value);
      await tem.flush();

      return {
        definitionId: definition.id,
        key: definition.key,
        label: definition.label,
        type: definition.type,
        unit: definition.unit ?? null,
        value: this.readValue(definition.type, value),
      };
    });
  }

  /**
   * One product's EFFECTIVE answers: its direct values, completed by its
   * parent's values wherever applicability lets a child display the family
   * fact (PARENT or BOTH). Nothing is copied — resolution happens here, per
   * read. `source` and `sourceProductId` keep direct and inherited
   * distinguishable for the UI Phase 5 builds.
   */
  async listEffectiveValues(scope: TenantScope | undefined, productId: string) {
    const organization = this.organizationOf(scope);
    const product = await this.em.findOne(Product, { id: productId, organization });
    if (!product) throw notFound('Product');
    const parentRef = product.parent as unknown as { id?: string } | string | null | undefined;
    const parentId = (typeof parentRef === 'string' ? parentRef : parentRef?.id) ?? null;

    const definitions = await this.definitionRepository.find(
      { organization, archivedAt: null },
      { orderBy: { sortOrder: 'ASC', key: 'ASC' } },
    );
    const resolved = await this.resolveEffectiveValues(this.em, [{ id: productId, parentId }], definitions);
    const byDefinition = resolved.get(productId) ?? new Map();
    return definitions
      .filter((definition) => byDefinition.has(definition.id))
      .map((definition) => {
        const entry = byDefinition.get(definition.id)!;
        return {
          definitionId: definition.id,
          key: definition.key,
          label: definition.label,
          group: definition.fieldGroup ?? null,
          type: definition.type,
          unit: definition.unit ?? null,
          value: this.readValue(definition.type, entry.row),
          source: entry.source,
          sourceProductId: entry.sourceProductId,
        };
      });
  }

  /**
   * Batch effective-value resolution: one values query for the products and
   * their parents together, never per row. Returns, per product, the row
   * that answers each definition and where it came from.
   */
  async resolveEffectiveValues(
    em: EntityManager,
    products: { id: string; parentId: string | null }[],
    definitions: ProductFieldDefinition[],
  ): Promise<
    Map<string, Map<string, { row: ProductFieldValue; source: EffectiveValueSource; sourceProductId: string }>>
  > {
    const result = new Map<
      string,
      Map<string, { row: ProductFieldValue; source: EffectiveValueSource; sourceProductId: string }>
    >();
    if (products.length === 0 || definitions.length === 0) return result;

    const ids = new Set<string>();
    for (const product of products) {
      ids.add(product.id);
      if (product.parentId) ids.add(product.parentId);
    }
    const values = await em.find(ProductFieldValue, {
      product: { $in: Array.from(ids) },
      definition: { $in: definitions.map((d) => d.id) },
    });
    const byProductAndDefinition = new Map<string, ProductFieldValue>();
    for (const value of values) {
      const productId = (value.product as any)?.id ?? (value.product as any);
      const definitionId = (value.definition as any)?.id ?? (value.definition as any);
      byProductAndDefinition.set(`${productId}:${definitionId}`, value);
    }

    for (const product of products) {
      const resolved = new Map<
        string,
        { row: ProductFieldValue; source: EffectiveValueSource; sourceProductId: string }
      >();
      for (const definition of definitions) {
        const direct = byProductAndDefinition.get(`${product.id}:${definition.id}`);
        if (direct) {
          resolved.set(definition.id, { row: direct, source: 'DIRECT', sourceProductId: product.id });
          continue;
        }
        // A child displays the family fact whenever the parent MAY hold it.
        if (product.parentId && definition.applicability !== 'CHILD') {
          const inherited = byProductAndDefinition.get(`${product.parentId}:${definition.id}`);
          if (inherited) {
            resolved.set(definition.id, { row: inherited, source: 'INHERITED', sourceProductId: product.parentId });
          }
        }
      }
      result.set(product.id, resolved);
    }
    return result;
  }

  /**
   * Clears one product's answer for one field (B4a3).
   *
   * Deleting is a value change like any other, so it takes the same
   * company-wide authority as writing — and one more thing writing never
   * needed: proof that no branch currently SHOWING the product demands the
   * answer. The guard derives that exposure, locks the family root and every
   * demanding store in canonical order, re-reads everything under the locks,
   * and refuses with a bounded 409 before the row is touched. A widened lock
   * set restarts the whole deletion in a fresh transaction.
   */
  async deleteValue(scope: TenantScope | undefined, productId: string, definitionId: string): Promise<void> {
    const organization = this.organizationOf(scope);
    if (!hasOrganizationWideAuthority(scope)) {
      throw new BadRequestException(
        'Field values are shared by every branch showing this product, so they can only be changed with company-wide access.',
      );
    }

    return this.publicationGuard.withLockRetry(() =>
      this.em.transactional(async (tem) => {
        const product = await tem.findOne(Product, { id: productId, organization });
        if (!product) throw notFound('Product');
        const definition = await tem.findOne(
          ProductFieldDefinition,
          { id: definitionId, organization },
          { lockMode: LockMode.PESSIMISTIC_READ },
        );
        if (!definition) throw notFound('Field');
        // An archived field's values are frozen evidence of what was answered;
        // restore the field before clearing them.
        if (definition.archivedAt) {
          throw new BadRequestException('This field is archived; restore it before clearing its value');
        }
        const value = await tem.findOne(ProductFieldValue, { product: productId, definition: definitionId });
        if (!value) throw notFound('Value');

        // The service states the intent; the guard derives, locks, re-reads
        // and rules — including, since Phase 2, every CHILD whose inherited
        // answer this deletion would strip. Removal happens strictly after
        // it allows.
        await this.publicationGuard.assertValueDeletable(tem, product, definition);

        tem.remove(value);
        await tem.flush();
      }),
    );
  }

  /**
   * Writes field values while a product is being CREATED, inside the caller's
   * transaction (B4a3).
   *
   * Creation-only authority. A branch actor may answer fields for the product
   * it is creating — otherwise it could never create one where a required field
   * exists, since value writes are company-wide — but gains no power to change
   * values afterwards. `upsertValue` still refuses it.
   *
   * Reuses `writeValue`, so type agreement is decided in exactly one place.
   * Every id is resolved and every duplicate rejected BEFORE the first write,
   * so a rejected payload leaves nothing half-applied.
   */
  async writeCreationValues(
    tem: EntityManager,
    product: Product,
    organizationId: string,
    entries: { definitionId: string; value: unknown }[],
    actorStoreId: string | null,
  ): Promise<void> {
    if (!entries.length) return;

    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.definitionId)) {
        throw new BadRequestException(`Field ${entry.definitionId} appears more than once`);
      }
      seen.add(entry.definitionId);
    }

    // FOR SHARE, matching upsertValue: a concurrent semantic change to any
    // of these definitions serializes against this creation.
    const definitions = await tem.find(
      ProductFieldDefinition,
      { id: { $in: Array.from(seen) }, organization: organizationId },
      { lockMode: LockMode.PESSIMISTIC_READ },
    );
    const byId = new Map(definitions.map((d) => [d.id, d]));
    const position: FamilyPosition = {
      hasParent: !!((product.parent as any)?.id ?? (product.parent as any)),
      // A product being created has no children yet by construction; if it
      // later becomes a parent product, the attach transition re-validates.
      hasChildren: false,
    };
    for (const id of seen) {
      const definition = byId.get(id);
      if (!definition) throw notFound('Field');
      if (definition.archivedAt) {
        throw new BadRequestException('This field is archived and no longer accepts values');
      }
      this.assertDirectValueAllowed(definition, position);
    }

    // A branch actor may only answer fields its own branch has adopted.
    if (actorStoreId) {
      const active = await tem.find(StoreFieldSetting, {
        store: actorStoreId,
        definition: { $in: Array.from(seen) },
        active: true,
      });
      const adopted = new Set(
        active.map((s: any) => (typeof s.definition === 'string' ? s.definition : s.definition?.id)),
      );
      for (const id of seen) {
        if (!adopted.has(id)) throw notFound('Field');
      }
    }

    for (const entry of entries) {
      const definition = byId.get(entry.definitionId) as ProductFieldDefinition;
      const row = tem.create(ProductFieldValue, {
        organization: organizationId as any,
        product,
        definition,
        definitionType: definition.type,
      } as any);
      this.writeValue(definition, row, entry.value);
      tem.persist(row);
    }
    await tem.flush();
  }

  /**
   * Writes a created product's import values inside the caller's row
   * transaction (B4a3). The identity, archival, adoption and column checks
   * already ran ONCE at commit level — the parameter type is unforgeable
   * proof — so this stages rows with no per-row definition queries and leaves
   * type agreement to the same `writeValue` every other writer uses.
   *
   * Only a trimmed-empty cell is absent. "false" and "0" are answers.
   */
  async writeImportValues(
    tem: EntityManager,
    product: Product,
    organizationId: string,
    verified: VerifiedImportFieldMappings,
    row: string[],
    decimalSeparator: 'dot' | 'comma',
  ): Promise<void> {
    if (verified.entries.length === 0) return;
    const position: FamilyPosition = {
      hasParent: !!((product.parent as any)?.id ?? (product.parent as any)),
      hasChildren: false, // just created; the attach transition re-validates
    };
    let wrote = false;
    for (const { definition, columnIndex } of verified.entries) {
      const raw = String(row[columnIndex] ?? '').trim();
      if (raw === '') continue;
      this.assertDirectValueAllowed(definition, position);
      const value = tem.create(ProductFieldValue, {
        organization: organizationId as any,
        product,
        definition,
        definitionType: definition.type,
      } as any);
      this.writeValue(definition, value, this.coerceImportCell(definition.type, raw, decimalSeparator));
      tem.persist(value);
      wrote = true;
    }
    if (wrote) await tem.flush();
  }

  /**
   * Turns a CSV cell into the shape `writeValue` demands — nothing more.
   * BOOLEAN accepts the deterministic spellings below; NUMBER only has its
   * separator convention normalized, so canonicalizeDecimal still refuses
   * junk with the established 400 and the row fails whole.
   */
  private coerceImportCell(type: ProductFieldType, raw: string, decimalSeparator: 'dot' | 'comma'): unknown {
    if (type === ProductFieldType.BOOLEAN) {
      const spelled = raw.toLowerCase();
      if (['true', '1', 'yes', 'si', 'sí'].includes(spelled)) return true;
      if (['false', '0', 'no'].includes(spelled)) return false;
      throw new BadRequestException(`"${raw}" is not a boolean value`);
    }
    if (type === ProductFieldType.NUMBER) {
      // COMMA = 1.234,56 (period groups thousands) · DOT = 1,234.56
      return decimalSeparator === 'comma' ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
    }
    // SELECT / DATE / URL cells pass through as strings: writeValue applies
    // the same membership, calendar and URL validation as every other writer.
    return raw;
  }

  // ------------------------------------------------------------------ helpers

  private async assertStoreInScope(scope: TenantScope | undefined, storeId: string, organization: string) {
    if (!scopeAllowsStore(scope, storeId)) throw notFound('Store');
    const store = await this.em.findOne(Store, { id: storeId });
    const storeOrganization = (store as any)?.organization?.id ?? (store as any)?.organization ?? null;
    if (!store || storeOrganization !== organization) throw notFound('Store');
  }

  private resolveUnit(type: ProductFieldType, unit: string | null | undefined): string | null {
    if (unit === null || unit === undefined) return null;
    const trimmed = unit.trim();
    if (!trimmed) return null;
    if (type !== ProductFieldType.NUMBER) {
      throw new BadRequestException('Only a NUMBER field can carry a unit');
    }
    return trimmed;
  }

  /** SELECT demands options; every other type refuses them. */
  private resolveOptions(type: ProductFieldType, options: string[] | undefined): string[] | null {
    if (type !== ProductFieldType.SELECT) {
      if (options !== undefined) {
        throw new BadRequestException('Only a SELECT field can carry options');
      }
      return null;
    }
    if (!options || options.length === 0) {
      throw new BadRequestException('A SELECT field needs its list of allowed options');
    }
    const cleaned = options.map((option) => option.trim());
    if (cleaned.some((option) => !option)) {
      throw new BadRequestException('A SELECT option cannot be blank');
    }
    if (new Set(cleaned).size !== cleaned.length) {
      throw new BadRequestException('SELECT options must be unique');
    }
    return cleaned;
  }

  /**
   * The ONE place a raw value becomes a typed row. Every writer — admin
   * upsert, creation, import — goes through here, so type agreement, the
   * exactly-one-column rule, SELECT membership and curated registry
   * constraints are decided once.
   */
  private writeValue(definition: ProductFieldDefinition, row: ProductFieldValue, raw: unknown): void {
    const type = definition.type;
    row.definitionType = type;
    row.valueText = null;
    row.valueNumber = null;
    row.valueBoolean = null;
    row.valueDate = null;
    if (type === ProductFieldType.TEXT) {
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new BadRequestException('A TEXT value must be a non-empty string');
      }
      row.valueText = this.applyCuratedTextConstraints(definition, raw.trim());
      return;
    }
    if (type === ProductFieldType.NUMBER) {
      row.valueNumber = this.applyCuratedNumberConstraints(definition, canonicalizeDecimal(raw));
      return;
    }
    if (type === ProductFieldType.SELECT) {
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new BadRequestException('A SELECT value must be a non-empty string');
      }
      const value = raw.trim();
      const options = definition.options ?? [];
      if (!options.includes(value)) {
        throw new BadRequestException({
          code: 'FIELD_VALUE_NOT_AN_OPTION',
          definitionKey: definition.key,
          reason: `"${value}" is not one of this field's allowed options`,
        });
      }
      row.valueText = value;
      return;
    }
    if (type === ProductFieldType.DATE) {
      row.valueDate = canonicalizeDate(raw);
      return;
    }
    if (type === ProductFieldType.URL) {
      row.valueText = canonicalizeUrl(raw);
      return;
    }
    if (typeof raw !== 'boolean') {
      throw new BadRequestException('A BOOLEAN value must be true or false, not a string');
    }
    row.valueBoolean = raw;
  }

  /** Registry length ceilings apply only to CURATED definitions. */
  private applyCuratedTextConstraints(definition: ProductFieldDefinition, value: string): string {
    if (definition.source !== 'CURATED') return value;
    const entry = curatedFieldByKey(definition.key);
    if (entry?.maxLength !== undefined && value.length > entry.maxLength) {
      throw new BadRequestException({
        code: 'FIELD_VALUE_TOO_LONG',
        definitionKey: definition.key,
        reason: `"${definition.label}" accepts at most ${entry.maxLength} characters`,
        constraint: { maxLength: entry.maxLength },
      });
    }
    return value;
  }

  /** Registry range/integrality rules for CURATED NUMBER definitions. */
  private applyCuratedNumberConstraints(definition: ProductFieldDefinition, canonical: string): string {
    if (definition.source !== 'CURATED') return canonical;
    const constraints = curatedFieldByKey(definition.key)?.number;
    if (!constraints) return canonical;
    const refuse = (reason: string, constraint: Record<string, unknown>) => {
      throw new BadRequestException({
        code: 'FIELD_VALUE_OUT_OF_RANGE',
        definitionKey: definition.key,
        reason,
        constraint,
      });
    };
    if (constraints.min !== undefined) {
      const cmp = compareDecimal(canonical, constraints.min);
      if (constraints.minExclusive ? cmp <= 0 : cmp < 0) {
        refuse(
          `"${definition.label}" must be ${constraints.minExclusive ? 'greater than' : 'at least'} ${constraints.min}`,
          { min: constraints.min, minExclusive: !!constraints.minExclusive },
        );
      }
    }
    if (constraints.max !== undefined && compareDecimal(canonical, constraints.max) > 0) {
      refuse(`"${definition.label}" must be at most ${constraints.max}`, { max: constraints.max });
    }
    if (constraints.integer && !isWholeDecimal(canonical)) {
      refuse(`"${definition.label}" must be a whole number`, { integer: true });
    }
    return canonical;
  }

  /**
   * Which side of a family may hold a DIRECT value for this definition.
   * Standalone products (neither side) always pass — they are their own
   * family. Under BOTH with overrides disabled, family members hold parent
   * values only, so any child direct write is refused regardless of the
   * parent's current state — a permission must not depend on data that can
   * change after it is granted.
   */
  assertDirectValueAllowed(definition: ProductFieldDefinition, position: FamilyPosition): void {
    const refuse = (reason: string) => {
      throw new BadRequestException({ code: 'FIELD_NOT_APPLICABLE', definitionKey: definition.key, reason });
    };
    if (definition.applicability === 'PARENT' && position.hasParent) {
      refuse(`"${definition.label}" belongs to the parent product; its child products inherit it`);
    }
    if (definition.applicability === 'CHILD' && position.hasChildren) {
      refuse(`"${definition.label}" belongs to the purchasable child products, not the parent product`);
    }
    if (definition.applicability === 'BOTH' && !definition.childOverrideAllowed && position.hasParent) {
      refuse(`"${definition.label}" does not allow child overrides; the parent product carries it`);
    }
  }

  /** The family facts applicability rules on, read fresh. */
  async familyPositionOf(tem: EntityManager, product: Product): Promise<FamilyPosition> {
    const parent = product.parent as unknown as { id?: string } | string | null | undefined;
    const hasParent = !!(typeof parent === 'string' ? parent : parent?.id);
    const hasChildren = (await tem.count(Product, { parent: product.id })) > 0;
    return { hasParent, hasChildren };
  }

  private readValue(type: ProductFieldType, row: ProductFieldValue): string | boolean | null {
    // Shared with the public fields[] reader, so both surfaces agree.
    return readFieldValue(type, row);
  }

  toDefinitionDto(d: ProductFieldDefinition) {
    return {
      id: d.id,
      key: d.key,
      label: d.label,
      type: d.type,
      unit: d.unit ?? null,
      source: d.source,
      group: d.fieldGroup ?? null,
      applicability: d.applicability,
      childOverrideAllowed: d.childOverrideAllowed,
      options: d.options ?? null,
      sortOrder: d.sortOrder,
      archivedAt: d.archivedAt ?? null,
    };
  }
}
