import {
  DEFAULT_SEVERITY,
  Issue,
  MAX_EXAMPLES,
  acknowledge,
  canExecute,
  describeAnchor,
  groupIssues,
  issue,
  summarize,
} from '../issue-taxonomy';

describe('severity is a decision, held in one place', () => {
  it('blocks the things that would corrupt data', () => {
    // A duplicate identity inside one file is the case the database cannot
    // catch until it is already too late: the second row overwrites the first,
    // or the batch fails halfway through leaving the import partly applied.
    expect(DEFAULT_SEVERITY.DUPLICATE_IDENTITY_IN_FILE).toBe('BLOCKING');
    expect(DEFAULT_SEVERITY.REQUIRED_FIELD_UNMAPPED).toBe('BLOCKING');
    expect(DEFAULT_SEVERITY.DUPLICATE_FIELD_MAPPING).toBe('BLOCKING');
    expect(DEFAULT_SEVERITY.TARGET_CHANGED_SINCE_ANALYSIS).toBe('BLOCKING');
    expect(DEFAULT_SEVERITY.STORE_NOT_PERMITTED).toBe('BLOCKING');
  });

  it('warns about the things that are legal but occasionally a disaster', () => {
    expect(DEFAULT_SEVERITY.NAME_COLLIDES_WITH_EXISTING).toBe('WARNING');
    expect(DEFAULT_SEVERITY.AMBIGUOUS_MATCH).toBe('WARNING');
    expect(DEFAULT_SEVERITY.VALUE_NOT_PARSEABLE).toBe('WARNING');
  });

  it('merely mentions the things nobody should be stopped for', () => {
    expect(DEFAULT_SEVERITY.BLANK_ROWS_SKIPPED).toBe('INFORMATIONAL');
    expect(DEFAULT_SEVERITY.RAGGED_ROWS).toBe('INFORMATIONAL');
    // An unmapped column is a choice, not a fault. The real export has 45
    // columns and most imports will want a handful of them.
    expect(DEFAULT_SEVERITY.COLUMN_UNMAPPED).toBe('INFORMATIONAL');
  });

  it('gives every code a severity, so none can be raised without one', () => {
    for (const [code, severity] of Object.entries(DEFAULT_SEVERITY)) {
      expect(['BLOCKING', 'WARNING', 'INFORMATIONAL']).toContain(severity);
      expect(code).not.toBe('');
    }
  });
});

describe('findings carry where they came from', () => {
  it('anchors a value problem to a sheet, row and column', () => {
    const finding = issue('VALUE_NOT_PARSEABLE', 'The price "call us" is not a number.', {
      anchor: { sheet: 'Productos', row: 42, column: 'Precio' },
      guidance: 'Enter a number, or leave the cell blank to keep the existing price.',
    });
    expect(finding.severity).toBe('WARNING');
    expect(describeAnchor(finding.anchor)).toBe('sheet "Productos", row 42, column "Precio"');
  });

  it('falls back to a cell reference when that is all there is', () => {
    expect(describeAnchor({ cellRef: 'Sheet1!C42' })).toBe('Sheet1!C42');
  });

  it('says nothing rather than something empty when there is no anchor', () => {
    expect(describeAnchor(undefined)).toBe('');
  });

  it('lets a caller raise a code at a different severity when it knows better', () => {
    // Context can change the stakes: a blank price is informational for a
    // catalogue refresh and blocking for a first import.
    const finding = issue('REQUIRED_VALUE_BLANK', 'No price.', { severity: 'WARNING' });
    expect(finding.severity).toBe('WARNING');
  });
});

describe('deciding whether an import may run', () => {
  const blocking = issue('REQUIRED_FIELD_UNMAPPED', 'Name is not mapped.');
  const warning = issue('NAME_COLLIDES_WITH_EXISTING', 'Six products share this name.');
  const info = issue('BLANK_ROWS_SKIPPED', '40 blank rows will be skipped.');

  it('allows a clean plan', () => {
    expect(canExecute([info])).toEqual({ allowed: true });
  });

  it('refuses while anything is blocking', () => {
    const decision = canExecute([blocking, info]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/One problem must be fixed/);
  });

  it('counts blocking problems in the reason', () => {
    expect(canExecute([blocking, blocking]).reason).toMatch(/2 problems must be fixed/);
  });

  it('refuses while a warning is unreviewed', () => {
    // The import is not wrong, it is unreviewed — and proceeding without the
    // review is how someone discovers afterwards that six products merged.
    const decision = canExecute([warning]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/needs your confirmation/);
  });

  it('proceeds once the warning has been acknowledged', () => {
    const acknowledged = acknowledge([warning], ['NAME_COLLIDES_WITH_EXISTING']);
    expect(canExecute(acknowledged)).toEqual({ allowed: true });
  });

  it('NEVER lets a blocking issue be acknowledged away', () => {
    // Otherwise severity is a suggestion, and the first time anyone is in a
    // hurry it gets waved through.
    const attempted = acknowledge([blocking], ['REQUIRED_FIELD_UNMAPPED']);
    expect(attempted[0].acknowledged).toBeUndefined();
    expect(canExecute(attempted).allowed).toBe(false);
  });

  it('only acknowledges the codes it was asked to', () => {
    const other = issue('AMBIGUOUS_MATCH', 'Two products claim this code.');
    const result = acknowledge([warning, other], ['NAME_COLLIDES_WITH_EXISTING']);
    expect(result[0].acknowledged).toBe(true);
    expect(result[1].acknowledged).toBeUndefined();
  });
});

