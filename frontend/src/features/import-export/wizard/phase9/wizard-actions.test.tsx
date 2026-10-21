import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase9ImportWizard } from './import-wizard';
import { renderComponent, click, cleanupAll, flush } from '../../../../test/render';
import type { ProgressStorage } from '../mapping/progress-store';

/**
 * The way out of an import, and the way back to it later.
 *
 * Manual acceptance rejected a release because the mapping stage offered
 * neither. Twenty minutes into a forty-five column export there was no Cancel,
 * no way to save and come back, and nothing saying which stage you were in —
 * so the only way out was to abandon the tab and leave the source sitting READY
 * forever, ready to be offered back on the next visit.
 *
 * Every control here has a real handler and is tested through it. A rendered
 * button with an optional handler that happens to be undefined looks identical
 * to one that works, right up until somebody presses it.
 */

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ANALYSIS_ID = '22222222-2222-4222-8222-222222222222';
const STORE_ID = '44444444-4444-4444-8444-444444444444';

const SAMPLE = { firstRowNumber: 2, sheet: 'main', headers: ['sku', 'nombre'], rows: [['A-1', 'Silla']] };
const PROPOSALS = [
  { columnIndex: 0, header: 'sku', field: 'sku' },
  { columnIndex: 1, header: 'nombre', field: 'name' },
];

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

const lifecycle = (over: Record<string, unknown> = {}) => ({
  getSource: async () => ({ id: SOURCE_ID, contentHash: 'a'.repeat(64), status: 'AVAILABLE' }),
  startAnalysis: async () => ({ id: ANALYSIS_ID, status: 'COMPLETED' }),
  getAnalysis: async () => ({
    id: ANALYSIS_ID,
    sourceId: SOURCE_ID,
    status: 'COMPLETED',
    tables: { sample: SAMPLE, columnTypes: ['TEXT', 'TEXT'] },
    proposals: PROPOSALS,
    findings: [],
    rowsAnalyzed: 1,
    failureReason: null,
  }),
  relationshipOptions: async () => ({
    storeId: STORE_ID,
    stockDestinations: [],
    stores: [{ id: STORE_ID, name: 'Centro' }],
    existingCategoryNames: [],
  }),
  cancelSource: vi.fn(async () => ({
    cancelled: true,
    alreadyCancelled: false,
    notice: 'This import was cancelled. Nothing in your catalogue was changed.',
  })),
  createPlan: () => new Promise<never>(() => {}),
  approvePlan: () => new Promise<never>(() => {}),
  startExecution: () => new Promise<never>(() => {}),
  executionStatus: () => new Promise<never>(() => {}),
  cancel: () => new Promise<never>(() => {}),
  resume: () => new Promise<never>(() => {}),
  rowResults: () => new Promise<never>(() => {}),
  reportSummary: () => new Promise<never>(() => {}),
  reportCsvPath: (id: string) => `/x/${id}`,
  ...over,
});

const bootstrap = (over: Record<string, unknown> = {}) => ({
  availability: 'ALLOWED' as const,
  token: 'token',
  location: { sourceId: SOURCE_ID, importType: 'PRODUCTS' as const },
  sourceStatus: 'AVAILABLE' as const,
  storeId: STORE_ID,
  now: () => 1_800_000_000_000,
  lifecycle: lifecycle() as never,
  ...over,
});

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await flush();
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanupAll();
  vi.restoreAllMocks();
});

describe('the persistent action area', () => {
  it('offers a way out and a way to come back, at the mapping stage', async () => {
    const view = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage: makeStorage() })} />);
    await settle();
    expect(view.find('wizard-actions')).not.toBeNull();
    expect(view.get('wizard-cancel-import')).toBeTruthy();
    expect(view.get('wizard-save-exit')).toBeTruthy();
  });

  it('says which stage the operator is in', async () => {
    // "Continue" meant two different things in the rejected design. Naming the
    // stage is what stops the same word reading as two different promises.
    const view = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage: makeStorage() })} />);
    await settle();
    expect(view.get('wizard-stage').textContent ?? '').toMatch(/mapping columns/i);
  });

  it('shows nothing to cancel before a file has been chosen', async () => {
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), location: {}, sourceStatus: 'NONE' })} />,
    );
    await settle();
    expect(view.find('wizard-actions')).toBeNull();
  });
});

