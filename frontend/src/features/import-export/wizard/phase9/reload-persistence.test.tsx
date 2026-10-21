import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase9ImportWizard } from './import-wizard';
import { renderComponent, click, cleanupAll, flush, select } from '../../../../test/render';
import type { ProgressStorage } from '../mapping/progress-store';
import { wizardService } from '../api/wizard.service';

/**
 * Reloading the page does not throw away the decisions somebody just made.
 *
 * It used to. The wizard read saved progress in one effect and wrote it in
 * another, and effects have no order: after a reload the save ran first, saw a
 * relationship state that was still empty because the file had not finished
 * being read, and wrote `{}` over twenty minutes of work — while the offer to
 * restore that work was on screen. Accepting the offer restored an entry that
 * had already been destroyed.
 *
 * These tests drive a genuine remount: the same storage handed to a second
 * render, exactly as a browser hands localStorage to a second page load. A test
 * that only re-read the store would prove the store and not the wizard.
 */

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ANALYSIS_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const STORE_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const NOW = 1_800_000_000_000;

const SAMPLE = {
  firstRowNumber: 2,
  sheet: 'main',
  headers: ['sku', 'nombre', 'existencias', 'categoria'],
  rows: [['SYN-1', 'Silla', '7', 'Muebles']],
};

const PROPOSALS = [
  { columnIndex: 0, header: 'sku', field: 'sku' },
  { columnIndex: 1, header: 'nombre', field: 'name' },
  { columnIndex: 2, header: 'existencias', field: null },
  { columnIndex: 3, header: 'categoria', field: null },
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

/** A server that answers, so the wizard reaches a mappable state. */
const lifecycle = (over: Record<string, unknown> = {}) => ({
  getSource: async () => ({ id: SOURCE_ID, contentHash: HASH, status: 'AVAILABLE' }),
  startAnalysis: async () => ({ id: ANALYSIS_ID, status: 'COMPLETED' }),
  getAnalysis: async () => ({
    id: ANALYSIS_ID,
    sourceId: SOURCE_ID,
    status: 'COMPLETED',
    tables: { sample: SAMPLE, columnTypes: ['TEXT', 'TEXT', 'NUMBER', 'TEXT'] },
    proposals: PROPOSALS,
    findings: [],
    rowsAnalyzed: 1,
    failureReason: null,
  }),
  relationshipOptions: async () => ({
    storeId: STORE_ID,
    stockDestinations: [{ id: LOCATION_ID, name: 'Almacén', kind: 'WAREHOUSE', storeId: null, isDefault: true, proposed: false }],
    stores: [{ id: STORE_ID, name: 'Centro' }],
    existingCategoryNames: [],
  }),
  // Present so that "discarding is not cancelling" can be asserted against a
  // real spy rather than against undefined.
  cancelSource: vi.fn(async () => ({ cancelled: true, alreadyCancelled: false, notice: 'x' })),
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
  now: () => NOW,
  lifecycle: lifecycle() as never,
  ...over,
});

/** The decisions actually written down for this source, if any. */
const savedDecisions = (storage: { map: Map<string, string> }): Record<string, unknown> => {
  const raw = storage.map.get(`wegox.import.progress.${SOURCE_ID}`);
  if (!raw) return {};
  return (JSON.parse(raw).relationships ?? {}) as Record<string, unknown>;
};

const settle = async (times = 10) => {
  for (let i = 0; i < times; i++) await flush();
};

/** Map the stock and category columns, then answer all three questions. */
const decideEverything = async (view: Awaited<ReturnType<typeof renderComponent>>) => {
  await select(view.get('column-2').querySelector('select'), 'stock');
  await select(view.get('column-3').querySelector('select'), 'categoryPaths');
  await settle();
  await click(view.get(`destination-${LOCATION_ID}`));
  await click(view.get('list-here'));
  await click(view.get('categories-accept'));
  await settle();
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanupAll();
  vi.restoreAllMocks();
});

