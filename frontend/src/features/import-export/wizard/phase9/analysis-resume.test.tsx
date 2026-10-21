import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, flush, cleanupAll } from '../../../../test/render';
import { Phase9ImportWizard } from './import-wizard';

/**
 * Reopening an import that is already under way.
 *
 * The deployed failure: the wizard spun on "Reading your file…" forever while
 * the backend had in fact completed the analysis five separate times. Three
 * faults stacked up.
 *
 * The effect re-ran (a token refresh is enough), which cancelled the poll loop
 * and started a second analysis. That second call answered 409, and the handler
 * parked at `{ id: '', status: 'RUNNING' }` — but polling is driven by an id,
 * so with none it never resumed. Meanwhile the editor rendered underneath the
 * banner, so the screen said "Reading your file…" and "Choose a file to import."
 * at once. And nothing bounded the wait, so the spinner had no end.
 *
 * These tests reopen a source in each analysis state, which is exactly what a
 * reload does.
 */

const SOURCE = 'dfcb31f9-9520-4809-b32c-6a683a395d01';
const ANALYSIS = 'd42623e8-89c3-4e1e-87cf-bc20ca501063';

const SAMPLE = {
  headers: ['sku', 'name', 'description', 'price', 'cost', 'stock', 'categories'],
  rows: [
    ['P9ACC-001', 'Widget Alfa', 'Pieza sintetica', '10.00', '4.00', '7', 'Aceptacion P9'],
    ['P9ACC-002', 'Widget Beta', 'Pieza sintetica', '12.50', '5.00', '3', 'Aceptacion P9'],
  ],
  firstRowNumber: 2,
};

function analysis(status: string, over: Record<string, unknown> = {}) {
  return {
    id: ANALYSIS,
    sourceId: SOURCE,
    status,
    tables: status === 'COMPLETED' ? { sample: SAMPLE, columnTypes: [] } : null,
    proposals: status === 'COMPLETED' ? SAMPLE.headers.map((h, i) => ({ columnIndex: i, header: h, field: null })) : [],
    findings: [],
    rowsAnalyzed: status === 'COMPLETED' ? 6 : 0,
    failureReason: over.failureReason ?? null,
    ...over,
  };
}

function client(over: Record<string, unknown> = {}) {
  return {
    startAnalysis: vi.fn(async () => ({ id: ANALYSIS, status: 'QUEUED' })),
    // The relationships step needs these, and the wizard fails closed without
    // them. A stub that omitted them would be testing a client the product does
    // not have.
    relationshipOptions: async () => ({
      storeId: null,
      stockDestinations: [],
      stores: [],
      existingCategoryNames: [],
    }),

    getAnalysis: vi.fn(async () => analysis('COMPLETED')),
    ...over,
  } as never;
}

const open = async (lifecycle: unknown, extra: Record<string, unknown> = {}) =>
  renderComponent(
    <Phase9ImportWizard
      availability="ALLOWED"
      token="token"
      location={{ sourceId: SOURCE, importType: 'PRODUCTS' }}
      sourceStatus="AVAILABLE"
      storage={null}
      lifecycle={lifecycle as never}
      pollIntervalMs={1}
      {...extra}
    />,
  );

afterEach(cleanupAll);

describe('reopening a source whose analysis is COMPLETED', () => {
  it('loads the sample instead of starting another analysis', async () => {
    // The backend now answers `startAnalysis` for an already-read file with the
    // COMPLETED analysis rather than a new one, so reopening resumes.
    const lifecycle = client({
      startAnalysis: vi.fn(async () => ({ id: ANALYSIS, status: 'COMPLETED' })),
      getAnalysis: vi.fn(async () => analysis('COMPLETED')),
    });
    const { find, container } = await open(lifecycle);
    await flush();
    await flush();

    // The editor is shown, not the reading banner.
    expect(find('analysis-status')).toBeNull();
    expect(find('mapping-editor')).not.toBeNull();
    // And the columns from the file are really there.
    expect(container.textContent).toContain('sku');
    expect(container.textContent).toContain('categories');
  });

  it('never renders "Reading your file…" and "Choose a file" at the same time', async () => {
    const { container } = await open(client());
    await flush();
    await flush();

    const text = container.textContent ?? '';
    const reading = text.includes('Reading your file');
    const chooseFile = text.includes('Choose a file to import');
    expect(reading && chooseFile).toBe(false);
  });
});

