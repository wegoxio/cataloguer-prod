import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderComponent, click, cleanupAll, flush } from '../../../../test/render';
import { Phase9ImportWizard, currentLink } from './import-wizard';
import { wizardService } from '../api/wizard.service';
import { initialMappingState, mappingReducer } from '../mapping/mapping-state';
import { saveProgress, type ProgressStorage } from '../mapping/progress-store';
import type { ProgressScope } from '../mapping/progress-hydration';

/**
 * The real wizard, replacing the Phase 8 rehearsal.
 *
 * What the rehearsal proved was a negative — it imported nothing — and it
 * proved it by never writing a request. This one DOES talk to the server, so
 * the properties worth proving are different: that everything it offers came
 * from the server rather than a fixture, that it writes nothing itself, and
 * that a person who cannot import is told so rather than shown an editor.
 */

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

const CONTRACT = {
  version: '1.0.0',
  supportedTransformations: ['TRIM'] as never,
  issueSeverities: {},
  transformations: [
    {
      kind: 'TRIM' as const,
      label: 'Remove surrounding spaces',
      description: 'Removes spaces from the start and end of the value.',
      group: 'TEXT' as const,
      options: [],
      example: { before: '  a  ', after: 'a' },
    },
  ],
};

/** What a saved entry says it was made against. */
const scopeFor = (headers: string[], over: Partial<ProgressScope> = {}): ProgressScope => ({
  sourceId: SOURCE_ID,
  importType: 'PRODUCTS',
  sourceHash: null,
  analysisId: null,
  sheet: null,
  headerRow: 1,
  headers,
  storeId: null,
  locationIds: [],
  storeIds: [],
  ...over,
});

function makeStorage(): ProgressStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/**
 * A lifecycle that never answers.
 *
 * These tests are about the editor, not the run, and the wizard now starts an
 * analysis the moment it opens a source. Left to the real service that becomes
 * a live request against a server that is not running — noise in the output,
 * and a test whose behaviour depends on what the network happens to do. The
 * journey through these routes is proven in `run/import-journey.test.tsx`.
 */
const silentLifecycle = () => ({
  startAnalysis: () => new Promise<never>(() => {}),
    // The relationships step needs these, and the wizard fails closed without
    // them. A stub that omitted them would be testing a client the product does
    // not have.
    relationshipOptions: async () => ({
      storeId: null,
      stockDestinations: [],
      stores: [],
      existingCategoryNames: [],
    }),

  getAnalysis: () => new Promise<never>(() => {}),
  createPlan: () => new Promise<never>(() => {}),
  approvePlan: () => new Promise<never>(() => {}),
  startExecution: () => new Promise<never>(() => {}),
  executionStatus: () => new Promise<never>(() => {}),
  cancel: () => new Promise<never>(() => {}),
  resume: () => new Promise<never>(() => {}),
  rowResults: () => new Promise<never>(() => {}),
  reportSummary: () => new Promise<never>(() => {}),
  reportCsvPath: (id: string) => `/import/lifecycle/executions/${id}/report.csv`,
});

const bootstrap = (over: Partial<Parameters<typeof Phase9ImportWizard>[0]> = {}) => ({
  availability: 'ALLOWED' as const,
  token: 'token',
  location: { sourceId: SOURCE_ID, importType: 'PRODUCTS' as const },
  sourceStatus: 'AVAILABLE' as const,
  storage: makeStorage(),
  now: () => NOW,
  lifecycle: silentLifecycle() as never,
  ...over,
});

afterEach(() => {
  cleanupAll();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(wizardService, 'getContract').mockResolvedValue(CONTRACT as never);
  vi.spyOn(wizardService, 'preview').mockResolvedValue({
    rows: [],
    ignoredColumns: [],
    blankRowCount: 0,
    previewedRows: 0,
    issues: [],
    summary: { blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0, total: 0 },
    readiness: { allowed: true },
  } as never);
});