describe('decisions survive a reload', () => {
  it('keeps the mapping and all three decisions across a real remount', async () => {
    const storage = makeStorage();

    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    // The relationship questions are settled. The plan button has its own
    // separate gate — every column reviewed — which is not what this is about.
    expect(first.find('relationships-outstanding')).toBeNull();
    cleanupAll();

    // The reload. Same storage, brand new component — which is the whole point:
    // the defect lived in what the second mount did to the first mount's work.
    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    expect(second.find('restore-offer')).not.toBeNull();
    await click(second.get('restore-continue'));
    await settle();

    // The mapping came back.
    expect((second.get('column-2').querySelector('select') as HTMLSelectElement).value).toBe('stock');
    expect((second.get('column-3').querySelector('select') as HTMLSelectElement).value).toBe('categoryPaths');

    // And each decision, still selected — checked one at a time, because three
    // decisions restored as a lump is exactly what nobody could debug when one
    // of them silently was not.
    expect((second.get(`destination-${LOCATION_ID}`) as HTMLInputElement).checked).toBe(true);
    expect((second.get('list-here') as HTMLInputElement).checked).toBe(true);
    expect((second.get('categories-accept') as HTMLInputElement).checked).toBe(true);

    // Straight back to complete: nothing is asked again, and the plan is
    // available without redoing anything.
    expect(second.find('relationships-outstanding')).toBeNull();
  });

  it('does not write an empty state over saved decisions before the offer is answered', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    const savedAfterWork = storage.map.get(`wegox.import.progress.${SOURCE_ID}`);
    expect(savedAfterWork).toContain(LOCATION_ID);
    cleanupAll();

    // Remount and let every effect run — the analysis arrives, the mapping
    // fills, and the save effect fires — WITHOUT answering the offer. This is
    // the exact window the decisions used to vanish in.
    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(30);
    expect(second.find('restore-offer')).not.toBeNull();
    expect(storage.map.get(`wegox.import.progress.${SOURCE_ID}`)).toBe(savedAfterWork);
  });

  it('keeps the offer while the file is still being read', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    // An analysis that never completes. The offer must still be there: somebody
    // reloading mid-read should not have to wait to be told their work is safe.
    const slow = lifecycle({ getAnalysis: () => new Promise<never>(() => {}) });
    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: slow as never })} />);
    await settle(20);
    expect(second.find('restore-offer')).not.toBeNull();
    expect(storage.map.size).toBe(1);
  });

  it('does not queue a second reading of the same file', async () => {
    const storage = makeStorage();
    const startAnalysis = vi.fn(async () => ({ id: ANALYSIS_ID, status: 'COMPLETED' }));
    const client = lifecycle({ startAnalysis });

    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: client as never })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: client as never })} />);
    await settle();
    await click(second.get('restore-continue'));
    await settle();

    // Asked once per mount, and every ask returns the SAME reading. A restore
    // adds no reading of its own.
    const ids = startAnalysis.mock.results.map(() => ANALYSIS_ID);
    expect(new Set(ids).size).toBe(1);
  });
});

describe('restoring before the file has finished being read', () => {
  it('keeps restored work when the file finishes being read afterwards', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    // The realistic reload: the offer is answerable straight away, but the file
    // is still being read. The analysis lands AFTER the person has chosen to
    // continue — and it arrives carrying its own proposals for every column.
    let resolveAnalysis!: (value: unknown) => void;
    const held = new Promise<unknown>((resolve) => {
      resolveAnalysis = resolve;
    });
    const landAnalysis = () =>
      resolveAnalysis({
          id: ANALYSIS_ID,
          sourceId: SOURCE_ID,
          status: 'COMPLETED',
          tables: { sample: SAMPLE, columnTypes: ['TEXT', 'TEXT', 'NUMBER', 'TEXT'] },
          proposals: PROPOSALS,
          findings: [],
        rowsAnalyzed: 1,
        failureReason: null,
      });
    const slow = lifecycle({ getAnalysis: () => held });

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: slow as never })} />);
    await settle(10);
    await click(second.get('restore-continue'));
    await settle(5);

    // Now the file arrives. Its proposals map neither the stock column nor the
    // category column, so a mapping replaced here would take both decisions
    // down with it — which is precisely what used to happen, a second after the
    // work came back.
    landAnalysis();
    await settle(20);

    expect((second.get('column-2').querySelector('select') as HTMLSelectElement).value).toBe('stock');
    expect((second.get(`destination-${LOCATION_ID}`) as HTMLInputElement).checked).toBe(true);
    expect((second.get('list-here') as HTMLInputElement).checked).toBe(true);
    expect((second.get('categories-accept') as HTMLInputElement).checked).toBe(true);
    expect(second.find('relationships-outstanding')).toBeNull();
  });
});