describe('reopening while the analysis is still QUEUED or RUNNING', () => {
  it('shows how long it has been waiting, not a bare spinner', async () => {
    let clock = 0;
    const lifecycle = client({ getAnalysis: vi.fn(async () => analysis('RUNNING')) });
    const { get } = await open(lifecycle, { now: () => (clock += 4000) });
    await flush();
    await flush();

    expect(get('analysis-status').textContent).toContain('Reading your file');
    expect(get('analysis-waited').textContent).toMatch(/Waiting \d+s/);
  });

  it('keeps polling rather than stopping after the first look', async () => {
    const getAnalysis = vi.fn(async () => analysis('QUEUED'));
    await open(client({ getAnalysis }));
    await flush();
    await flush();
    await flush();

    expect(getAnalysis.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('reopening when the analysis FAILED', () => {
  it('states the failure and stops polling, rather than spinning', async () => {
    const getAnalysis = vi.fn(async () => analysis('FAILED', { failureReason: 'The first row is not a header.' }));
    const { get } = await open(client({ getAnalysis }));
    await flush();
    await flush();

    expect(get('analysis-status').textContent).toContain('could not be read');
    expect(get('analysis-status').textContent).toContain('The first row is not a header.');

    const seen = getAnalysis.mock.calls.length;
    await flush();
    await flush();
    expect(getAnalysis.mock.calls.length).toBe(seen);
  });
});

describe('the wait is bounded', () => {
  it('becomes a named, actionable state instead of spinning forever', async () => {
    // A clock that jumps past the deadline on the first poll.
    let first = true;
    const now = () => {
      if (first) {
        first = false;
        return 0;
      }
      return 10 * 60 * 1000;
    };
    const { get } = await open(client({ getAnalysis: vi.fn(async () => analysis('QUEUED')) }), {
      now,
      analysisDeadlineMs: 60_000,
    });
    await flush();
    await flush();

    const card = get('analysis-status');
    expect(card.textContent).toContain('Still waiting');
    expect(card.textContent).toContain('nothing has been changed in your catalogue');
    expect(get('analysis-keep-waiting')).not.toBeNull();
  });

  it('a conflict we cannot name is terminal, never a silent spinner', async () => {
    // The exact deployed shape: startAnalysis rejects "already being read", and
    // the old code parked as RUNNING with no id, so polling never began.
    const lifecycle = client({
      startAnalysis: vi.fn(async () => {
        throw new Error('This file is already being read. Wait for it to finish.');
      }),
    });
    const { get } = await open(lifecycle);
    await flush();
    await flush();

    const card = get('analysis-status');
    expect(card.textContent).toContain('Still waiting');
    expect(card.textContent).toContain('lost track of which reading');
    expect(get('analysis-keep-waiting')).not.toBeNull();
  });

  it('"Keep waiting" resumes rather than uploading anything again', async () => {
    const startAnalysis = vi.fn(async () => ({ id: ANALYSIS, status: 'QUEUED' }));
    let first = true;
    const now = () => {
      if (first) {
        first = false;
        return 0;
      }
      return 10 * 60 * 1000;
    };
    const { get } = await open(client({ startAnalysis, getAnalysis: vi.fn(async () => analysis('QUEUED')) }), {
      now,
      analysisDeadlineMs: 60_000,
    });
    await flush();
    await flush();

    const before = startAnalysis.mock.calls.length;
    await click(get('analysis-keep-waiting'));
    await flush();

    // It asks the lifecycle again — which is now idempotent — and never touches
    // storage or registration.
    expect(startAnalysis.mock.calls.length).toBeGreaterThan(before);
  });
});
