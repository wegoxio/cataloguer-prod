import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, click, select as selectOption, cleanupAll } from '../../../../test/render';
import { EditorShell } from './editor-shell';
import { MappingRegion, describeConfidence } from './mapping-region';
import { IssuesRegion, describeAnchor } from './issues-region';
import { ResultRegion } from './result-region';
import { SourceRegion } from './source-region';
import type { ColumnMapping, GroupedIssue, PreviewResponse, WizardContract } from '../api/wizard-contract.types';

/**
 * The four regions, tested for what makes them usable rather than merely
 * present: that every control is reachable and named, that a proposal can be
 * checked, and that a blocking problem cannot be waved through.
 *
 * Accessibility assertions query by role and accessible name, because there the
 * name IS the behaviour — a control a screen reader cannot announce is a
 * control that does not work, however well it renders.
 */

afterEach(() => cleanupAll());

const CONTRACT: WizardContract = {
  version: '1.0.0',
  supportedTransformations: ['TRIM', 'PARSE_DECIMAL'],
  issueSeverities: {},
  transformations: [
    {
      kind: 'TRIM',
      label: 'Remove surrounding spaces',
      description: 'Removes spaces from the start and end of the value.',
      group: 'TEXT',
      options: [],
      example: { before: '  Camiseta  ', after: 'Camiseta' },
    },
    {
      kind: 'PARSE_DECIMAL',
      label: 'Read as a number with decimals',
      description: 'Reads a price, ignoring currency symbols.',
      group: 'NUMBER',
      options: [
        {
          name: 'decimalSeparator',
          type: 'CHOICE',
          label: 'Decimal separator',
          required: true,
          default: ',',
          choices: [
            { value: ',', label: 'Comma — 1.234,50' },
            { value: '.', label: 'Full stop — 1,234.50' },
          ],
          help: '"2,5" means two and a half with a comma, and twenty-five with a full stop.',
        },
      ],
      example: { before: '1.234,50 €', after: '1234.5' },
    },
  ],
};

const FIELD_OPTIONS = [
  { value: 'name', label: 'Name', required: true },
  { value: 'price', label: 'Price' },
  { value: 'cost', label: 'Cost' },
];

const COLUMNS: ColumnMapping[] = [
  { columnIndex: 0, header: 'Nombre', field: 'name', confidence: 0.95, reasons: ['the heading matches exactly'] },
  { columnIndex: 1, header: 'Precio', field: 'price', confidence: 0.55, reasons: ['the values look like money'] },
  { columnIndex: 2, header: 'Notas', field: null },
];

const noop = () => undefined;

const mappingProps = {
  columns: COLUMNS,
  fieldOptions: FIELD_OPTIONS,
  contract: CONTRACT,
  focusedColumnIndex: null as number | null,
  onFocusColumn: noop,
  onAssignField: noop,
  onIgnoreColumn: noop,
  onAddTransformation: noop,
  onRemoveTransformation: noop,
  onMoveTransformation: noop,
  onSetOption: noop,
};