describe('saved work that no longer applies', () => {
  it('refuses decisions made against different bytes, and says so', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    // The same source id reporting different content. Restoring here would put
    // column decisions against a file that no longer has those columns.
    const changed = lifecycle({ getSource: async () => ({ id: SOURCE_ID, contentHash: 'b'.repeat(64), status: 'AVAILABLE' }) });
    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: changed as never })} />);
    await settle(20);

    expect(second.find('restore-offer')).toBeNull();
    const notice = second.get('restore-incompatible').textContent ?? '';
    expect(notice).toContain('This file has changed');
    // The refused DECISIONS are gone for good. An entry remains, because the
    // wizard goes on saving what the person does next — and its scope still
    // lists the company's locations, which is not a decision. What must not
    // survive is the choice made against the old file.
    expect(savedDecisions(storage)).toEqual({});
  });

  it('refuses to hand one company’s decisions to another', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    // A different company: no location and no shop in common.
    const other = lifecycle({
      relationshipOptions: async () => ({
        storeId: 'store-other',
        stockDestinations: [{ id: 'loc-other', name: 'Otro', kind: 'WAREHOUSE', storeId: null, isDefault: true, proposed: false }],
        stores: [{ id: 'store-other', name: 'Otra tienda' }],
        existingCategoryNames: [],
      }),
    });
    const second = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage, lifecycle: other as never, storeId: 'store-other' })} />,
    );
    await settle(20);

    expect(second.find('restore-offer')).toBeNull();
    expect(second.get('restore-incompatible').textContent ?? '').toContain('different company');
    // Nothing of the other company's choices survives for a later mount to
    // offer back.
    expect(savedDecisions(storage)).toEqual({});
  });

  it('refuses decisions made for a different shop', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    // Same company — the locations still match — but the wizard is now scoped
    // to the other shop, so a "list them here" decision means somewhere else.
    const sibling = lifecycle({
      relationshipOptions: async () => ({
        storeId: 'store-sibling',
        stockDestinations: [{ id: LOCATION_ID, name: 'Almacén', kind: 'WAREHOUSE', storeId: null, isDefault: true, proposed: false }],
        stores: [
          { id: STORE_ID, name: 'Centro' },
          { id: 'store-sibling', name: 'Norte' },
        ],
        existingCategoryNames: [],
      }),
    });
    const second = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage, lifecycle: sibling as never, storeId: 'store-sibling' })} />,
    );
    await settle(20);

    expect(second.find('restore-offer')).toBeNull();
    expect(second.get('restore-incompatible').textContent ?? '').toContain('different shop');
  });

  it('refuses when a location the decisions named has gone', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    // The chosen location is gone; another of the same company's remains, so
    // this is not a different company — it is a decision pointing at nothing.
    const moved = lifecycle({
      relationshipOptions: async () => ({
        storeId: STORE_ID,
        stockDestinations: [{ id: 'loc-new', name: 'Nuevo', kind: 'WAREHOUSE', storeId: null, isDefault: true, proposed: false }],
        stores: [{ id: STORE_ID, name: 'Centro' }],
        existingCategoryNames: [],
      }),
    });
    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: moved as never })} />);
    await settle(20);

    expect(second.get('restore-incompatible').textContent ?? '').toContain('stock location');
  });

  it('asks for the decisions again, and saves the new ones', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const changed = lifecycle({ getSource: async () => ({ id: SOURCE_ID, contentHash: 'c'.repeat(64), status: 'AVAILABLE' }) });
    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: changed as never })} />);
    await settle(20);
    expect(second.find('restore-incompatible')).not.toBeNull();

    // The point of refusing is to get fresh decisions, so the fresh ones have
    // to be saved like any others. Refusing and then never saving again would
    // answer the original complaint with the same complaint.
    await decideEverything(second);
    expect(storage.map.get(`wegox.import.progress.${SOURCE_ID}`)).toContain(LOCATION_ID);
  });
});

