import { describe, expect, it } from 'vitest';
import {
  PROGRESS_FORMAT,
  PROGRESS_TTL_MS,
  ProgressStorage,
  clearProgress,
  describeProgress,
  loadProgress,
  pruneExpired,
  restorableFrom,
  saveProgress,
} from './progress-store';
import type { ProgressScope } from './progress-hydration';
import { initialMappingState, mappingReducer, type MappingState } from './mapping-state';

/**
 * Keeping a half-built mapping across a refresh.
 *
 * The property that matters most is what is NOT saved: the sample rows are the
 * customer's own prices and costs, and browser storage is readable by any
 * script that reaches the page and survives long after the person has finished.
 */

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

/**
 * What the saved decisions were made against.
 *
 * Every entry carries one. An entry that cannot say which file, shop and
 * company it belongs to is not restorable at any price, so there is no such
 * thing as a scopeless save to test.
 */
const SCOPE: ProgressScope = {
  sourceId: SOURCE_ID,
  importType: 'PRODUCTS',
  sourceHash: 'a'.repeat(64),
  analysisId: '22222222-2222-4222-8222-222222222222',
  sheet: 'main',
  headerRow: 1,
  headers: ['sku', 'nombre'],
  storeId: null,
  locationIds: ['33333333-3333-4333-8333-333333333333'],
  storeIds: ['44444444-4444-4444-8444-444444444444'],
};

/** A storage that behaves, and can be told to misbehave. */
function makeStorage(options: { failWrites?: boolean; failReads?: boolean } = {}): ProgressStorage & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => {
      if (options.failReads) throw new Error('storage unavailable');
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.failWrites) throw new Error('quota exceeded');
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function stateWithWork(): MappingState {
  let state = initialMappingState('PRODUCTS');
  state = mappingReducer(state, {
    type: 'SOURCE_LOADED',
    sample: {
      sheet: 'Productos',
      firstRowNumber: 2,
      headers: ['Nombre', 'Precio'],
      // Real customer values, so the test can prove they never leave the page.
      rows: [['Camiseta secreta', '1234.50']],
    },
    columnTypes: ['TEXT', 'DECIMAL'],
    proposals: [
      { columnIndex: 0, header: 'Nombre', field: 'name' },
      { columnIndex: 1, header: 'Precio', field: 'price' },
    ],
  });
  return mappingReducer(state, { type: 'FIELD_ASSIGNED', columnIndex: 0, field: 'name' });
}

describe('what is written down', () => {
  it('saves the decisions', () => {
    const storage = makeStorage();
    expect(saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE)).toBe(true);

    const saved = loadProgress(storage, SOURCE_ID, NOW);
    expect(saved?.mapping.columns).toHaveLength(2);
    expect(saved?.importType).toBe('PRODUCTS');
  });

  it('NEVER saves the customer’s own data', () => {
    // Browser storage is readable by any script that reaches the page and
    // survives long after the person has finished.
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);

    const raw = Array.from(storage.map.values()).join('');
    expect(raw).not.toContain('Camiseta secreta');
    expect(raw).not.toContain('1234.50');
    expect(raw).not.toContain('rows');
  });

  it('never saves a preview', () => {
    // It is derived, goes stale the moment anything changes, and restoring one
    // would put a confident answer beside a mapping it no longer describes.
    const storage = makeStorage();
    const withPreview = mappingReducer(stateWithWork(), {
      type: 'PREVIEW_SUCCEEDED',
      preview: {
        rows: [],
        ignoredColumns: [],
        blankRowCount: 0,
        previewedRows: 0,
        issues: [],
        summary: { blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0, total: 0 },
        readiness: { allowed: true },
      },
    });
    saveProgress(storage, withPreview, SOURCE_ID, NOW, SCOPE);
    expect(Array.from(storage.map.values()).join('')).not.toContain('readiness');
  });

  it('never saves an approval', () => {
    const storage = makeStorage();
    const approved = mappingReducer(stateWithWork(), { type: 'APPROVAL_GRANTED', token: 'proof-secret' });
    saveProgress(storage, approved, SOURCE_ID, NOW, SCOPE);
    expect(Array.from(storage.map.values()).join('')).not.toContain('proof-secret');
  });

  it('keeps which region and column the person was looking at', () => {
    const storage = makeStorage();
    let state = mappingReducer(stateWithWork(), { type: 'REGION_FOCUSED', region: 'ISSUES' });
    state = mappingReducer(state, { type: 'COLUMN_FOCUSED', columnIndex: 1 });
    saveProgress(storage, state, SOURCE_ID, NOW, SCOPE);

    const saved = loadProgress(storage, SOURCE_ID, NOW);
    expect(saved?.focusedRegion).toBe('ISSUES');
    expect(saved?.focusedColumnIndex).toBe(1);
  });
});