/** The accessible name of a labelled control, as a screen reader would read it. */
function labelOf(container: HTMLElement, id: string): string {
  const label = container.querySelector(`label[for="${id}"]`);
  return (label?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function controlLabelled(container: HTMLElement, pattern: RegExp): HTMLElement | null {
  const labels = Array.from(container.querySelectorAll('label'));
  const match = labels.find((l) => pattern.test((l.textContent ?? '').replace(/\s+/g, ' ').trim()));
  const forId = match?.getAttribute('for');
  return forId ? container.querySelector<HTMLElement>(`#${CSS.escape(forId)}`) : null;
}

function buttonNamed(container: HTMLElement, name: string): HTMLElement | null {
  return (
    container.querySelector<HTMLElement>(`button[aria-label="${name}"]`) ??
    Array.from(container.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === name,
    ) ??
    null
  );
}

describe('the four regions', () => {
  const regions = [
    { id: 'SOURCE' as const, label: 'Your file', content: <p>source</p> },
    { id: 'MAPPING' as const, label: 'Mapping', content: <p>mapping</p> },
    {
      id: 'ISSUES' as const,
      label: 'Issues',
      badge: { text: '2 warnings', tone: 'warning' as const },
      content: <p>issues</p>,
    },
    { id: 'RESULT' as const, label: 'Result', content: <p>result</p> },
  ];

  it('presents them as a real tablist, not styled divs', async () => {
    const { container } = await renderComponent(<EditorShell regions={regions} active="MAPPING" onActivate={noop} />);
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    expect(tablist?.getAttribute('aria-label')).toBe('Import mapping');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4);
  });

  it('marks exactly one tab selected and puts only that one in the tab order', async () => {
    const { container } = await renderComponent(<EditorShell regions={regions} active="MAPPING" onActivate={noop} />);
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    // Arrow keys move within the set; only the selected tab is a tab stop.
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '-1')).toHaveLength(3);
    const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.getAttribute('tabindex')).toBe('0');
  });

  it('moves between tabs with the arrow keys', async () => {
    const onActivate = vi.fn();
    const { container } = await renderComponent(
      <EditorShell regions={regions} active="MAPPING" onActivate={onActivate} />,
    );
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onActivate).toHaveBeenCalledWith('ISSUES');
  });

  it('wraps around, and Home and End jump to the ends', async () => {
    const onActivate = vi.fn();
    const { container } = await renderComponent(
      <EditorShell regions={regions} active="RESULT" onActivate={onActivate} />,
    );
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onActivate).toHaveBeenCalledWith('SOURCE');
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(onActivate).toHaveBeenCalledWith('SOURCE');
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(onActivate).toHaveBeenCalledWith('RESULT');
  });

  it('labels each panel by its tab', async () => {
    const { container } = await renderComponent(<EditorShell regions={regions} active="MAPPING" onActivate={noop} />);
    const panel = container.querySelector('#panel-MAPPING');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('tab-MAPPING');
  });

  it('keeps unselected panels mounted so nothing is lost when glancing away', async () => {
    // Unmounting would discard scroll position and any half-typed value every
    // time someone checks another region.
    const { container } = await renderComponent(<EditorShell regions={regions} active="MAPPING" onActivate={noop} />);
    const other = container.querySelector('#panel-ISSUES');
    expect(other).toBeTruthy();
    expect(other?.hasAttribute('hidden')).toBe(true);
  });

  it('shows a badge as words, never as a bare number', async () => {
    const { text } = await renderComponent(<EditorShell regions={regions} active="MAPPING" onActivate={noop} />);
    expect(text()).toContain('2 warnings');
  });
});

