import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProductFieldDefinition, ProductFieldType } from '../entities/product-field-definition.entity';
import { ProductFieldValue } from '../entities/product-field-value.entity';
import { TenantScope, hasOrganizationWideAuthority } from '../../auth/tenancy/tenant-scope';
import {
  CURATED_FIELD_REGISTRY,
  CuratedFieldEntry,
  allowedUnitsFor,
  compareDecimal,
  curatedFieldByKey,
  isWholeDecimal,
} from './curated-field-registry';
import { readFieldValue } from './product-field.util';

/** One aspect of an existing CUSTOM definition that blocks adoption. */
export interface AdoptionMismatch {
  aspect: 'type' | 'unit' | 'applicability' | 'childOverrideAllowed' | 'values';
  expected: string;
  actual: string;
}

export interface AdoptionReport {
  curatedKey: string;
  existingDefinitionId: string | null;
  compatible: boolean;
  mismatches: AdoptionMismatch[];
  /** COMPLETE count of value rows violating registry constraints. */
  valueViolations: { count: number; sampleProductIds: string[]; truncated: boolean };
}

/**
 * The per-organization face of the curated registry (Phase 2).
 *
 * Activation MATERIALIZES a registry entry as one ordinary
 * `product_field_definitions` row for the caller's organization — no schema
 * column, no global write, idempotent by the `(organization, key)` unique.
 * A CUSTOM definition already owning the key is never hijacked: activation
 * refuses with a precise compatibility report, and the explicit ADOPT
 * operation flips a COMPATIBLE row to CURATED in place, preserving its id,
 * values, settings and created timestamp (`updated_at` records the adoption
 * itself, as any real change should).
 */
@Injectable()
export class CuratedFieldRegistryService {
  constructor(private readonly em: EntityManager) {}

  private organizationOf(scope: TenantScope | undefined): string {
    const organizationId = scope?.organizationId ?? null;
    if (!organizationId) {
      throw new BadRequestException('Organization context required: choose a company before managing its fields');
    }
    return organizationId;
  }

  private assertOrgWide(scope: TenantScope | undefined): void {
    if (!hasOrganizationWideAuthority(scope)) {
      throw new BadRequestException(
        'Curated fields shape the whole company vocabulary, so they need company-wide access.',
      );
    }
  }

