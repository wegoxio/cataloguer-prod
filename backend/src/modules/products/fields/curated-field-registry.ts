import { FieldApplicability, ProductFieldType } from '../entities/product-field-definition.entity';

/**
 * The curated predefined-specification registry (Phase 2).
 *
 * The registry lives IN CODE, versioned by commit: entries are the shared
 * vocabulary Catalog proposes, and activating one materializes a normal
 * `product_field_definitions` row for ONE organization — never a schema
 * column, never a global write. The `(organization, key)` unique constraint
 * is the idempotency token; tenant customization (label, ordering) is never
 * overwritten by re-activation.
 *
 * NUMBER constraints and unit families live here rather than in columns:
 * they are properties of what the curated key MEANS, they apply identically
 * to every tenant, and keeping them out of the schema keeps activation
 * column-free by construction.
 */

export interface CuratedNumberConstraints {
  /** Inclusive unless `minExclusive`. Decimal strings — never floats. */
  min?: string;
  minExclusive?: boolean;
  /** Inclusive. */
  max?: string;
  /** Whole numbers only (e.g. lead time in days). */
  integer?: boolean;
}

export interface CuratedFieldEntry {
  key: string;
  type: ProductFieldType;
  label: string;
  group: string;
  sortOrder: number;
  /** Canonical unit (NUMBER only). Stored values always mean this unit. */
  unit: string | null;
  /** Name in UNIT_FAMILIES; null = no display conversion exists. */
  unitFamily: string | null;
  applicability: FieldApplicability;
  childOverrideAllowed: boolean;
  /** TEXT/URL length ceiling enforced at write time. */
  maxLength?: number;
  number?: CuratedNumberConstraints;
}

/**
 * Exact conversion factors: 1 <unit> = num/den <base units>.
 *
 * The inch and the pound use their exact international definitions
 * (1 in = 2.54 cm; 1 lb = 0.45359237 kg) expressed as integer rationals, so
 * no binary floating point ever touches a value. Conversion is DISPLAY-ONLY:
 * stored values are canonical and never rewritten.
 */
interface UnitFamily {
  base: string;
  units: Record<string, { num: bigint; den: bigint }>;
}

export const UNIT_FAMILIES: Record<string, UnitFamily> = {
  length: {
    base: 'cm',
    units: {
      cm: { num: 1n, den: 1n },
      mm: { num: 1n, den: 10n }, // 1 mm = 0.1 cm
      in: { num: 127n, den: 50n }, // 1 in = 2.54 cm, exactly
    },
  },
  mass: {
    base: 'kg',
    units: {
      kg: { num: 1n, den: 1n },
      g: { num: 1n, den: 1000n },
      lb: { num: 45359237n, den: 100000000n }, // 1 lb = 0.45359237 kg, exactly
    },
  },
  time: {
    base: 'days',
    units: {
      days: { num: 1n, den: 1n },
    },
  },
};

const DIMENSION: CuratedNumberConstraints = { min: '0', minExclusive: true, max: '9999999' };

