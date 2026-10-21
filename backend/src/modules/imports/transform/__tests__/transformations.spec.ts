import { SUPPORTED_TRANSFORMATIONS, Transformation, applyTransformations, validateChain } from '../transformations';

const apply = (value: string | null, chain: Transformation[]) => applyTransformations(value, chain);

describe('the operation set is closed', () => {
  it('exposes only named operations, never an expression', () => {
    // A transformation is stored in a plan, hashed into an approval and re-run
    // days later by another process. An expression evaluator would make that
    // approval meaningless and would be a code-execution surface reachable by
    // anyone who can upload a spreadsheet.
    expect(SUPPORTED_TRANSFORMATIONS).toEqual(
      expect.arrayContaining(['TRIM', 'PARSE_DECIMAL', 'PARSE_BOOLEAN', 'MAP_VALUES']),
    );
    expect(SUPPORTED_TRANSFORMATIONS.some((k) => /EVAL|SCRIPT|EXPR|FUNCTION|REGEX/i.test(k))).toBe(false);
  });

  it('refuses a chain naming an operation this version cannot perform', () => {
    const chain = [{ kind: 'RUN_SCRIPT' as never }];
    expect(validateChain(chain)).toHaveLength(1);

    // And refuses it at apply time too, because a plan approved by one
    // deployment may be executed by another.
    const result = apply('x', chain);
    expect(result.problems[0].message).toMatch(/does not know the operation/);
  });

  it('accepts a chain of known operations', () => {
    expect(validateChain([{ kind: 'TRIM' }, { kind: 'UPPERCASE' }])).toEqual([]);
  });
});

describe('text cleaning', () => {
  it('trims and collapses without destroying interior meaning', () => {
    const result = apply('  Blue   Cotton  Shirt ', [{ kind: 'COLLAPSE_WHITESPACE' }]);
    expect(result.value).toBe('Blue Cotton Shirt');
  });

  it('reports what it did, so original and normalized can be shown side by side', () => {
    const result = apply('  abc  ', [{ kind: 'TRIM' }, { kind: 'UPPERCASE' }]);
    expect(result.value).toBe('ABC');
    expect(result.steps).toEqual(['trimmed surrounding whitespace', 'converted to upper case']);
  });

  it('says nothing when a step changed nothing', () => {
    // A step list full of no-ops would train people to stop reading it.
    expect(apply('ABC', [{ kind: 'TRIM' }, { kind: 'UPPERCASE' }]).steps).toEqual([]);
  });

  it('replaces literally, never as a pattern', () => {
    // A tenant-supplied regular expression is both a denial-of-service surface
    // and impossible for an approver to reason about.
    const result = apply('a.b.c', [{ kind: 'REPLACE_LITERAL', options: { search: '.', replacement: '-' } }]);
    expect(result.value).toBe('a-b-c');
  });

  it('pads to a fixed width for codes that lost their leading zeros', () => {
    // Spreadsheets do this constantly: 00123 becomes 123 on open.
    const result = apply('123', [{ kind: 'PAD_START', options: { length: 5, fill: '0' } }]);
    expect(result.value).toBe('00123');
  });

  it('leaves a value already long enough alone', () => {
    expect(apply('123456', [{ kind: 'PAD_START', options: { length: 5 } }]).value).toBe('123456');
  });
});