  /** The registry with this organization's activation state per entry. */
  async list(scope: TenantScope | undefined) {
    const organization = this.organizationOf(scope);
    const keys = CURATED_FIELD_REGISTRY.map((entry) => entry.key);
    const rows = await this.em.find(ProductFieldDefinition, { organization, key: { $in: keys } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return CURATED_FIELD_REGISTRY.map((entry) => {
      const existing = byKey.get(entry.key) ?? null;
      return {
        key: entry.key,
        type: entry.type,
        label: entry.label,
        group: entry.group,
        sortOrder: entry.sortOrder,
        unit: entry.unit,
        allowedUnits: allowedUnitsFor(entry),
        applicability: entry.applicability,
        childOverrideAllowed: entry.childOverrideAllowed,
        activatedDefinitionId: existing && existing.source === 'CURATED' ? existing.id : null,
        conflictingCustomDefinitionId: existing && existing.source === 'CUSTOM' ? existing.id : null,
        archived: !!existing?.archivedAt,
      };
    });
  }

  /**
   * Activates a curated entry for this organization. Idempotent: an existing
   * CURATED row is returned unchanged (tenant customization untouched); a
   * CUSTOM row refuses with the compatibility report; absence materializes
   * the registry defaults. The `(organization, key)` unique is the database
   * backstop against a concurrent double-activation.
   */
  async activate(scope: TenantScope | undefined, curatedKey: string) {
    this.assertOrgWide(scope);
    const organization = this.organizationOf(scope);
    const entry = curatedFieldByKey(curatedKey);
    if (!entry) throw new NotFoundException('Curated field not found');

    return this.em.transactional(async (tem) => {
      const existing = await tem.findOne(ProductFieldDefinition, { organization, key: entry.key });
      if (existing) {
        if (existing.source === 'CURATED') return this.toDto(existing);
        const report = await this.compatibilityReport(tem, entry, existing);
        throw new ConflictException({
          code: 'CURATED_KEY_HELD_BY_CUSTOM_FIELD',
          message:
            `The key "${entry.key}" already belongs to a field this company created. ` +
            `Adopt it explicitly if it is compatible.`,
          report,
        });
      }
      const definition = tem.create(ProductFieldDefinition, {
        organization: organization as any,
        key: entry.key,
        label: entry.label,
        type: entry.type,
        unit: entry.unit,
        source: 'CURATED',
        fieldGroup: entry.group,
        applicability: entry.applicability,
        childOverrideAllowed: entry.childOverrideAllowed,
        options: null,
        sortOrder: entry.sortOrder,
      } as any);
      await tem.persistAndFlush(definition);
      return this.toDto(definition);
    });
  }

  /**
   * Adopts a COMPATIBLE existing CUSTOM definition as the curated entry, in
   * place. Nothing is deleted or recreated: the id, every value, every store
   * setting and the created timestamp survive; `updated_at` records the
   * adoption. Registry defaults fill only what the row does not meaningfully
   * hold. Incompatibility refuses with the same precise report activation
   * shows — the operator resolves the data first; adoption never repairs it.
   */
  async adopt(scope: TenantScope | undefined, curatedKey: string) {
    this.assertOrgWide(scope);
    const organization = this.organizationOf(scope);
    const entry = curatedFieldByKey(curatedKey);
    if (!entry) throw new NotFoundException('Curated field not found');

    return this.em.transactional(async (tem) => {
      // FOR UPDATE: adoption changes the definition's semantics, so it
      // serializes against value writers exactly like updateDefinition.
      const existing = await tem.findOne(
        ProductFieldDefinition,
        { organization, key: entry.key },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!existing) throw new NotFoundException('Field not found');
      if (existing.source === 'CURATED') return this.toDto(existing); // idempotent

      const report = await this.compatibilityReport(tem, entry, existing);
      if (!report.compatible) {
        throw new ConflictException({
          code: 'CURATED_ADOPTION_INCOMPATIBLE',
          message: `The existing "${entry.key}" field is not compatible with the curated definition.`,
          report,
        });
      }

      const hasValues = (await tem.count(ProductFieldValue, { definition: existing.id })) > 0;
      existing.source = 'CURATED';
      existing.fieldGroup = existing.fieldGroup ?? entry.group;
      if (!hasValues && !existing.unit) existing.unit = entry.unit;
      existing.applicability = entry.applicability;
      existing.childOverrideAllowed = entry.childOverrideAllowed;
      await tem.flush();
      return this.toDto(existing);
    });
  }

  /**
   * The complete compatibility verdict. Value validation walks EVERY row —
   * the report is bounded to ten sample product ids, the evaluation is not.
   */
  private async compatibilityReport(
    tem: EntityManager,
    entry: CuratedFieldEntry,
    existing: ProductFieldDefinition,
  ): Promise<AdoptionReport> {
    const mismatches: AdoptionMismatch[] = [];
    // #292: the value rows themselves are not lifecycle-bearing, and this
    // report must see every one of them (see the applicability note below).
    // `product` is populated only to read its id, so the lifecycle filter on
    // Product may leave a removed item's reference unloaded without changing
    // which values are counted.
    const values = await tem.find(
      ProductFieldValue,
      { definition: existing.id },
      { populate: ['product'] as never },
    );

    if (existing.type !== entry.type) {
      mismatches.push({ aspect: 'type', expected: entry.type, actual: existing.type });
    }
    if (entry.type === ProductFieldType.NUMBER) {
      const unit = existing.unit ?? null;
      if (unit && !allowedUnitsFor(entry).includes(unit)) {
        mismatches.push({ aspect: 'unit', expected: allowedUnitsFor(entry).join('|'), actual: unit });
      }
      if (!unit && values.length > 0) {
        // The stored numbers have no stated unit: assigning one now would
        // reinterpret them. Refuse; the operator decides what they mean.
        mismatches.push({ aspect: 'unit', expected: entry.unit ?? '(unit)', actual: '(none, with values)' });
      }
    }

    const sampleIds: string[] = [];
    let violationCount = 0;
    const productIdOf = (value: ProductFieldValue): string =>
      ((value.product as any)?.id ?? (value.product as any)) as string;

    if (existing.type === entry.type) {
      for (const value of values) {
        if (!this.valueSatisfiesRegistry(entry, existing, value)) {
          violationCount += 1;
          if (sampleIds.length < 10) sampleIds.push(productIdOf(value));
        }
      }
      if (violationCount > 0) {
        mismatches.push({
          aspect: 'values',
          expected: 'every stored value within the registry constraints',
          actual: `${violationCount} violating value(s)`,
        });
      }

      // Applicability sides: the registry shape must already hold, product
      // by product, over the COMPLETE value set.
      //
      // #292: "complete" deliberately includes removed items and removed
      // children. Adoption is a durable decision about stored value rows,
      // and removal is recoverable: a value that violates the registry today
      // still violates it when its item is restored. Excluding removed rows
      // here would let adoption pass and then break on restoration, so this
      // census reads the whole catalogue on purpose.
      if (entry.applicability !== 'BOTH' || !entry.childOverrideAllowed) {
        const productIds = Array.from(new Set(values.map(productIdOf)));
        if (productIds.length > 0) {
          const rows = (await tem.execute(
            `select p.id, /* removed_at: adoption reads the whole value set, live or removed — see above */
                    (p.parent_id is not null) as has_parent,
                    exists(select 1 from products c where c.parent_id = p.id) as has_children
               from products p where p.id in (${productIds.map(() => '?').join(',')})`,
            productIds,
          )) as { id: string; has_parent: boolean; has_children: boolean }[];
          const offenders = rows.filter((row) => {
            if (entry.applicability === 'PARENT' && row.has_parent) return true;
            if (entry.applicability === 'CHILD' && row.has_children) return true;
            if (entry.applicability === 'BOTH' && !entry.childOverrideAllowed && row.has_parent) return true;
            return false;
          });
          if (offenders.length > 0) {
            mismatches.push({
              aspect: entry.applicability === 'BOTH' ? 'childOverrideAllowed' : 'applicability',
              expected:
                entry.applicability === 'BOTH'
                  ? 'no version overrides (registry forbids them)'
                  : `values only on the ${entry.applicability.toLowerCase()} side`,
              actual: `${offenders.length} product(s) on the excluded side`,
            });
          }
        }
      }
    }

    return {
      curatedKey: entry.key,
      existingDefinitionId: existing.id,
      compatible: mismatches.length === 0,
      mismatches,
      valueViolations: {
        count: violationCount,
        sampleProductIds: sampleIds,
        truncated: violationCount > sampleIds.length,
      },
    };
  }

  private valueSatisfiesRegistry(
    entry: CuratedFieldEntry,
    definition: ProductFieldDefinition,
    value: ProductFieldValue,
  ): boolean {
    const raw = readFieldValue(definition.type, value);
    if (raw === null) return true;
    if (entry.maxLength !== undefined && typeof raw === 'string' && raw.length > entry.maxLength) return false;
    if (entry.number && typeof raw === 'string') {
      const c = entry.number;
      if (c.min !== undefined) {
        const cmp = compareDecimal(raw, c.min);
        if (c.minExclusive ? cmp <= 0 : cmp < 0) return false;
      }
      if (c.max !== undefined && compareDecimal(raw, c.max) > 0) return false;
      if (c.integer && !isWholeDecimal(raw)) return false;
    }
    return true;
  }

  private toDto(definition: ProductFieldDefinition) {
    return {
      id: definition.id,
      key: definition.key,
      label: definition.label,
      type: definition.type,
      unit: definition.unit ?? null,
      source: definition.source,
      group: definition.fieldGroup ?? null,
      applicability: definition.applicability,
      childOverrideAllowed: definition.childOverrideAllowed,
      options: definition.options ?? null,
      sortOrder: definition.sortOrder,
      archivedAt: definition.archivedAt ?? null,
    };
  }
}
