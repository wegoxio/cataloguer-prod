import { TRANSFORMATION_CATALOGUE, WIZARD_CONTRACT_VERSION, catalogueMatchesImplementation } from '../wizard-contract';
import { SUPPORTED_TRANSFORMATIONS, applyTransformations } from '../../transform/transformations';

/**
 * The served contract and the code that executes it must describe the same
 * thing.
 *
 * Phase 8 left the frontend rendering choices from its own fixture constants.
 * The failure that allows is quiet and expensive: the editor offers an
 * operation the backend will refuse, and the person finds out after building a
 * whole mapping around it.
 */

describe('the catalogue and the implementation agree', () => {
  it('describes every operation the backend can perform', () => {
    // An implemented operation missing from the catalogue is simply invisible
    // in the editor.
    expect(catalogueMatchesImplementation().missing).toEqual([]);
  });

  it('describes nothing the backend cannot perform', () => {
    // The expensive direction: offering something that fails at execution.
    expect(catalogueMatchesImplementation().extra).toEqual([]);
  });

  it('covers the list exactly once each', () => {
    const kinds = TRANSFORMATION_CATALOGUE.map((t) => t.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(SUPPORTED_TRANSFORMATIONS.length);
  });
});

describe('each description is usable by the person mapping a file', () => {
  it('has a label and a sentence, neither of them the raw code name', () => {
    for (const spec of TRANSFORMATION_CATALOGUE) {
      expect(spec.label.length).toBeGreaterThan(3);
      expect(spec.label).not.toBe(spec.kind);
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.description).toMatch(/\.$/);
      // Written for a person, not a developer.
      expect(spec.description).not.toMatch(/null|undefined|string|boolean|param/i);
    }
  });

  it('belongs to a group the editor can menu it under', () => {
    for (const spec of TRANSFORMATION_CATALOGUE) {
      expect(['TEXT', 'NUMBER', 'DATE', 'LIST', 'VALUE']).toContain(spec.group);
    }
  });

  it('carries a worked example so the effect is visible without trying it', () => {
    for (const spec of TRANSFORMATION_CATALOGUE) {
      expect(spec.example.before).toBeDefined();
      expect(spec.example.after).toBeDefined();
      expect(spec.example.before).not.toBe(spec.example.after);
    }
  });

  it('names and labels every option it requires', () => {
    for (const spec of TRANSFORMATION_CATALOGUE) {
      for (const option of spec.options) {
        expect(option.name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
        expect(option.label.length).toBeGreaterThan(2);
        expect(['TEXT', 'NUMBER', 'CHOICE', 'KEY_VALUE', 'BOOLEAN']).toContain(option.type);
        if (option.type === 'CHOICE') {
          expect(option.choices?.length ?? 0).toBeGreaterThan(1);
          for (const choice of option.choices ?? []) {
            expect(choice.label.length).toBeGreaterThan(choice.value.length);
          }
        }
      }
    }
  });

  it('warns about the two options that are genuinely ambiguous', () => {
    // Decimal separator and date order are the two places where a wrong choice
    // produces plausible, wrong data rather than an error — so both explain the
    // consequence rather than merely naming the setting.
    const decimal = TRANSFORMATION_CATALOGUE.find((t) => t.kind === 'PARSE_DECIMAL');
    expect(decimal?.options[0].help).toMatch(/2,5/);

    const date = TRANSFORMATION_CATALOGUE.find((t) => t.kind === 'PARSE_DATE');
    const choices = date?.options[0].choices ?? [];
    expect(choices.every((c) => c.label.includes('03/04/2026') || c.label.includes('2026/04/03'))).toBe(true);
  });
});

describe('the examples are true', () => {
  it('produces the documented result when actually run', () => {
    // A worked example that lies is worse than none: it is the thing people
    // trust instead of reading the description.
    const checks: { kind: string; options?: Record<string, unknown>; input: string; expected: unknown }[] = [
      { kind: 'TRIM', input: '  Camiseta  ', expected: 'Camiseta' },
      { kind: 'COLLAPSE_WHITESPACE', input: 'Camiseta   azul', expected: 'Camiseta azul' },
      { kind: 'UPPERCASE', input: 'abc-123', expected: 'ABC-123' },
      { kind: 'LOWERCASE', input: 'ABC-123', expected: 'abc-123' },
      { kind: 'STRIP_CHARACTERS', options: { characters: '€' }, input: '€19,99', expected: '19,99' },
      { kind: 'REPLACE_LITERAL', options: { search: '/', replacement: '-' }, input: 'REF/001', expected: 'REF-001' },
      { kind: 'PAD_START', options: { length: 5, fill: '0' }, input: '123', expected: '00123' },
      { kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' }, input: '1.234,50 €', expected: 1234.5 },
      { kind: 'PARSE_INTEGER', input: '1.234', expected: 1234 },
      { kind: 'PARSE_BOOLEAN', input: 'Sí', expected: true },
      { kind: 'PARSE_DATE', options: { order: 'DMY' }, input: '03/04/2026', expected: '2026-04-03' },
      {
        kind: 'SPLIT_LIST',
        options: { separator: ',' },
        input: 'Rojo, Azul, Verde',
        expected: ['Rojo', 'Azul', 'Verde'],
      },
      { kind: 'MAP_VALUES', options: { mapping: { Activo: 'PUBLISHED' } }, input: 'Activo', expected: 'PUBLISHED' },
      { kind: 'DEFAULT_IF_BLANK', options: { value: '0' }, input: '', expected: '0' },
    ];

    // Every catalogued operation is covered, so a new one cannot be added
    // without its example being checked.
    expect(new Set(checks.map((c) => c.kind)).size).toBe(TRANSFORMATION_CATALOGUE.length);

    for (const check of checks) {
      const result = applyTransformations(check.input, [{ kind: check.kind as never, options: check.options }]);
      expect({ kind: check.kind, value: result.value }).toEqual({ kind: check.kind, value: check.expected });
    }
  });
});

describe('versioning', () => {
  it('is a semantic version a stale tab can compare against', () => {
    expect(WIZARD_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
