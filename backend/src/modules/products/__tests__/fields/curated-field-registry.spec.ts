import {
  CURATED_FIELD_REGISTRY,
  UNIT_FAMILIES,
  allowedUnitsFor,
  compareDecimal,
  convertUnitValue,
  curatedFieldByKey,
  isWholeDecimal,
} from '../../fields/curated-field-registry';
import { ProductFieldType } from '../../entities/product-field-definition.entity';

/**
 * Phase 2: the registry is DATA whose invariants are the contract — stable
 * keys, valid types, deterministic ordering — and the unit conversion is
 * exact rational arithmetic on decimal strings, never binary floating point.
 */

describe('curated field registry data', () => {
  it('contains the seventeen agreed entries with unique stable keys', () => {
    expect(CURATED_FIELD_REGISTRY).toHaveLength(17);
    const keys = CURATED_FIELD_REGISTRY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(17);
    expect(keys).toEqual(
      expect.arrayContaining([
        'material',
        'width',
        'height',
        'depth',
        'length',
        'diameter',
        'weight',
        'finish',
        'color',
        'upholstery',
        'designer',
        'lead-time',
        'country',
        'care',
        'warranty',
        'awards',
        'technical-characteristics',
      ]),
    );
  });

  it('keeps every key in the persisted key format and ordering unique', () => {
    for (const entry of CURATED_FIELD_REGISTRY) {
      expect(entry.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.key.length).toBeLessThanOrEqual(64);
    }
    const orders = CURATED_FIELD_REGISTRY.map((entry) => entry.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('gives every NUMBER entry a canonical unit inside its own family', () => {
    for (const entry of CURATED_FIELD_REGISTRY) {
      if (entry.type !== ProductFieldType.NUMBER) {
        expect(entry.unit).toBeNull();
        expect(entry.unitFamily).toBeNull();
        continue;
      }
      expect(entry.unit).toBeTruthy();
      expect(entry.unitFamily).toBeTruthy();
      expect(allowedUnitsFor(entry)).toContain(entry.unit!);
    }
  });

  it('never allows child override on a PARENT-only entry', () => {
    for (const entry of CURATED_FIELD_REGISTRY) {
      if (entry.applicability === 'PARENT') expect(entry.childOverrideAllowed).toBe(false);
    }
    expect(curatedFieldByKey('designer')?.applicability).toBe('PARENT');
    expect(curatedFieldByKey('color')?.applicability).toBe('CHILD');
    expect(curatedFieldByKey('width')?.applicability).toBe('BOTH');
  });
});

describe('decimal comparison and integrality', () => {
  it('compares without floating point drift', () => {
    expect(compareDecimal('0.1', '0.100000')).toBe(0);
    expect(compareDecimal('9999999', '9999998.999999')).toBe(1);
    expect(compareDecimal('-3.5', '-3.4')).toBe(-1);
    expect(compareDecimal('123456789012.123456', '123456789012.123455')).toBe(1);
  });

  it('detects whole numbers exactly', () => {
    expect(isWholeDecimal('30')).toBe(true);
    expect(isWholeDecimal('30.000000')).toBe(true);
    expect(isWholeDecimal('30.5')).toBe(false);
  });
});

describe('exact unit conversion (display only)', () => {
  it('uses the exact international inch: 2.54 cm exactly', () => {
    expect(convertUnitValue('2.54', 'cm', 'in', 'length')).toBe('1');
    expect(convertUnitValue('1', 'in', 'cm', 'length')).toBe('2.54');
    expect(convertUnitValue('100', 'cm', 'in', 'length')).toBe('39.370079'); // rounded half-up at 6dp
    expect(convertUnitValue('12.7', 'cm', 'in', 'length')).toBe('5');
  });

  it('converts within the metric family without rounding at all', () => {
    expect(convertUnitValue('12.5', 'cm', 'mm', 'length')).toBe('125');
    expect(convertUnitValue('125', 'mm', 'cm', 'length')).toBe('12.5');
  });

  it('uses the exact international pound: 0.45359237 kg exactly', () => {
    // Inputs are stored canonical values (numeric(18,6), ≤6 dp) by contract.
    expect(convertUnitValue('1', 'kg', 'lb', 'mass')).toBe('2.204623'); // 100000000/45359237 half-up at 6dp
    expect(convertUnitValue('1', 'lb', 'kg', 'mass')).toBe('0.453592'); // 0.45359237 rounded half-up at 6dp
    expect(convertUnitValue('10', 'lb', 'g', 'mass')).toBe('4535.9237'); // exact, no rounding needed
    expect(convertUnitValue('2', 'kg', 'g', 'mass')).toBe('2000');
  });

  it('is identity for the same unit and refuses foreign units', () => {
    expect(convertUnitValue('7.25', 'cm', 'cm', 'length')).toBe('7.25');
    expect(() => convertUnitValue('1', 'cm', 'kg', 'length')).toThrow();
    expect(() => convertUnitValue('1', 'cm', 'mm', 'nonsense')).toThrow();
  });

  it('families expose their exact factors', () => {
    expect(UNIT_FAMILIES.length.units.in).toEqual({ num: 127n, den: 50n });
    expect(UNIT_FAMILIES.mass.units.lb).toEqual({ num: 45359237n, den: 100000000n });
  });
});