describe('summarising', () => {
  it('counts each severity and the warnings still outstanding', () => {
    const issues: Issue[] = [
      issue('REQUIRED_FIELD_UNMAPPED', 'a'),
      issue('NAME_COLLIDES_WITH_EXISTING', 'b'),
      { ...issue('AMBIGUOUS_MATCH', 'c'), acknowledged: true },
      issue('BLANK_ROWS_SKIPPED', 'd'),
    ];
    expect(summarize(issues)).toEqual({
      blocking: 1,
      warning: 2,
      informational: 1,
      unacknowledgedWarnings: 1,
      total: 4,
    });
  });

  it('handles an empty set without special-casing at the call site', () => {
    expect(summarize([])).toEqual({
      blocking: 0,
      warning: 0,
      informational: 0,
      unacknowledgedWarnings: 0,
      total: 0,
    });
  });
});

describe('grouping, so eight hundred rows read as one problem', () => {
  const manyBadPrices = Array.from({ length: 800 }, (_, i) =>
    issue('VALUE_NOT_PARSEABLE', 'The price is not a number.', {
      anchor: { sheet: 'Productos', row: i + 2, column: 'Precio' },
    }),
  );

  it('collapses repeats and reports the scale', () => {
    const [group] = groupIssues(manyBadPrices);
    expect(group.count).toBe(800);
    expect(group.code).toBe('VALUE_NOT_PARSEABLE');
  });

  it('keeps a few anchors to click and counts the rest', () => {
    const [group] = groupIssues(manyBadPrices);
    expect(group.examples).toHaveLength(MAX_EXAMPLES);
    expect(group.examples[0]).toMatchObject({ row: 2, column: 'Precio' });
  });

  it('keeps the same code in different columns apart', () => {
    // An unparseable price and an unparseable weight are different problems
    // with different fixes, even though they share a code.
    const groups = groupIssues([
      issue('VALUE_NOT_PARSEABLE', 'bad price', { anchor: { column: 'Precio' } }),
      issue('VALUE_NOT_PARSEABLE', 'bad weight', { anchor: { column: 'Peso' } }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('shows the most serious first, then the most numerous', () => {
    const groups = groupIssues([
      ...manyBadPrices,
      issue('BLANK_ROWS_SKIPPED', 'blank rows'),
      issue('REQUIRED_FIELD_UNMAPPED', 'Name is not mapped.'),
    ]);
    expect(groups[0].severity).toBe('BLOCKING');
    expect(groups[1].code).toBe('VALUE_NOT_PARSEABLE');
    expect(groups[2].severity).toBe('INFORMATIONAL');
  });

  it('only calls a group acknowledged when EVERY member is', () => {
    // Acknowledging one row must not silence the other seven hundred.
    const partly = [
      { ...issue('VALUE_NOT_PARSEABLE', 'x', { anchor: { column: 'Precio' } }), acknowledged: true },
      issue('VALUE_NOT_PARSEABLE', 'x', { anchor: { column: 'Precio' } }),
    ];
    expect(groupIssues(partly)[0].acknowledged).toBe(false);

    const fully = partly.map((i) => ({ ...i, acknowledged: true }));
    expect(groupIssues(fully)[0].acknowledged).toBe(true);
  });

  it('carries the guidance through, since that is the actionable part', () => {
    const groups = groupIssues([
      issue('VALUE_NOT_PARSEABLE', 'bad', { guidance: 'Enter a number or leave it blank.' }),
    ]);
    expect(groups[0].guidance).toBe('Enter a number or leave it blank.');
  });

  it('returns nothing for nothing', () => {
    expect(groupIssues([])).toEqual([]);
  });
});
