import { describe, expect, it } from 'vitest';
import { FIELD_CATALOGUE } from './field-catalogue';

const PRODUCT_FIELD_OPTIONS = FIELD_CATALOGUE.PRODUCTS;

/**
 * What the identity fields are called, and why one of them is missing.
 *
 * "SKU (ours)" begged the question "ours as opposed to whose?" — asked beside a
 * column of supplier codes, which is exactly when it matters.
 */

const option = (value: string) => PRODUCT_FIELD_OPTIONS.find((o) => o.value === value);

describe('identity terminology', () => {
  it('names the catalogue identity Internal SKU (Catalog)', () => {
    expect(option('sku')?.label).toBe('Internal SKU (Catalog)');
    expect(option('sku')?.help).toContain('unique product identity');
  });

  it('no longer offers the ambiguous label anywhere', () => {
    for (const o of PRODUCT_FIELD_OPTIONS) expect(o.label).not.toContain('(ours)');
  });

  it('keeps Manufacturer code as its own target', () => {
    // The schema has `sku` (unique per organization) and `manufacturer_code`
    // (indexed, not unique). They are different columns with different rules,
    // so folding one into the other would change what identifies a product.
    expect(option('manufacturerCode')?.label).toBe('Manufacturer code');
    expect(option('manufacturerCode')?.help).toContain('not the same as a supplier');
  });

  it('offers no External SKU (Supplier) target, because no such column exists', () => {
    // Recorded as a test rather than a comment: the day somebody adds the
    // column, this fails and tells them to add the target with it. Until then,
    // offering one would silently write supplier identity into
    // `manufacturer_code`.
    expect(PRODUCT_FIELD_OPTIONS.find((o) => /external sku/i.test(o.label))).toBeUndefined();
  });

  it('explains every identity target it does offer', () => {
    for (const value of ['sku', 'manufacturerCode', 'externalId']) {
      expect(option(value)?.help ?? '').not.toBe('');
    }
  });
});