describe('numbers', () => {
  it('reads a European decimal with grouping', () => {
    const result = apply('1.234,50 €', [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }]);
    expect(result.value).toBe(1234.5);
  });

  it('reads an English decimal with grouping', () => {
    const result = apply('$1,234.50', [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: '.' } }]);
    expect(result.value).toBe(1234.5);
  });

  it('uses the separator it was TOLD, never one it guessed', () => {
    // "2,5" is 2.5 in Spain and 25 in the US. The mapping states which, because
    // guessing from a process locale would make the same file import
    // differently on different machines.
    expect(apply('2,5', [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }]).value).toBe(2.5);
    expect(apply('2,5', [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: '.' } }]).value).toBe(25);
  });

  it('keeps a negative sign', () => {
    expect(apply('-19,99', [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }]).value).toBe(-19.99);
  });

  it('treats a blank as absent rather than as zero', () => {
    // Zero is a price. Absent is not, and conflating them would silently make
    // every unpriced product free.
    const result = apply('', [{ kind: 'PARSE_DECIMAL' }]);
    expect(result.value).toBeNull();
    expect(result.problems).toEqual([]);
  });

  it('reports an unparseable number instead of inventing one', () => {
    const result = apply('call for price', [{ kind: 'PARSE_DECIMAL' }]);
    expect(result.value).toBeNull();
    expect(result.problems[0].message).toMatch(/is not a number/);
  });

  it('refuses a decimal where a whole number was required', () => {
    // Emphatically NOT by stripping the separator: that would read 12.5 as 125
    // and multiply a stock quantity by ten without anyone noticing.
    const result = apply('12.5', [{ kind: 'PARSE_INTEGER' }]);
    expect(result.value).toBeNull();
    expect(result.problems[0].message).toMatch(/not a whole number/);
    expect(apply('12,5', [{ kind: 'PARSE_INTEGER' }]).value).toBeNull();
  });

  it('still reads a grouped integer as the integer it is', () => {
    // "1,234" and "1.234" are both 1234: a separator followed by exactly three
    // digits is grouping, not a fraction.
    expect(apply('1,234', [{ kind: 'PARSE_INTEGER' }]).value).toBe(1234);
    expect(apply('1.234.567', [{ kind: 'PARSE_INTEGER' }]).value).toBe(1234567);
    expect(apply('-42', [{ kind: 'PARSE_INTEGER' }]).value).toBe(-42);
  });
});

describe('booleans', () => {
  it('accepts the yes and no words these exports actually contain', () => {
    for (const yes of ['yes', 'Y', 'true', '1', 'Sí', 'si', 'X']) {
      expect(apply(yes, [{ kind: 'PARSE_BOOLEAN' }]).value).toBe(true);
    }
    for (const no of ['no', 'N', 'false', '0', 'falso']) {
      expect(apply(no, [{ kind: 'PARSE_BOOLEAN' }]).value).toBe(false);
    }
  });

  it('REFUSES a word it does not recognise rather than defaulting', () => {
    // Treating any non-empty string as true would publish every product whose
    // "Published" column said "Pendiente".
    const result = apply('Pendiente', [{ kind: 'PARSE_BOOLEAN' }]);
    expect(result.value).toBeNull();
    expect(result.problems[0].message).toMatch(/neither a yes nor a no/);
  });
});

describe('dates', () => {
  it('uses the stated order rather than the machine locale', () => {
    // 03/04/2026 is 3 April in Madrid and 4 March in New York. `new Date()`
    // would resolve it differently depending on where the process runs, which
    // is intolerable for a value written to a customer's sales history.
    expect(apply('03/04/2026', [{ kind: 'PARSE_DATE', options: { order: 'DMY' } }]).value).toBe('2026-04-03');
    expect(apply('03/04/2026', [{ kind: 'PARSE_DATE', options: { order: 'MDY' } }]).value).toBe('2026-03-04');
  });

  it('accepts an ISO date whatever the stated order', () => {
    expect(apply('2026-04-03', [{ kind: 'PARSE_DATE', options: { order: 'MDY' } }]).value).toBe('2026-04-03');
  });

  it('rejects a day that does not exist instead of rolling it forward', () => {
    // 31 February must be an error, not 3 March.
    const result = apply('31/02/2026', [{ kind: 'PARSE_DATE', options: { order: 'DMY' } }]);
    expect(result.value).toBeNull();
    expect(result.problems[0].message).toMatch(/not a date/);
  });

  it('returns a plain ISO string so no timezone can shift it', () => {
    const value = apply('15/06/2026', [{ kind: 'PARSE_DATE', options: { order: 'DMY' } }]).value;
    expect(value).toBe('2026-06-15');
    expect(typeof value).toBe('string');
  });
});