describe('the mapping region', () => {
  it('names every column control after the column it governs', async () => {
    // So a screen reader announces which "what should this become?" is which.
    const { container } = await renderComponent(<MappingRegion {...mappingProps} />);
    expect(labelOf(container, 'field-0')).toContain('Nombre');
    expect(labelOf(container, 'field-1')).toContain('Precio');
  });

  it('offers ignoring in the SAME control as mapping', async () => {
    // It is the same decision, not an afterthought reached through a separate
    // button somewhere else.
    const { container } = await renderComponent(<MappingRegion {...mappingProps} />);
    const select = container.querySelector('#field-2') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Do not import this column');
  });

  it('marks a column nobody has looked at', async () => {
    const { text } = await renderComponent(<MappingRegion {...mappingProps} />);
    expect(text()).toContain('Still needs a decision.');
  });

  it('shows confidence in words as well as a number', async () => {
    // "55%" alone invites someone to treat a coin-flip as a fact.
    const { text } = await renderComponent(<MappingRegion {...mappingProps} />);
    expect(text()).toContain('Uncertain — 55%, please check');
    expect(text()).toContain('Confident — 95%');
  });

  it('shows the reasons behind a proposal, so it can be checked', async () => {
    const { text } = await renderComponent(<MappingRegion {...mappingProps} />);
    expect(text()).toContain('the heading matches exactly');
  });

  it('warns when two columns claim the same field', async () => {
    const duplicated: ColumnMapping[] = [
      { columnIndex: 0, header: 'Precio', field: 'price' },
      { columnIndex: 1, header: 'PVP', field: 'price' },
    ];
    const { container } = await renderComponent(<MappingRegion {...mappingProps} columns={duplicated} />);
    const warnings = Array.from(container.querySelectorAll('p')).filter((p) =>
      (p.textContent ?? '').includes('Only one column can fill it'),
    );
    expect(warnings).toHaveLength(2);
  });

  it('assigns a field when one is chosen', async () => {
    const onAssignField = vi.fn();
    const { container } = await renderComponent(
      <MappingRegion {...mappingProps} onAssignField={onAssignField} />,
    );
    await selectOption(container.querySelector('#field-2'), 'cost');
    expect(onAssignField).toHaveBeenCalledWith(2, 'cost');
  });

  it('ignores a column when the empty choice is picked', async () => {
    const onIgnoreColumn = vi.fn();
    const { container } = await renderComponent(
      <MappingRegion {...mappingProps} onIgnoreColumn={onIgnoreColumn} />,
    );
    await selectOption(container.querySelector('#field-1'), '');
    expect(onIgnoreColumn).toHaveBeenCalledWith(1);
  });

  it('says so when there is no file yet', async () => {
    const { text } = await renderComponent(<MappingRegion {...mappingProps} columns={[]} />);
    expect(text()).toContain('Choose a file to see its columns');
  });

  describe('the clean-up steps', () => {
    const withChain: ColumnMapping[] = [
      {
        columnIndex: 1,
        header: 'Precio',
        field: 'price',
        transformations: [{ kind: 'TRIM' }, { kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }],
      },
    ];

    it('offers only what the SERVER says this build supports', async () => {
      // Offering a hardcoded list is the Phase 8 mistake: the editor would
      // promise something the deployment might not be able to do.
      const { container } = await renderComponent(
        <MappingRegion {...mappingProps} columns={withChain} focusedColumnIndex={1} />,
      );
      const add = container.querySelector('#add-step-1') as HTMLSelectElement;
      const labels = Array.from(add.options).map((o) => o.textContent);
      expect(labels).toContain('Remove surrounding spaces');
      expect(labels).not.toContain('Read as a date');
    });

    it('says it is loading rather than guessing before the contract arrives', async () => {
      const { text } = await renderComponent(
        <MappingRegion {...mappingProps} columns={withChain} contract={null} focusedColumnIndex={1} />,
      );
      expect(text()).toContain('Loading the available clean-up steps');
    });

    it('numbers the steps, because the order changes the result', async () => {
      const { text } = await renderComponent(
        <MappingRegion {...mappingProps} columns={withChain} focusedColumnIndex={1} />,
      );
      expect(text()).toContain('1. Remove surrounding spaces');
      expect(text()).toContain('2. Read as a number with decimals');
    });

    it('names each reorder button after the step it moves', async () => {
      const { container } = await renderComponent(
        <MappingRegion {...mappingProps} columns={withChain} focusedColumnIndex={1} />,
      );
      const earlier = buttonNamed(container, 'Move Remove surrounding spaces earlier') as HTMLButtonElement;
      const later = buttonNamed(container, 'Move Remove surrounding spaces later') as HTMLButtonElement;
      expect(earlier.disabled).toBe(true);
      expect(later.disabled).toBe(false);
    });

    it('moves a step when asked', async () => {
      const onMoveTransformation = vi.fn();
      const { container } = await renderComponent(
        <MappingRegion
          {...mappingProps}
          columns={withChain}
          focusedColumnIndex={1}
          onMoveTransformation={onMoveTransformation}
        />,
      );
      await click(buttonNamed(container, 'Move Read as a number with decimals earlier'));
      expect(onMoveTransformation).toHaveBeenCalledWith(1, 1, 0);
    });

    it('shows an option with its warning and a worked example', async () => {
      const { container, text } = await renderComponent(
        <MappingRegion {...mappingProps} columns={withChain} focusedColumnIndex={1} />,
      );
      expect(controlLabelled(container, /Decimal separator/)).toBeTruthy();
      expect(text()).toContain('two and a half with a comma');
      expect(text()).toContain('1.234,50 €');
    });

    it('flags a step this build cannot run instead of failing later', async () => {
      const unknown: ColumnMapping[] = [
        { columnIndex: 1, header: 'Fecha', field: 'price', transformations: [{ kind: 'PARSE_DATE' }] },
      ];
      const { text } = await renderComponent(
        <MappingRegion {...mappingProps} columns={unknown} focusedColumnIndex={1} />,
      );
      expect(text()).toContain('not available on this version');
    });

    it('refuses to clean up a column that is not going anywhere', async () => {
      const ignored: ColumnMapping[] = [{ columnIndex: 2, header: 'Notas', field: null, reviewed: true }];
      const { text } = await renderComponent(
        <MappingRegion {...mappingProps} columns={ignored} focusedColumnIndex={2} />,
      );
      expect(text()).toContain('Choose what this column becomes before cleaning up');
    });
  });
});