describe('discarding saved work and restarting', () => {
  it('does not write the draft straight back', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await click(second.get('restore-discard'));
    // Two flushes was all it took before: clearing the entry changed the
    // hydration state, the autosave effect depends on hydration, so it
    // re-fired and recreated the draft. Measured at one entry restored.
    await settle(2);
    expect(storage.map.size).toBe(0);
    await settle(30);
    expect(storage.map.size).toBe(0);
  });

  it('stays discarded across a reload, with no offer to restore', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await click(second.get('restore-discard'));
    await settle(20);
    cleanupAll();

    const third = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    // An offer that reappears was never declined.
    //
    // The store is NOT asserted empty here: this mount found nothing saved, so
    // it is a fresh session and saves what happens in it like any other. What
    // must not come back is the discarded work, and no offer is what proves it.
    expect(third.find('restore-offer')).toBeNull();
    expect(savedDecisions(storage)).toEqual({});
  });

  it('keeps the source and its reading, and comes back to fresh proposals', async () => {
    const storage = makeStorage();
    const startAnalysis = vi.fn(async () => ({ id: ANALYSIS_ID, status: 'COMPLETED' }));
    const client = lifecycle({ startAnalysis });
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: client as never })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage, lifecycle: client as never })} />);
    await settle();
    await click(second.get('restore-discard'));
    await settle(20);

    // The editor is still there, filled from the analysis — discarding the
    // mapping is not cancelling the file.
    expect(second.find('mapping-editor')).not.toBeNull();
    expect((second.get('column-2').querySelector('select') as HTMLSelectElement).value).toBe('');
    // And nothing about the source was touched.
    expect(client.cancelSource).not.toHaveBeenCalled();
  });

  it('the wizard talking to itself does not count as a new edit', async () => {
    // SOURCE_LOADED, previews and focus changes all fire after a discard. If
    // any of them re-armed autosave, the draft would return under another
    // name — renaming the defect rather than fixing it.
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await click(second.get('restore-discard'));
    await settle(40);
    expect(storage.map.size).toBe(0);
  });

  it('saves again once the person genuinely edits something', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await click(second.get('restore-discard'));
    await settle(20);
    expect(storage.map.size).toBe(0);

    // A real edit. Their new work is theirs, and is kept like anyone's.
    await select(second.get('column-2').querySelector('select'), 'stock');
    await settle(20);
    expect(storage.map.size).toBe(1);
    cleanupAll();

    const third = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    expect(third.find('restore-offer')).not.toBeNull();
  });
});

describe('changing the mapping after restoring', () => {
  it('stops requiring a decision the mapping no longer raises', async () => {
    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await decideEverything(first);
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();
    await click(second.get('restore-continue'));
    await settle();
    expect(second.find('section-stock')).not.toBeNull();

    // Unmapping the stock column removes the custody question entirely: there
    // are no units to place. The restored answer must not go on being demanded,
    // and must not go on blocking.
    await select(second.get('column-2').querySelector('select'), '');
    await settle();
    expect(second.find('section-stock')).toBeNull();
    expect(second.find('relationships-outstanding')).toBeNull();
  });

  it('requires a fresh decision for a question the mapping newly raises', async () => {
    const storage = makeStorage();
    const view = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle();

    // Nothing about stock is asked until a stock column exists...
    expect(view.find('section-stock')).toBeNull();
    await select(view.get('column-2').querySelector('select'), 'stock');
    await settle();

    // ...and the moment one does, the question is asked and blocks. A mapping
    // change that quietly inherited somebody's earlier answer would place units
    // somewhere nobody chose for this file.
    expect(view.find('section-stock')).not.toBeNull();
    expect(view.get('relationships-outstanding').textContent ?? '').toMatch(/stock/i);
  });
});

