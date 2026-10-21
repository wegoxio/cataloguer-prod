import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftImports } from './draft-imports';
import { renderComponent, cleanupAll, flush } from '../../test/render';
import { saveProgress, type ProgressStorage } from './wizard/mapping/progress-store';
import { initialMappingState, mappingReducer } from './wizard/mapping/mapping-state';
import type { ProgressScope } from './wizard/mapping/progress-hydration';
import type { DraftImport } from './wizard/api/lifecycle.service';

/**
 * Where `Save and exit` comes back to.
 *
 * It shipped once with nowhere to return: the draft went into browser storage
 * and the button navigated to a page that said nothing about it. A save action
 * with no reopening surface is a promise the product does not keep.
 *
 * The split this screen has to be honest about: the SOURCE is on the server and
 * appears anywhere; the MAPPING DECISIONS are in one browser. Claiming the
 * second travels is the failure mode worth testing for.
 */

const SOURCE = '11111111-1111-4111-8111-111111111111';
// Module scope: reachability is asserted across several describes now.
const PLAN = '55555555-5555-4555-8555-555555555555';
const EXEC = '66666666-6666-4666-8666-666666666666';
const NOW = 1_800_000_000_000;

const draft = (over: Partial<DraftImport> = {}): DraftImport => ({
  sourceId: SOURCE,
  fileName: 'proveedor.csv',
  importType: 'PRODUCTS',
  organizationId: 'org-1',
  storeId: null,
  stage: 'MAPPING_IN_PROGRESS',
  planId: null,
  sourceStatus: 'READY',
  analysisStatus: 'COMPLETED',
  planStatus: null,
  executionStatus: null,
  hasUnexecutedDraftPlan: false,
  executionId: null,
  finishedAt: null,
  rowsCreated: null,
  rowsUpdated: null,
  rowsSkipped: null,
  rowsFailed: null,
  activityAt: '2026-08-29T10:30:00.000Z',
  createdAt: '2026-08-29T10:00:00.000Z',
  updatedAt: '2026-08-29T10:30:00.000Z',
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

const scope = (): ProgressScope => ({
  sourceId: SOURCE,
  importType: 'PRODUCTS',
  sourceHash: null,
  analysisId: null,
  sheet: null,
  headerRow: 1,
  headers: ['sku'],
  storeId: null,
  locationIds: [],
  storeIds: [],
});

const withLocalProgress = (storage: ProgressStorage) => {
  let state = initialMappingState('PRODUCTS');
  state = mappingReducer(state, {
    type: 'SOURCE_LOADED',
    sample: { firstRowNumber: 2, headers: ['sku'], rows: [['A-1']] },
    columnTypes: ['TEXT'],
    proposals: [{ columnIndex: 0, header: 'sku', field: 'sku' }],
  });
  saveProgress(storage, state, SOURCE, NOW, scope());
};

const render = (items: DraftImport[], storage: ProgressStorage | null = null, over: Record<string, unknown> = {}) =>
  renderComponent(
    <DraftImports
      token="t"
      storage={storage}
      now={() => NOW}
      lifecycle={{ listSources: async () => ({ items, limit: 20, offset: 0, hasMore: false }), cancelSource: vi.fn() } as never}
      {...over}
    />,
  );

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await flush();
};

afterEach(() => cleanupAll());

describe('the draft imports list', () => {
  it('shows a started import with its file, stage and time', async () => {
    const view = await render([draft()]);
    await settle();
    const row = view.get(`draft-${SOURCE}`).textContent ?? '';
    expect(row).toContain('proveedor.csv');
    expect(view.get(`draft-stage-${SOURCE}`).textContent).toBe('Mapping in progress');
    expect(row).toMatch(/2026/);
  });

  it('offers Resume, pointing at the SAME source', async () => {
    const view = await render([draft()]);
    await settle();
    const href = view.get(`draft-resume-${SOURCE}`).getAttribute('href') ?? '';
    // The same source, never a fresh upload. Duplicating the file is what
    // people do when a product hides the one they already sent.
    expect(href).toContain(SOURCE);
    expect(href).toContain('/dashboard/import-export/wizard');
  });

  it('says plainly that decisions live in this browser', async () => {
    const view = await render([draft()]);
    await settle();
    expect(view.get('draft-imports').textContent ?? '').toContain('saved in this browser only');
  });
});

describe('when the local mapping is not on this machine', () => {
  it('explains it rather than pretending the work travelled', async () => {
    // No local progress: another browser, or the 24-hour expiry.
    const view = await render([draft()], makeStorage());
    await settle();
    const detail = view.get(`draft-local-missing-${SOURCE}`).textContent ?? '';
    expect(detail).toContain('saved in another browser or has expired');
    expect(detail).toContain('You can map it again');
  });

  it('still offers Resume, because the source itself is there', async () => {
    const view = await render([draft()], makeStorage());
    await settle();
    expect(view.find(`draft-resume-${SOURCE}`)).not.toBeNull();
  });

  it('says nothing of the sort when the decisions ARE on this machine', async () => {
    const storage = makeStorage();
    withLocalProgress(storage);
    const view = await render([draft()], storage);
    await settle();
    expect(view.find(`draft-local-missing-${SOURCE}`)).toBeNull();
  });
});

describe('what may be resumed', () => {
  it.each([
    ['MAPPING_IN_PROGRESS', 'Mapping in progress'],
    ['PLAN_REVIEW', 'Ready to review'],
    ['READING', 'Reading the file'],
  ] as const)('offers %s as resumable', async (stage, label) => {
    // A PLAN stage carries its plan id, as the server now always sends one for
    // a source that has a plan. A row claiming "Ready to review" with no plan
    // to review is not a state the server can produce.
    const view = await render([draft({ stage, planId: stage === 'PLAN_REVIEW' ? PLAN : null })]);
    await settle();
    expect(view.get(`draft-stage-${SOURCE}`).textContent).toBe(label);
    expect(view.find(`draft-resume-${SOURCE}`)).not.toBeNull();
  });

  it.each([
    ['ACTIVE', 'Importing'],
    ['COMPLETED', 'Imported'],
    ['RECOVERY', 'Needs attention'],
    ['CANCELLED', 'Cancelled'],
  ] as const)('offers %s as OPENABLE, without offering to edit it', async (stage, label) => {
    // Reachable now, and previously not. The old rule refused a link at all, on
    // the reasoning that resuming a finished import would invite a second
    // mutation — which conflated OPENING with EDITING. Opening shows what
    // happened; the shared projection decides what may be done, and it offers
    // no edit over a run.
    const view = await render([draft({ stage, planId: PLAN })]);
    await settle();
    expect(view.get(`draft-stage-${SOURCE}`).textContent).toBe(label);
    const link = view.get(`draft-resume-${SOURCE}`);
    expect(link.getAttribute('href') ?? '').toContain(`plan=${PLAN}`);
    // Never the editor: the destination is the plan, not the mapping.
    expect(link.textContent?.trim()).not.toBe('Resume');
  });
});

describe('when the list cannot be loaded', () => {
  it('says so rather than showing an empty list', async () => {
    // "You have no drafts" and "we could not ask" lead somewhere different.
    const view = await render([], null, {
      lifecycle: { listSources: async () => { throw new Error('nope'); }, cancelSource: vi.fn() },
    });
    await settle();
    expect(view.find('draft-imports-failed')).not.toBeNull();
    expect(view.find('draft-imports')).toBeNull();
  });

  it('shows nothing at all when there genuinely are none', async () => {
    const view = await render([]);
    await settle();
    expect(view.find('draft-imports')).toBeNull();
    expect(view.find('draft-imports-failed')).toBeNull();
  });
});

describe('the stage and the destination agree', () => {

  it('sends a Ready-to-review row to the PLAN, not to mapping', async () => {
    // The defect this exists to prevent: a row labelled "Ready to review" that
    // routed back to the mapping editor, which cleared its preview, never
    // asked for another, and sat on "Waiting for the preview." while the
    // finished plan lay unread on the server.
    const view = await render([draft({ stage: 'PLAN_REVIEW', planId: PLAN, hasUnexecutedDraftPlan: true })]);
    await settle();
    const href = view.get(`draft-resume-${SOURCE}`).getAttribute('href') ?? '';
    expect(href).toContain(`plan=${PLAN}`);
    expect(href).toContain(`source=${SOURCE}`);
  });

  /**
   * Reachability, for every stage there is.
   *
   * A stage that HAS a plan must be openable, and its verb must be the one the
   * destination can honour. Four stages were `open: 'NONE'` with no action, so
   * a finished, failed, partial or cancelled import could not be reached from
   * the only page that lists it — the results had moved onto the plan surface
   * and nothing linked there. `bcdb9687…` ran correctly and could not be
   * opened.
   *
   * The listing decides reachability only. What may be DONE once the plan is
   * open is the shared projection's answer, so a link here grants nothing.
   */
  it.each([
    ['PLAN_REVIEW', 'Resume'],
    ['APPROVED_PENDING', 'Open'],
    ['ACTIVE', 'View progress'],
    ['COMPLETED', 'View results'],
    ['RECOVERY', 'View results'],
    ['CANCELLED', 'View results'],
  ])('opens a %s row and calls the action %s', async (stage, verb) => {
    const view = await render([draft({ stage: stage as never, planId: PLAN })]);
    await settle();
    const link = view.get(`draft-resume-${SOURCE}`);
    expect(link.textContent?.trim()).toBe(verb);
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain(`plan=${PLAN}`);
    expect(href).toContain(`source=${SOURCE}`);
  });

  it('explains an unreachable row instead of inventing a destination', async () => {
    // A source cancelled before any plan was built. A link made from the source
    // alone would open the mapping editor under a label promising results.
    const view = await render([draft({ stage: 'CANCELLED', planId: null })]);
    await settle();
    expect(view.find(`draft-resume-${SOURCE}`)).toBeNull();
    expect(view.get(`draft-no-plan-${SOURCE}`).textContent ?? '').toContain('nothing to open');
  });

  it('offers nothing for an upload that has not finished', async () => {
    const view = await render([draft({ stage: 'UPLOADING', planId: null })]);
    await settle();
    expect(view.find(`draft-resume-${SOURCE}`)).toBeNull();
    expect(view.get(`draft-detail-${SOURCE}`).textContent ?? '').toContain('nothing to open yet');
  });

  /**
   * The summary the retired history page promised and never delivered.
   *
   * `/import-export/history` read a table whose only writer went with the
   * direct-commit path, so it said "No imports recorded yet" while completed
   * imports sat in the lifecycle tables. These counters come from the
   * execution's own columns, so they cannot disagree with the row-by-row table
   * the link opens.
   */
  it.each([
    ['COMPLETED', { rowsCreated: 5, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0 }, '5 added'],
    ['COMPLETED', { rowsCreated: 0, rowsUpdated: 1, rowsSkipped: 0, rowsFailed: 0 }, '1 updated'],
    ['RECOVERY', { rowsCreated: 3, rowsUpdated: 2, rowsSkipped: 1, rowsFailed: 4 }, '3 added, 2 updated, 1 left unchanged, 4 could not be imported'],
    ['RECOVERY', { rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 6 }, '6 could not be imported'],
    ['CANCELLED', { rowsCreated: 2, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0 }, '2 added'],
  ])('summarises a %s run accurately', async (stage, counts, expected) => {
    const view = await render([
      draft({ stage: stage as never, planId: PLAN, executionId: EXEC, finishedAt: '2026-08-31T17:38:25.000Z', ...counts }),
    ]);
    await settle();
    expect(view.get(`draft-summary-${SOURCE}`).textContent).toBe(expected);
    // And the summary is never the whole story: the link opens the rows.
    expect(view.get(`draft-resume-${SOURCE}`).getAttribute('href') ?? '').toContain(`plan=${PLAN}`);
  });

  it('says plainly when a run changed nothing, rather than showing a blank', async () => {
    const view = await render([
      draft({
        stage: 'COMPLETED', planId: PLAN, executionId: EXEC,
        rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0,
      }),
    ]);
    await settle();
    expect(view.get(`draft-summary-${SOURCE}`).textContent).toBe('No rows were changed');
  });

  it('shows no run summary for an import that has not been started', async () => {
    // Never started is a different fact from wrote nothing, and a row of zeroes
    // would say the second when the first is true.
    const view = await render([draft({ stage: 'PLAN_REVIEW', planId: PLAN, executionId: null })]);
    await settle();
    expect(view.find(`draft-summary-${SOURCE}`)).toBeNull();
  });

  it('dates a row by when it last DID something', async () => {
    const view = await render([
      draft({
        stage: 'COMPLETED', planId: PLAN, executionId: EXEC,
        updatedAt: '2026-08-01T00:00:00.000Z',
        activityAt: '2026-08-31T17:38:25.000Z',
        rowsCreated: 1,
      }),
    ]);
    await settle();
    const line = view.get(`draft-stage-${SOURCE}`).parentElement?.textContent ?? '';
    expect(line).toContain(new Date('2026-08-31T17:38:25.000Z').toLocaleString());
    expect(line).not.toContain(new Date('2026-08-01T00:00:00.000Z').toLocaleString());
  });

  it('says what the list is, now that it holds finished imports too', async () => {
    const view = await render([draft({ stage: 'COMPLETED', planId: PLAN })]);
    await settle();
    expect(view.text()).toContain('Import activity');
    expect(view.text()).not.toContain('Draft imports');
  });

  it('offers a way back into an APPROVED plan that has not run', async () => {
    // The trap this closes. An approved plan whose one-time proof was lost was
    // listed as "Importing — it cannot be edited", with no link at all. The tab
    // that approved it was the only route back, so once that tab was gone the
    // approval could be neither spent nor withdrawn. Plan `bcdb9687…` sat in
    // exactly that state.
    const view = await render([
      draft({ stage: 'APPROVED_PENDING', planId: PLAN, planStatus: 'APPROVED', hasUnexecutedDraftPlan: false }),
    ]);
    await settle();
    const href = view.get(`draft-resume-${SOURCE}`).getAttribute('href') ?? '';
    expect(href).toContain(`plan=${PLAN}`);
    expect(href).toContain(`source=${SOURCE}`);
  });

  it('still offers nothing for a run that is genuinely under way', async () => {
    // ACTIVE now means what it says: a run exists. There is nothing to open,
    // because there is nothing a person may do to it from here.
    const view = await render([draft({ stage: 'ACTIVE', planId: null, executionStatus: 'RUNNING' })]);
    await settle();
    expect(view.find(`draft-resume-${SOURCE}`)).toBeNull();
  });

  it('sends a mapping row to the source ALONE, with no plan', async () => {
    const view = await render([draft({ stage: 'MAPPING_IN_PROGRESS', planId: null })]);
    await settle();
    const href = view.get(`draft-resume-${SOURCE}`).getAttribute('href') ?? '';
    expect(href).toContain(`source=${SOURCE}`);
    expect(href).not.toContain('plan=');
  });

  it('never carries a plan for a stage that is not plan review', async () => {
    // A plan id on a mapping route would open review from a row that does not
    // claim to be reviewable — the same disagreement in the other direction.
    for (const stage of ['READING', 'MAPPING_IN_PROGRESS'] as const) {
      const view = await render([draft({ stage, planId: PLAN })]);
      await settle();
      expect(view.get(`draft-resume-${SOURCE}`).getAttribute('href') ?? '').not.toContain('plan=');
      cleanupAll();
    }
  });

  it('opens every stage that HAS a plan, and none that does not', async () => {
    for (const stage of ['ACTIVE', 'COMPLETED', 'RECOVERY', 'CANCELLED'] as const) {
      const view = await render([draft({ stage, planId: PLAN })]);
      await settle();
      expect(view.find(`draft-resume-${SOURCE}`), stage).not.toBeNull();
      cleanupAll();
    }
    for (const stage of ['ACTIVE', 'COMPLETED', 'RECOVERY', 'CANCELLED'] as const) {
      const view = await render([draft({ stage, planId: null })]);
      await settle();
      expect(view.find(`draft-resume-${SOURCE}`), stage).toBeNull();
      cleanupAll();
    }
  });
});