describe('when storage will not cooperate', () => {
  it('never throws on a failed write', () => {
    // Quota, private windows and policy all fail here, and none of them is a
    // reason to interrupt somebody's work.
    const storage = makeStorage({ failWrites: true });
    expect(() => saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE)).not.toThrow();
    expect(saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE)).toBe(false);
  });

  it('never throws on a failed read', () => {
    const storage = makeStorage({ failReads: true });
    expect(() => loadProgress(storage, SOURCE_ID, NOW)).not.toThrow();
    expect(loadProgress(storage, SOURCE_ID, NOW)).toBeNull();
  });

  it('refuses to save without a source to key it to', () => {
    const storage = makeStorage();
    expect(saveProgress(storage, stateWithWork(), '', NOW, SCOPE)).toBe(false);
    expect(storage.map.size).toBe(0);
  });
});

describe('what will not be restored', () => {
  it('discards an entry written by an older build', () => {
    // Its shape may mean something different now.
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    const key = Array.from(storage.map.keys())[0];
    storage.map.set(key, JSON.stringify({ ...JSON.parse(storage.map.get(key)!), format: PROGRESS_FORMAT - 1 }));

    expect(loadProgress(storage, SOURCE_ID, NOW)).toBeNull();
  });

  it('discards a mapping older than a day', () => {
    // It describes a catalogue that has moved on.
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    expect(loadProgress(storage, SOURCE_ID, NOW + PROGRESS_TTL_MS + 1)).toBeNull();
    expect(loadProgress(storage, SOURCE_ID, NOW + PROGRESS_TTL_MS - 1)).not.toBeNull();
  });

  it('discards unparseable content rather than breaking the editor', () => {
    const storage = makeStorage();
    storage.map.set('wegox.import.progress.' + SOURCE_ID, 'not json at all');
    expect(loadProgress(storage, SOURCE_ID, NOW)).toBeNull();
  });

  it('discards an entry missing the parts it needs', () => {
    const storage = makeStorage();
    storage.map.set('wegox.import.progress.' + SOURCE_ID, JSON.stringify({ format: PROGRESS_FORMAT }));
    expect(loadProgress(storage, SOURCE_ID, NOW)).toBeNull();
  });

  it('discards an entry whose stored id does not match its key', () => {
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    const key = Array.from(storage.map.keys())[0];
    storage.map.set(key, JSON.stringify({ ...JSON.parse(storage.map.get(key)!), sourceId: 'someone-elses' }));
    expect(loadProgress(storage, SOURCE_ID, NOW)).toBeNull();
  });

  it('returns nothing for a source that was never saved', () => {
    expect(loadProgress(makeStorage(), SOURCE_ID, NOW)).toBeNull();
  });
});

describe('restoring', () => {
  it('brings back the mapping and the acknowledgements', () => {
    const storage = makeStorage();
    let state = mappingReducer(stateWithWork(), { type: 'ISSUE_ACKNOWLEDGED', code: 'W1' });
    saveProgress(storage, state, SOURCE_ID, NOW, SCOPE);

    const saved = loadProgress(storage, SOURCE_ID, NOW)!;
    const restorable = restorableFrom(saved);
    expect(restorable.mapping?.columns).toHaveLength(2);
    expect(restorable.acknowledged).toEqual(['W1']);
  });

  it('brings back NO preview, so the editor re-checks rather than claiming to have checked', () => {
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    const restorable = restorableFrom(loadProgress(storage, SOURCE_ID, NOW)!);
    expect(restorable.preview).toBeNull();
    expect(restorable.approvalToken).toBeNull();
  });

  it('feeds cleanly back into the reducer', () => {
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    const restored = mappingReducer(initialMappingState('PRODUCTS'), {
      type: 'RESTORED',
      state: restorableFrom(loadProgress(storage, SOURCE_ID, NOW)!),
    });
    expect(restored.mapping.columns).toHaveLength(2);
    expect(restored.approvalToken).toBeNull();
    expect(restored.previewing).toBe(false);
  });

  it('is OFFERED rather than assumed, in one sentence', () => {
    // Restoring silently would be its own surprise: someone expecting a fresh
    // start would build on decisions they do not remember making.
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    const saved = loadProgress(storage, SOURCE_ID, NOW)!;
    expect(describeProgress(saved, NOW + 5 * 60_000)).toBe(
      'You mapped 2 columns of this file 5 minutes ago. Continue where you left off?',
    );
  });

  it('says "earlier today" rather than counting a hundred minutes', () => {
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    const saved = loadProgress(storage, SOURCE_ID, NOW)!;
    expect(describeProgress(saved, NOW + 3 * 60 * 60_000)).toContain('earlier today');
  });
});