describe('permission-aware states', () => {
  it('tells a role that may not import, rather than showing an editor', async () => {
    const { get, container } = await renderComponent(<Phase9ImportWizard {...bootstrap({ availability: 'FORBIDDEN' })} />);
    expect(get('wizard-forbidden').textContent).toContain('do not have permission');
    expect(container.querySelector('[data-testid="mapping-editor"]')).toBeNull();
  });

  it('explains WHY, and what to do instead', async () => {
    const { text } = await renderComponent(<Phase9ImportWizard {...bootstrap({ availability: 'FORBIDDEN' })} />);
    expect(text()).toContain('changes the whole company’s catalogue');
    expect(text()).toContain('Ask a manager');
  });

  it('says imports are unavailable without leaking the operator’s reason', async () => {
    // The configuration problem names buckets and credentials.
    const { get, text } = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ availability: 'UNAVAILABLE' })} />,
    );
    expect(get('wizard-unavailable').textContent).toContain('Nothing is missing from your account');
    expect(text().toLowerCase()).not.toMatch(/bucket|credential|secret|s3|token/);
  });

  it('fetches nothing at all when the caller may not import', async () => {
    await renderComponent(<Phase9ImportWizard {...bootstrap({ availability: 'FORBIDDEN' })} />);
    await flush();
    expect(wizardService.getContract).not.toHaveBeenCalled();
  });
});

describe('resilient deep links', () => {
  it('opens the editor for a source that is still there', async () => {
    const { find } = await renderComponent(<Phase9ImportWizard {...bootstrap()} />);
    await flush();
    expect(find('mapping-editor')).not.toBeNull();
  });

  it('lands somewhere sensible when the source expired, not on an error', async () => {
    const { get } = await renderComponent(<Phase9ImportWizard {...bootstrap({ sourceStatus: 'EXPIRED' })} />);
    expect(get('wizard-start-over').textContent).toContain('90 days');
    expect(get('wizard-start-over').textContent).toContain('Upload it again');
  });

  it('says the same thing for a missing source as for a forbidden one', async () => {
    const missing = await renderComponent(<Phase9ImportWizard {...bootstrap({ sourceStatus: 'MISSING' })} />);
    const missingText = missing.get('wizard-start-over').textContent;
    cleanupAll();
    const forbidden = await renderComponent(<Phase9ImportWizard {...bootstrap({ sourceStatus: 'FORBIDDEN' })} />);
    expect(forbidden.get('wizard-start-over').textContent).toBe(missingText);
  });

  it('OFFERS the file picker when the link named no source', async () => {
    // This used to assert the sentence "Choose a file to import." — which the
    // screen displayed while rendering nothing to choose a file with. The
    // sentence was the whole of the step. Now the step is real, so the test
    // asks for the control rather than for the prose describing it.
    const { get, find } = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ location: {}, sourceStatus: 'NONE' })} />,
    );
    expect(get('wizard-start-over')).not.toBeNull();
    expect(find('source-picker')).not.toBeNull();

    const input = get('source-picker').querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(false);
  });

  it('builds a link carrying identifiers and nothing else', async () => {
    let state = initialMappingState('PRODUCTS');
    state = mappingReducer(state, { type: 'REGION_FOCUSED', region: 'ISSUES' });
    state = mappingReducer(state, { type: 'COLUMN_FOCUSED', columnIndex: 3 });
    const link = currentLink(SOURCE_ID, state);
    expect(link).toContain(`source=${SOURCE_ID}`);
    expect(link).toContain('at=issues');
    expect(link).toContain('col=3');
  });
});

describe('everything offered comes from the server', () => {
  it('asks for the contract rather than reading a fixture', async () => {
    await renderComponent(<Phase9ImportWizard {...bootstrap()} />);
    await flush();
    expect(wizardService.getContract).toHaveBeenCalledWith('token');
  });

  it('still renders when the contract cannot be fetched', async () => {
    // The editor degrades to "loading the available clean-up steps" rather
    // than to a broken page.
    vi.spyOn(wizardService, 'getContract').mockRejectedValue(new Error('offline'));
    const { find } = await renderComponent(<Phase9ImportWizard {...bootstrap()} />);
    await flush();
    expect(find('mapping-editor')).not.toBeNull();
  });
});

