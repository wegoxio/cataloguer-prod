import type { MappingState } from './mapping-state';
import type { ProgressScope } from './progress-hydration';
import type { TableMapping } from '../api/wizard-contract.types';

/**
 * Keeping a half-built mapping across a refresh.
 *
 * Mapping a forty-five column export is twenty minutes of decisions, and the
 * things that interrupt it are ordinary: a refresh, a stray navigation, a
 * session that has to be renewed. Losing that work is the difference between a
 * feature people use and one they dread, so the decisions are written down as
 * they are made.
 *
 * What is saved is deliberately narrow: **the decisions, never the data.**
 *
 *  - The mapping, the relationship rules and which region was open — small,
 *    and meaningless to anyone who does not also have the file.
 *  - NOT the sample rows. They are the customer's own prices and costs, and
 *    browser storage is readable by any script that reaches the page and
 *    survives long after the person has finished. The sample is re-fetched
 *    from the source instead.
 *  - NOT the preview. It is derived, it goes stale the moment anything changes,
 *    and restoring one would put a confident answer on screen that no longer
 *    describes the mapping beside it.
 *  - NOT the approval. Whatever was approved before the tab closed was approved
 *    against a target state we can no longer vouch for.
 */

/** Bumped when the saved shape changes, so an old entry is discarded rather than misread. */
export const PROGRESS_FORMAT = 3;

export interface SavedProgress {
  format: number;
  sourceId: string;
  importType: string;
  mapping: TableMapping;
  acknowledged: string[];
  focusedRegion: string;
  focusedColumnIndex: number | null;
  /**
   * The relationship decisions and which of them were confirmed.
   *
   * Saved beside the mapping rather than in their own entry, so a source has
   * ONE saved record and the two can never be restored out of step — a mapping
   * with a custody choice that belonged to a different mapping is worse than no
   * saved work at all.
   *
   * Optional because entries written before this existed are still readable;
   * they simply restore no relationship decisions.
   */
  relationships?: unknown;
  /**
   * What the decisions were made against.
   *
   * Saved so that restoring can REFUSE. Decisions are only meaningful beside
   * the file, the shop and the locations they were reviewed against, and an
   * entry that cannot prove which of those it belongs to has to be treated as
   * belonging to none of them.
   */
  scope: ProgressScope;
  /** Milliseconds since the epoch, supplied by the caller. */
  savedAt: number;
}

/** How long a saved mapping stays useful. */
export const PROGRESS_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = 'wegox.import.progress.';

export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function keyFor(sourceId: string): string {
  return `${KEY_PREFIX}${sourceId}`;
}

/**
 * Write the decisions made so far.
 *
 * Never throws. Storage can be full, disabled by policy, or unavailable in a
 * private window, and none of those is a reason to interrupt somebody's work —
 * the cost of failing silently here is that a refresh loses the mapping, which
 * is exactly what would happen without the feature at all.
 */
export function saveProgress(
  storage: ProgressStorage,
  state: MappingState,
  sourceId: string,
  now: number,
  scope: ProgressScope,
  relationships?: {
    decisions: unknown;
  },
): boolean {
  if (!sourceId) return false;
  try {
    const payload: SavedProgress = {
      format: PROGRESS_FORMAT,
      sourceId,
      importType: state.importType,
      mapping: state.mapping,
      acknowledged: state.acknowledged,
      focusedRegion: state.focusedRegion,
      focusedColumnIndex: state.focusedColumnIndex,
      ...(relationships ? { relationships: relationships.decisions } : {}),
      scope,
      savedAt: now,
    };
    storage.setItem(keyFor(sourceId), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read back what was saved for this source, if it is still usable.
 *
 * Every reason to reject is checked independently, because a corrupted or
 * outdated entry must produce a clean start rather than a broken editor.
 */
export function loadProgress(storage: ProgressStorage, sourceId: string, now: number): SavedProgress | null {
  if (!sourceId) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(keyFor(sourceId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isSavedProgress(parsed)) return null;
  // An entry written by an older build may mean something different now.
  if (parsed.format !== PROGRESS_FORMAT) return null;
  // A mapping from yesterday describes a catalogue that has moved on.
  if (now - parsed.savedAt > PROGRESS_TTL_MS) return null;
  // Belt and braces: the key could have been tampered with.
  if (parsed.sourceId !== sourceId) return null;

  return parsed;
}

export function clearProgress(storage: ProgressStorage, sourceId: string): void {
  try {
    storage.removeItem(keyFor(sourceId));
  } catch {
    /* nothing useful to do */
  }
}

/**
 * Remove entries that have aged out.
 *
 * Run on entry rather than on a timer. A mapping nobody came back to is a
 * record of somebody's catalogue structure sitting in browser storage, and it
 * should not sit there indefinitely because they never reopened the wizard.
 */
export function pruneExpired(storage: ProgressStorage, now: number): number {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(KEY_PREFIX)) keys.push(key);
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<SavedProgress>;
      const stale =
        typeof parsed.savedAt !== 'number' ||
        parsed.format !== PROGRESS_FORMAT ||
        now - parsed.savedAt > PROGRESS_TTL_MS;
      if (stale) {
        storage.removeItem(key);
        removed++;
      }
    } catch {
      // Unreadable entries are removed too: they cannot be restored and would
      // otherwise stay forever.
      try {
        storage.removeItem(key);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/**
 * What can be restored into the editor.
 *
 * Deliberately a partial state. The sample and the preview are absent, so the
 * editor asks for a fresh preview after restoring, and the person sees a
 * mapping that is currently being re-checked rather than one that claims to
 * have been checked.
 */
export function restorableFrom(saved: SavedProgress): Partial<MappingState> {
  return {
    mapping: saved.mapping,
    acknowledged: saved.acknowledged,
    focusedRegion: saved.focusedRegion as MappingState['focusedRegion'],
    focusedColumnIndex: saved.focusedColumnIndex,
    preview: null,
    previewError: null,
    approvalToken: null,
  };
}

function isSavedProgress(value: unknown): value is SavedProgress {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.format === 'number' &&
    typeof candidate.sourceId === 'string' &&
    typeof candidate.importType === 'string' &&
    typeof candidate.savedAt === 'number' &&
    Array.isArray(candidate.acknowledged) &&
    // An entry with no scope cannot prove which file, shop or company it
    // belongs to, so it is not restorable at any price.
    typeof candidate.scope === 'object' &&
    candidate.scope !== null &&
    Array.isArray((candidate.scope as Record<string, unknown>).headers) &&
    typeof candidate.mapping === 'object' &&
    candidate.mapping !== null &&
    Array.isArray((candidate.mapping as Record<string, unknown>).columns)
  );
}

/**
 * A one-line description of what would be restored.
 *
 * Restoring silently would be its own surprise: someone who expected a fresh
 * start would build on decisions they do not remember making. So the editor
 * offers it rather than assuming it.
 */
export function describeProgress(saved: SavedProgress, now: number): string {
  const mapped = saved.mapping.columns.filter((c) => c.field !== null).length;
  const minutes = Math.max(1, Math.round((now - saved.savedAt) / 60_000));
  const when = minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : 'earlier today';
  return `You mapped ${mapped} column${mapped === 1 ? '' : 's'} of this file ${when}. Continue where you left off?`;
}