describe('clearing up', () => {
  it('forgets one source on request', () => {
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    clearProgress(storage, SOURCE_ID);
    expect(loadProgress(storage, SOURCE_ID, NOW)).toBeNull();
  });

  it('removes entries that have aged out', () => {
    // A mapping nobody came back to is a record of somebody's catalogue
    // structure sitting in storage; it should not stay because they never
    // reopened the wizard.
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    saveProgress(storage, stateWithWork(), '22222222-2222-4222-8222-222222222222', NOW, SCOPE);

    expect(pruneExpired(storage, NOW + PROGRESS_TTL_MS + 1)).toBe(2);
    expect(storage.map.size).toBe(0);
  });

  it('keeps entries that are still fresh', () => {
    const storage = makeStorage();
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    expect(pruneExpired(storage, NOW + 60_000)).toBe(0);
    expect(storage.map.size).toBe(1);
  });

  it('removes an unreadable entry, which could never be restored anyway', () => {
    const storage = makeStorage();
    storage.map.set('wegox.import.progress.broken', '{{{');
    expect(pruneExpired(storage, NOW)).toBe(1);
  });

  it('leaves other applications’ storage alone', () => {
    const storage = makeStorage();
    storage.map.set('something.else', 'value');
    saveProgress(storage, stateWithWork(), SOURCE_ID, NOW, SCOPE);
    pruneExpired(storage, NOW + PROGRESS_TTL_MS + 1);
    expect(storage.map.get('something.else')).toBe('value');
  });

  it('survives storage that throws while being enumerated', () => {
    const storage = makeStorage({ failReads: true });
    expect(() => pruneExpired(storage, NOW)).not.toThrow();
  });
});

describe('relationship decisions survive a reload', () => {
  /**
   * The custody choice, the shop association and the category confirmation are
   * saved WITH the mapping they were made against. A reload that lost them
   * would silently drop a decision somebody had already made, and restoring
   * them separately could pair a custody choice with a mapping it was never
   * reviewed against.
   */
  const storage = () => {
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
  };

  const state = initialMappingState('PRODUCTS');
  const decisions = { inventory: { defaultLocationId: 'loc-1' }, stores: { storeIds: ['store-1'] } };

  it('round-trips the decisions and their confirmations', () => {
    const s = storage();
    saveProgress(s, state, 'source-1', 1000, SCOPE, { decisions });

    const back = loadProgress(s, 'source-1', 1000);
    expect(back?.relationships).toEqual(decisions);
  });

  it('restores them in the same record as the mapping, never separately', () => {
    const s = storage();
    saveProgress(s, state, 'source-1', 1000, SCOPE, { decisions });

    // One key per source: the mapping and the decisions cannot be restored out
    // of step because there is nothing to restore them out of step WITH.
    expect(s.map.size).toBe(1);
  });

  it('reads an entry written before relationships existed, without inventing them', () => {
    const s = storage();
    saveProgress(s, state, 'source-1', 1000, SCOPE);

    const back = loadProgress(s, 'source-1', 1000);
    expect(back).not.toBeNull();
    expect(back?.relationships).toBeUndefined();
  });

  it('drops them with the rest when the entry expires', () => {
    const s = storage();
    saveProgress(s, state, 'source-1', 1000, SCOPE, { decisions });

    expect(loadProgress(s, 'source-1', 1000 + PROGRESS_TTL_MS + 1)).toBeNull();
  });
});