describe('confidence in words', () => {
  it('never presents a coin-flip as a fact', () => {
    expect(describeConfidence(0.95)).toMatch(/^Confident/);
    expect(describeConfidence(0.75)).toMatch(/^Fairly sure/);
    expect(describeConfidence(0.5)).toMatch(/please check/);
    expect(describeConfidence(0.1)).toMatch(/^A guess/);
    expect(describeConfidence(0.1)).toMatch(/please check/);
  });
});

describe('the issues region', () => {
  const blocking: GroupedIssue = {
    code: 'DUPLICATE_FIELD_MAPPING',
    severity: 'BLOCKING',
    message: 'Two columns are mapped to price.',
    guidance: 'Choose one and ignore the other.',
    count: 1,
    examples: [],
    acknowledged: false,
  };
  const warning: GroupedIssue = {
    code: 'VALUE_NOT_PARSEABLE',
    severity: 'WARNING',
    message: 'A price is not a number.',
    count: 800,
    examples: [{ sheet: 'Productos', row: 2, column: 'Precio' }],
    acknowledged: false,
  };
  const info: GroupedIssue = {
    code: 'BLANK_ROWS_SKIPPED',
    severity: 'INFORMATIONAL',
    message: '40 blank rows will be skipped.',
    count: 1,
    examples: [],
    acknowledged: false,
  };

  const issueProps = { acknowledged: [] as string[], onAcknowledge: noop, onUnacknowledge: noop };

  it('separates what must be fixed from what needs confirming', async () => {
    const { text } = await renderComponent(<IssuesRegion {...issueProps} issues={[blocking, warning, info]} />);
    expect(text()).toContain('Must be fixed');
    expect(text()).toContain('Needs your confirmation');
    expect(text()).toContain('For your information');
  });

  it('offers a confirmation checkbox for a warning', async () => {
    const { container } = await renderComponent(<IssuesRegion {...issueProps} issues={[warning]} />);
    expect(controlLabelled(container, /read this and want to continue/)).toBeTruthy();
  });

  it('offers NO checkbox for a blocking problem', async () => {
    // If blocking issues could be waved through, severity would be a
    // suggestion, and the first time anyone was in a hurry it would be.
    const { container, text } = await renderComponent(<IssuesRegion {...issueProps} issues={[blocking]} />);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(text()).toContain('has to be fixed in your file or your mapping');
  });

  it('states the scale, which is what tells a typo from a broken column', async () => {
    const { text } = await renderComponent(<IssuesRegion {...issueProps} issues={[warning]} />);
    expect(text()).toContain('Affects 800 rows.');
  });

  it('makes each example a place the person can go to', async () => {
    const onGoToAnchor = vi.fn();
    const { container } = await renderComponent(
      <IssuesRegion {...issueProps} issues={[warning]} onGoToAnchor={onGoToAnchor} />,
    );
    await click(buttonNamed(container, 'Productos · row 2 · Precio'));
    expect(onGoToAnchor).toHaveBeenCalledWith({ sheet: 'Productos', row: 2, column: 'Precio' });
  });

  it('says the examples are only the first few when there are more', async () => {
    const { text } = await renderComponent(<IssuesRegion {...issueProps} issues={[warning]} />);
    expect(text()).toContain('First few places:');
  });

  it('toggles an acknowledgement both ways', async () => {
    const onAcknowledge = vi.fn();
    const onUnacknowledge = vi.fn();
    const { container, rerender } = await renderComponent(
      <IssuesRegion
        issues={[warning]}
        acknowledged={[]}
        onAcknowledge={onAcknowledge}
        onUnacknowledge={onUnacknowledge}
      />,
    );
    await click(container.querySelector('input[type="checkbox"]'));
    expect(onAcknowledge).toHaveBeenCalledWith('VALUE_NOT_PARSEABLE');

    await rerender(
      <IssuesRegion
        issues={[warning]}
        acknowledged={['VALUE_NOT_PARSEABLE']}
        onAcknowledge={onAcknowledge}
        onUnacknowledge={onUnacknowledge}
      />,
    );
    await click(container.querySelector('input[type="checkbox"]'));
    expect(onUnacknowledge).toHaveBeenCalledWith('VALUE_NOT_PARSEABLE');
  });

  it('says plainly when there is nothing to report', async () => {
    const { get } = await renderComponent(<IssuesRegion {...issueProps} issues={[]} />);
    expect(get('issues-empty').textContent).toContain('Nothing to report');
  });

  it('describes an anchor in the words the person uses', () => {
    expect(describeAnchor({ sheet: 'Productos', row: 42, column: 'Precio' })).toBe('Productos · row 42 · Precio');
    expect(describeAnchor({ cellRef: 'Sheet1!C42' })).toBe('Sheet1!C42');
    expect(describeAnchor({})).toBe('the file');
  });
});