describe('saved work is offered, never applied silently', () => {
  it('offers to continue when there is saved work for this source', async () => {
    // Restoring silently would be its own surprise.
    const storage = makeStorage();
    let state = initialMappingState('PRODUCTS');
    state = mappingReducer(state, {
      type: 'SOURCE_LOADED',
      sample: { firstRowNumber: 2, headers: ['Nombre'], rows: [['x']] },
      columnTypes: ['TEXT'],
      proposals: [{ columnIndex: 0, header: 'Nombre', field: 'name' }],
    });
    saveProgress(storage, state, SOURCE_ID, NOW, scopeFor(['Nombre']));

    const { find, text } = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await flush();
    expect(find('restore-offer')).not.toBeNull();
    expect(text()).toContain('Continue where you left off?');
  });

  it('offers nothing when there is no saved work', async () => {
    const { find } = await renderComponent(<Phase9ImportWizard {...bootstrap()} />);
    await flush();
    expect(find('restore-offer')).toBeNull();
  });

  it('forgets the saved work when the person starts again', async () => {
    const storage = makeStorage();
    let state = initialMappingState('PRODUCTS');
    state = mappingReducer(state, {
      type: 'SOURCE_LOADED',
      sample: { firstRowNumber: 2, headers: ['Nombre'], rows: [['x']] },
      columnTypes: ['TEXT'],
      proposals: [{ columnIndex: 0, header: 'Nombre', field: 'name' }],
    });
    saveProgress(storage, state, SOURCE_ID, NOW, scopeFor(['Nombre']));

    const view = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await flush();
    const startAgain = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Discard saved work and restart',
    );
    await click(startAgain ?? null);
    expect(view.find('restore-offer')).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

describe('the wizard writes nothing itself', () => {
  it('calls only the read-only endpoints while a mapping is built', async () => {
    // Mapping and previewing are read-only. The only thing that mutates a
    // catalogue is an execution, which needs an approval this screen does not
    // grant.
    const spies = {
      saveTemplate: vi.spyOn(wizardService, 'saveTemplate'),
      applyTemplate: vi.spyOn(wizardService, 'applyTemplate'),
      archiveTemplate: vi.spyOn(wizardService, 'archiveTemplate'),
    };
    await renderComponent(<Phase9ImportWizard {...bootstrap()} />);
    await flush();

    expect(spies.saveTemplate).not.toHaveBeenCalled();
    expect(spies.applyTemplate).not.toHaveBeenCalled();
    expect(spies.archiveTemplate).not.toHaveBeenCalled();
  });

  it('reaches no endpoint outside the wizard’s own surface', () => {
    // The Phase 8 guard proved a rehearsal issued no request at all. Its
    // successor: every path this wizard can reach is under /import/wizard, so
    // no screen here can touch a catalogue write route.
    const source = readFileSync(
      join(process.cwd(), 'src', 'features', 'import-export', 'wizard', 'api', 'wizard.service.ts'),
      'utf8',
    );
    const endpoints = Array.from(source.matchAll(/apiFetch\(\s*[`'"]([^`'"$]*)/g)).map((m) => m[1]);
    expect(endpoints.length).toBeGreaterThan(3);
    for (const endpoint of endpoints) {
      expect(endpoint.startsWith('/import/wizard')).toBe(true);
    }
  });

  it('issues no request from the editor components themselves', () => {
    // The service is the one place a call may be written, so a careless edit in
    // a component cannot introduce one.
    const folder = join(process.cwd(), 'src', 'features', 'import-export', 'wizard', 'mapping-editor');
    const sources = readdirSync(folder).filter((n) => /\.tsx?$/.test(n) && !n.endsWith('.test.tsx'));
    expect(sources.length).toBeGreaterThan(3);
    for (const name of sources) {
      const source = readFileSync(join(folder, name), 'utf8');
      for (const token of ['fetch(', 'apiFetch', 'XMLHttpRequest', 'sendBeacon']) {
        expect(source.includes(token), `${name} contains "${token}"`).toBe(false);
      }
    }
  });

  it('reads no Phase 8 fixture anywhere it could reach the browser', () => {
    // The fixtures survive as deterministic test data; nothing that runs in a
    // browser may import them.
    const roots = ['phase9', 'mapping', 'mapping-editor', 'api'];
    for (const root of roots) {
      const folder = join(process.cwd(), 'src', 'features', 'import-export', 'wizard', root);
      for (const name of readdirSync(folder).filter((n) => /\.tsx?$/.test(n) && !n.endsWith('.test.tsx'))) {
        const source = readFileSync(join(folder, name), 'utf8');
        // Matched as an IMPORT, not as a word. Scanning for the bare substring
        // would fail on any comment that mentions fixtures, which is a guard
        // that cries wolf until somebody deletes it.
        const importsFixtures = /(?:from|import\()\s*['"][^'"]*fixtures['"]/.test(source);
        expect(importsFixtures, `${root}/${name} imports fixtures`).toBe(false);
      }
    }
  });
});