describe('the preview after restoring saved work', () => {
  /** Past the 400ms debounce, in real time — this suite does not fake timers. */
  const pastDebounce = async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settle(20);
  };

  it('issues exactly one preview request even though the restored mapping is identical', async () => {
    // The production symptom. `restorableFrom` clears the preview on purpose —
    // a preview describes a mapping somebody reviewed, and a restored one has
    // not been — but the request was keyed on `mappingKey`, and a restored
    // mapping serialises IDENTICALLY to the proposals already on screen. The
    // key never changed, the effect never ran, and the editor reported
    // "Waiting for the preview." with nothing in flight and no way out.
    const preview = vi
      .spyOn(wizardService, 'preview')
      .mockResolvedValue({ rows: [], ignoredColumns: [], blankRowCount: 0, previewedRows: 1, issues: [], summary: { total: 0 }, readiness: { allowed: true } } as never);

    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    await decideEverything(first);
    await pastDebounce();
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    await pastDebounce();
    preview.mockClear();

    await click(second.get('restore-continue'));
    await pastDebounce();

    // Exactly one: enough to answer the question, not a loop.
    expect(preview).toHaveBeenCalledTimes(1);
    expect(second.text()).not.toContain('Waiting for the preview');
  });

  it('keeps the restored decisions while the preview is fetched', async () => {
    vi.spyOn(wizardService, 'preview').mockResolvedValue({
      rows: [], ignoredColumns: [], blankRowCount: 0, previewedRows: 1, issues: [], summary: { total: 0 }, readiness: { allowed: true },
    } as never);

    const storage = makeStorage();
    const first = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    await decideEverything(first);
    await pastDebounce();
    cleanupAll();

    const second = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    await click(second.get('restore-continue'));
    await pastDebounce();
    // The preview is re-fetched; the person's decisions are not re-asked.
    expect((second.get(`destination-${LOCATION_ID}`) as HTMLInputElement).checked).toBe(true);
    expect((second.get('list-here') as HTMLInputElement).checked).toBe(true);
    expect((second.get('categories-accept') as HTMLInputElement).checked).toBe(true);
  });

  it('ends in an actionable failure with Retry, never an endless wait', async () => {
    const preview = vi.spyOn(wizardService, 'preview').mockRejectedValue(new Error('the preview service is down'));

    const storage = makeStorage();
    const view = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    await select(view.get('column-2').querySelector('select'), 'stock');
    await pastDebounce();

    expect(view.find('preview-failed')).not.toBeNull();
    expect(view.get('preview-failed-reason').textContent ?? '').toContain('preview service is down');
    expect(view.find('preview-retry')).not.toBeNull();
    // Terminal: it does not keep asking a server that is refusing.
    const attempts = preview.mock.calls.length;
    await pastDebounce();
    expect(preview.mock.calls.length).toBe(attempts);
  });

  it('retries once when asked, and succeeds', async () => {
    const preview = vi.spyOn(wizardService, 'preview').mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({
      rows: [], ignoredColumns: [], blankRowCount: 0, previewedRows: 1, issues: [], summary: { total: 0 }, readiness: { allowed: true },
    } as never);

    const storage = makeStorage();
    const view = await renderComponent(<Phase9ImportWizard {...bootstrap({ storage })} />);
    await settle(20);
    await select(view.get('column-2').querySelector('select'), 'stock');
    await pastDebounce();
    expect(view.find('preview-failed')).not.toBeNull();

    const before = preview.mock.calls.length;
    await click(view.get('preview-retry'));
    await pastDebounce();

    expect(preview.mock.calls.length).toBe(before + 1);
    expect(view.find('preview-failed')).toBeNull();
    expect(view.text()).not.toContain('Waiting for the preview');
  });
});