describe('the result region', () => {
  const preview: PreviewResponse = {
    rows: [
      {
        sourceRow: 2,
        blank: false,
        values: { name: 'Camiseta', price: 1234.5 },
        cells: [
          {
            columnIndex: 0,
            header: 'Nombre',
            field: 'name',
            original: 'Camiseta',
            normalized: 'Camiseta',
            steps: [],
            changed: false,
          },
          {
            columnIndex: 1,
            header: 'Precio',
            field: 'price',
            original: ' 1.234,50 ',
            normalized: 1234.5,
            steps: ['trimmed surrounding whitespace', 'read as the number 1234.5'],
            changed: true,
          },
          {
            columnIndex: 2,
            header: 'Notas',
            field: null,
            original: 'interno',
            normalized: 'interno',
            steps: [],
            changed: false,
          },
        ],
      },
    ],
    ignoredColumns: [{ columnIndex: 2, header: 'Notas' }],
    blankRowCount: 3,
    previewedRows: 1,
    issues: [],
    summary: { blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0, total: 0 },
    readiness: { allowed: true },
  };

  const resultProps = { previewing: false, previewError: null as string | null, focusedColumnIndex: null };

  it('shows the original beside what would be stored', async () => {
    // A summary is not an answer: "45 columns mapped" is what lets someone
    // import a price into the cost field.
    const { text } = await renderComponent(<ResultRegion {...resultProps} preview={preview} />);
    expect(text()).toContain('1.234,50');
    expect(text()).toContain('1234.5');
  });

  it('explains why the two differ, on demand', async () => {
    const { text } = await renderComponent(<ResultRegion {...resultProps} preview={preview} />);
    expect(text()).toContain('2 changes');
    expect(text()).toContain('trimmed surrounding whitespace');
  });

  it('leaves out columns that are not being imported, and says which', async () => {
    const { get } = await renderComponent(<ResultRegion {...resultProps} preview={preview} />);
    expect(get('ignored-columns').textContent).toContain('Not imported: Notas.');
  });

  it('counts the blank rows it will skip', async () => {
    const { get } = await renderComponent(<ResultRegion {...resultProps} preview={preview} />);
    expect(get('result-summary').textContent).toContain('3 blank rows will be skipped');
  });

  it('shows a cell that could not be converted as not imported, with the reason', async () => {
    const withProblem: PreviewResponse = {
      ...preview,
      rows: [
        {
          ...preview.rows[0],
          cells: [
            {
              columnIndex: 1,
              header: 'Precio',
              field: 'price',
              original: 'consultar',
              normalized: null,
              steps: [],
              problem: '"consultar" is not a number',
              changed: false,
            },
          ],
        },
      ],
    };
    const { text } = await renderComponent(<ResultRegion {...resultProps} preview={withProblem} />);
    expect(text()).toContain('Not imported');
    expect(text()).toContain('"consultar" is not a number');
  });

  it('says it is working, in words a screen reader can announce', async () => {
    const { get } = await renderComponent(<ResultRegion {...resultProps} preview={null} previewing />);
    const loading = get('result-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toContain('Working out what this mapping would produce');
  });

  it('reassures that nothing was changed when the preview fails', async () => {
    const { container } = await renderComponent(
      <ResultRegion {...resultProps} preview={null} previewError="The preview could not be built." />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Nothing has been changed in your catalogue');
  });
});

describe('the source region', () => {
  const sample = {
    sheet: 'Productos',
    firstRowNumber: 2,
    headers: ['Nombre', 'Precio'],
    rows: [
      ['Camiseta', '19,99'],
      ['Pantalón', ''],
    ],
  };

  const sourceProps = {
    fileName: 'export.csv',
    sheets: ['Productos'],
    activeSheet: 'Productos',
    onSelectSheet: noop,
    tables: [],
    activeTableId: null,
    onSelectTable: noop,
    sample,
    headerRow: 1,
    onHeaderRowChange: noop,
    focusedColumnIndex: null as number | null,
    onFocusColumn: noop,
  };

  it('offers the header row prominently, not behind a disclosure', async () => {
    // Get it wrong and every column is mis-identified at once.
    const { container } = await renderComponent(<SourceRegion {...sourceProps} />);
    expect(labelOf(container, 'header-row')).toBe('Which row holds the column names?');
  });

  it('warns that changing the header row starts the mapping again', async () => {
    const { text } = await renderComponent(<SourceRegion {...sourceProps} />);
    expect(text()).toContain('any mapping you have built will start again');
  });

  it('shows the raw grid with the row numbers the person sees', async () => {
    const { container } = await renderComponent(<SourceRegion {...sourceProps} />);
    const rowHeaders = Array.from(container.querySelectorAll('tbody th')).map((th) => th.textContent);
    expect(rowHeaders).toEqual(['2', '3']);
  });

  it('marks an empty cell rather than leaving a gap that looks like a bug', async () => {
    const { text } = await renderComponent(<SourceRegion {...sourceProps} />);
    expect(text()).toContain('(empty)');
  });

  it('asks which table when a sheet holds more than one', async () => {
    // Combining unrelated tables silently would produce nonsense.
    const { container, text } = await renderComponent(
      <SourceRegion
        {...sourceProps}
        tables={[
          { id: 'a', label: 'Products', headerRow: 1, firstDataRow: 2, lastRow: 40, columnCount: 5 },
          { id: 'b', label: 'Totals', headerRow: 45, firstDataRow: 46, lastRow: 50, columnCount: 2 },
        ]}
        activeTableId="a"
      />,
    );
    expect(text()).toContain('more than one table');
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  });

  it('hides the sheet chooser when there is only one sheet', async () => {
    const { container } = await renderComponent(<SourceRegion {...sourceProps} />);
    expect(container.querySelector('#sheet-select')).toBeNull();
  });

  it('says nothing is changed until a plan is approved, before a file is chosen', async () => {
    const { get } = await renderComponent(<SourceRegion {...sourceProps} sample={null} />);
    expect(get('source-empty').textContent).toContain('Nothing is changed in your catalogue');
  });
});