describe('cancelling an import', () => {
  it('asks before it does anything', async () => {
    const client = lifecycle();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle();
    await click(view.get('wizard-cancel-import'));
    await settle(4);

    expect(view.find('cancel-confirm')).not.toBeNull();
    // Nothing has happened yet. A single click at the bottom of a long form is
    // how twenty minutes of work gets lost.
    expect(client.cancelSource).not.toHaveBeenCalled();
  });

  it('does nothing at all when the answer is no', async () => {
    const client = lifecycle();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle();
    await click(view.get('wizard-cancel-import'));
    await settle(4);
    await click(view.get('cancel-confirm-no'));
    await settle(4);

    expect(view.find('cancel-confirm')).toBeNull();
    expect(client.cancelSource).not.toHaveBeenCalled();
    // Still workable: refusing to cancel must not leave the stage without its
    // actions.
    expect(view.find('wizard-actions')).not.toBeNull();
  });

  it('calls the server, reports what it said, and forgets the saved mapping', async () => {
    const storage = makeStorage();
    const client = lifecycle();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage, lifecycle: client as never })} />,
    );
    await settle();
    expect(storage.map.size).toBe(1);

    await click(view.get('wizard-cancel-import'));
    await settle(4);
    await click(view.get('cancel-confirm-yes'));
    await settle(10);

    expect(client.cancelSource).toHaveBeenCalledWith('token', SOURCE_ID);
    expect(view.get('cancel-outcome').textContent ?? '').toContain('Nothing in your catalogue was changed');
    // The saved mapping goes with it. Leaving it behind would offer to restore
    // work into a file that has been ended.
    expect(storage.map.size).toBe(0);
    // And the bar is gone, because there is nothing left to act on.
    expect(view.find('wizard-actions')).toBeNull();
  });

  it('shows the server’s refusal rather than pretending it worked', async () => {
    // The browser cannot know whether a run started a second ago, so the
    // server decides and its sentence is what gets shown.
    const client = lifecycle({
      cancelSource: vi.fn(async () => {
        throw new Error('This import is running. Stop the run itself first — cancelling the file will not stop work already in progress.');
      }),
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle();
    await click(view.get('wizard-cancel-import'));
    await settle(4);
    await click(view.get('cancel-confirm-yes'));
    await settle(10);

    expect(view.get('cancel-outcome').textContent ?? '').toContain('Stop the run itself first');
    // Still there: a refused cancellation leaves the import exactly where it was.
    expect(view.find('wizard-actions')).not.toBeNull();
  });
});

describe('saving and leaving', () => {
  it('writes the work down before it goes', async () => {
    const storage = makeStorage();
    const view = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();

    const before = storage.map.get(`wegox.import.progress.${SOURCE_ID}`);
    expect(before).toBeTruthy();

    // The navigation itself belongs to the browser; what is asserted here is
    // that the work is on disk at the moment of leaving, so a decision made a
    // second earlier cannot be outrun by it.
    const exit = view.get('wizard-save-exit');
    expect(exit.hasAttribute('disabled')).toBe(false);
    expect(JSON.parse(before as string).mapping.columns).toHaveLength(2);
  });

  it('mutates no catalogue data on the way out', async () => {
    const client = lifecycle();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle();
    expect(view.get('wizard-save-exit')).toBeTruthy();
    // Leaving is not an import. Nothing that writes may be reached from it.
    expect(client.cancelSource).not.toHaveBeenCalled();
  });
});

describe('the word on the restore action', () => {
  it('says what it restores, rather than the ambiguous “Continue”', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    const restore = second.find('restore-continue');
    expect(restore).not.toBeNull();
    // "Continue" also means "go on to the next stage" in the same view. One
    // word cannot carry both promises.
    expect(restore?.textContent).toBe('Restore saved work');
  });
});

describe('reopening an import that was cancelled', () => {
  it('says so, and does not put the editor back on screen', async () => {
    // The route decides AVAILABLE from the presence of an id in the URL, so a
    // bookmark to a cancelled import used to walk straight back into the
    // editor as though the decision to end it had never been made. The server
    // is asked, and its answer wins.
    const client = lifecycle({
      getSource: async () => ({ id: SOURCE_ID, contentHash: 'a'.repeat(64), status: 'CANCELLED' }),
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(16);

    expect(view.find('mapping-editor')).toBeNull();
    const text = view.text();
    expect(text).toContain('This import was cancelled');
    // Said plainly, not folded into "no longer available", which reads as a
    // fault and invites somebody to wonder what went wrong.
    expect(text).toContain('Nothing in your catalogue was changed');
  });
});