export const CURATED_FIELD_REGISTRY: readonly CuratedFieldEntry[] = Object.freeze([
  {
    key: 'material',
    type: ProductFieldType.TEXT,
    label: 'Material',
    group: 'materials',
    sortOrder: 10,
    unit: null,
    unitFamily: null,
    applicability: 'BOTH',
    childOverrideAllowed: true,
    maxLength: 500,
  },
  {
    key: 'width',
    type: ProductFieldType.NUMBER,
    label: 'Width',
    group: 'dimensions',
    sortOrder: 20,
    unit: 'cm',
    unitFamily: 'length',
    applicability: 'BOTH',
    childOverrideAllowed: true,
    number: DIMENSION,
  },
  {
    key: 'height',
    type: ProductFieldType.NUMBER,
    label: 'Height',
    group: 'dimensions',
    sortOrder: 30,
    unit: 'cm',
    unitFamily: 'length',
    applicability: 'BOTH',
    childOverrideAllowed: true,
    number: DIMENSION,
  },
  {
    key: 'depth',
    type: ProductFieldType.NUMBER,
    label: 'Depth',
    group: 'dimensions',
    sortOrder: 40,
    unit: 'cm',
    unitFamily: 'length',
    applicability: 'BOTH',
    childOverrideAllowed: true,
    number: DIMENSION,
  },
  {
    key: 'length',
    type: ProductFieldType.NUMBER,
    label: 'Length',
    group: 'dimensions',
    sortOrder: 50,
    unit: 'cm',
    unitFamily: 'length',
    applicability: 'BOTH',
    childOverrideAllowed: true,
    number: DIMENSION,
  },
  {
    key: 'diameter',
    type: ProductFieldType.NUMBER,
    label: 'Diameter',
    group: 'dimensions',
    sortOrder: 60,
    unit: 'cm',
    unitFamily: 'length',
    applicability: 'BOTH',
    childOverrideAllowed: true,
    number: DIMENSION,
  },
  {
    key: 'weight',
    type: ProductFieldType.NUMBER,
    label: 'Weight',
    group: 'dimensions',
    sortOrder: 70,
    unit: 'kg',
    unitFamily: 'mass',
    applicability: 'BOTH',
    childOverrideAllowed: true,
    number: DIMENSION,
  },
  {
    key: 'finish',
    type: ProductFieldType.TEXT,
    label: 'Finish',
    group: 'materials',
    sortOrder: 80,
    unit: null,
    unitFamily: null,
    applicability: 'BOTH',
    childOverrideAllowed: true,
    maxLength: 500,
  },
  {
    key: 'color',
    type: ProductFieldType.TEXT,
    label: 'Color',
    group: 'materials',
    sortOrder: 90,
    unit: null,
    unitFamily: null,
    applicability: 'CHILD',
    childOverrideAllowed: true,
    maxLength: 200,
  },
  {
    key: 'upholstery',
    type: ProductFieldType.TEXT,
    label: 'Upholstery',
    group: 'materials',
    sortOrder: 100,
    unit: null,
    unitFamily: null,
    applicability: 'BOTH',
    childOverrideAllowed: true,
    maxLength: 500,
  },
  {
    key: 'designer',
    type: ProductFieldType.TEXT,
    label: 'Designer',
    group: 'design',
    sortOrder: 110,
    unit: null,
    unitFamily: null,
    applicability: 'PARENT',
    childOverrideAllowed: false,
    maxLength: 200,
  },
  {
    key: 'lead-time',
    type: ProductFieldType.NUMBER,
    label: 'Lead time',
    group: 'logistics',
    sortOrder: 120,
    unit: 'days',
    unitFamily: 'time',
    applicability: 'BOTH',
    childOverrideAllowed: true,
    number: { min: '0', max: '3650', integer: true },
  },
  {
    key: 'country',
    type: ProductFieldType.TEXT,
    label: 'Country of origin',
    group: 'general',
    sortOrder: 130,
    unit: null,
    unitFamily: null,
    applicability: 'PARENT',
    childOverrideAllowed: false,
    maxLength: 120,
  },
  {
    key: 'care',
    type: ProductFieldType.TEXT,
    label: 'Care instructions',
    group: 'care',
    sortOrder: 140,
    unit: null,
    unitFamily: null,
    applicability: 'BOTH',
    childOverrideAllowed: true,
    maxLength: 2000,
  },
  {
    key: 'warranty',
    type: ProductFieldType.TEXT,
    label: 'Warranty',
    group: 'care',
    sortOrder: 150,
    unit: null,
    unitFamily: null,
    applicability: 'BOTH',
    childOverrideAllowed: true,
    maxLength: 1000,
  },
  {
    key: 'awards',
    type: ProductFieldType.TEXT,
    label: 'Awards',
    group: 'design',
    sortOrder: 160,
    unit: null,
    unitFamily: null,
    applicability: 'PARENT',
    childOverrideAllowed: false,
    maxLength: 1000,
  },
  {
    key: 'technical-characteristics',
    type: ProductFieldType.TEXT,
    label: 'Technical characteristics',
    group: 'general',
    sortOrder: 170,
    unit: null,
    unitFamily: null,
    applicability: 'BOTH',
    childOverrideAllowed: true,
    maxLength: 4000,
  },
]);

const BY_KEY = new Map(CURATED_FIELD_REGISTRY.map((entry) => [entry.key, entry]));

export function curatedFieldByKey(key: string): CuratedFieldEntry | null {
  return BY_KEY.get(key) ?? null;
}

/** Units a curated entry may present. Canonical is always allowed. */
export function allowedUnitsFor(entry: CuratedFieldEntry): string[] {
  if (!entry.unitFamily) return entry.unit ? [entry.unit] : [];
  return Object.keys(UNIT_FAMILIES[entry.unitFamily].units);
}

/** Values are numeric(18,6): six fractional digits, canonical strings. */
const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** Parses a canonical decimal string into a scaled BigInt (value * 10^6). */
function toScaled(value: string): bigint {
  const negative = value.startsWith('-');
  const [intPart, fracPart = ''] = value.replace(/^-/, '').split('.');
  const scaled = BigInt(intPart) * SCALE_FACTOR + BigInt(fracPart.padEnd(SCALE, '0').slice(0, SCALE));
  return negative ? -scaled : scaled;
}

/** Renders a scaled BigInt back to a canonical decimal string. */
function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = (abs / SCALE_FACTOR).toString();
  const fracPart = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const magnitude = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

/** Numeric comparison of two canonical decimal strings, without floats. */
export function compareDecimal(a: string, b: string): number {
  const sa = toScaled(a);
  const sb = toScaled(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** True when a canonical decimal string is a whole number. */
export function isWholeDecimal(value: string): boolean {
  return toScaled(value) % SCALE_FACTOR === 0n;
}

/**
 * Converts a canonical decimal value between two units of one family, using
 * exact rational arithmetic; only the FINAL result is rounded (half-up) to
 * the serialized scale of six fractional digits.
 */
export function convertUnitValue(value: string, fromUnit: string, toUnit: string, familyName: string): string {
  if (fromUnit === toUnit) return value;
  const family = UNIT_FAMILIES[familyName];
  if (!family) throw new Error(`Unknown unit family: ${familyName}`);
  const from = family.units[fromUnit];
  const to = family.units[toUnit];
  if (!from || !to) throw new Error(`Unit outside family ${familyName}: ${fromUnit} -> ${toUnit}`);

  // value * (from.num/from.den) / (to.num/to.den), rounded half-up at scale.
  const scaled = toScaled(value);
  const numerator = scaled * from.num * to.den;
  const denominator = from.den * to.num;
  const sign = numerator < 0n ? -1n : 1n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const rounded = sign * ((2n * absNumerator + denominator) / (2n * denominator));
  return fromScaled(rounded);
}