describe('lists and mappings', () => {
  it('splits a delimited cell and drops the empties', () => {
    const result = apply('Red, Blue , , Green', [{ kind: 'SPLIT_LIST', options: { separator: ',' } }]);
    expect(result.value).toEqual(['Red', 'Blue', 'Green']);
  });

  it('gives an empty list for a blank cell, not a list containing a blank', () => {
    expect(apply('   ', [{ kind: 'SPLIT_LIST' }]).value).toEqual([]);
  });

  it('maps values case-insensitively', () => {
    // A mapping table written by hand will not match the file's casing, and
    // failing on that helps nobody.
    const chain: Transformation[] = [{ kind: 'MAP_VALUES', options: { mapping: { Activo: 'PUBLISHED' } } }];
    expect(apply('activo', chain).value).toBe('PUBLISHED');
  });

  it('reports an unmapped value rather than passing it through by default', () => {
    const chain: Transformation[] = [{ kind: 'MAP_VALUES', options: { mapping: { Activo: 'PUBLISHED' } } }];
    const result = apply('Borrador', chain);
    expect(result.problems[0].message).toMatch(/not one of the values you mapped/);
  });

  it('passes an unmapped value through when that was explicitly chosen', () => {
    const chain: Transformation[] = [
      { kind: 'MAP_VALUES', options: { mapping: { Activo: 'PUBLISHED' }, passThroughUnmapped: true } },
    ];
    expect(apply('Borrador', chain).value).toBe('Borrador');
    expect(apply('Borrador', chain).problems).toEqual([]);
  });
});

describe('chains', () => {
  it('runs steps in the declared order', () => {
    // TRIM then PARSE_DECIMAL is a different mapping from the reverse, which is
    // why the order is stored and hashed rather than normalized away.
    const result = apply(' 1.234,50 ', [
      { kind: 'TRIM' },
      { kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } },
    ]);
    expect(result.value).toBe(1234.5);
  });

  it('STOPS at the first failing step', () => {
    // Continuing would apply later operations to a value the earlier step
    // already said it could not produce, and the second error would bury the
    // first.
    const result = apply('not a number', [{ kind: 'PARSE_DECIMAL' }, { kind: 'PAD_START', options: { length: 8 } }]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].kind).toBe('PARSE_DECIMAL');
    expect(result.value).toBeNull();
  });

  it('fills a blank before parsing, when that is what was asked', () => {
    const result = apply('', [{ kind: 'DEFAULT_IF_BLANK', options: { value: '0' } }, { kind: 'PARSE_DECIMAL' }]);
    expect(result.value).toBe(0);
  });

  it('is a no-op for an empty chain', () => {
    const result = apply('untouched', []);
    expect(result.value).toBe('untouched');
    expect(result.steps).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});

describe('determinism', () => {
  it('produces the same result for the same input, every time', () => {
    // The property the whole design rests on: a plan approved today must do the
    // same thing when executed by another process tomorrow.
    const chain: Transformation[] = [
      { kind: 'TRIM' },
      { kind: 'COLLAPSE_WHITESPACE' },
      { kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } },
    ];
    const first = apply('  1.999,95  ', chain);
    for (let i = 0; i < 25; i++) {
      expect(apply('  1.999,95  ', chain)).toEqual(first);
    }
  });

  it('reads no clock, locale, environment or random source', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'transformations.ts'), 'utf8');
    expect(source).not.toMatch(/Math\.random|Date\.now\(\)|process\.env|toLocaleString|Intl\./);
    // `new Date(Date.UTC(...))` is used for days-in-month, which is a pure
    // calendar fact rather than a reading of the current time.
    expect(source).not.toMatch(/new Date\(\)/);
  });

  it('never throws, whatever it is handed', () => {
    // A transformation that throws turns a data problem into a crashed batch.
    const hostile: (string | null)[] = ['', '   ', ' ', '𝕏'.repeat(500), null, '-', ',', '.', '1e999'];
    for (const value of hostile) {
      for (const kind of SUPPORTED_TRANSFORMATIONS) {
        expect(() => applyTransformations(value, [{ kind }])).not.toThrow();
      }
    }
  });
});
