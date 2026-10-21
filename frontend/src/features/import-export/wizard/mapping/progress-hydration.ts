import type { SavedProgress } from './progress-store';

/**
 * Whether saved work has been dealt with yet, and what it is.
 *
 * This exists because "is there saved progress?" was answered with a nullable
 * offer, and a nullable offer cannot tell "we have not looked yet" from "we
 * looked and there is nothing". The wizard treated both as nothing, so its
 * autosave ran on the first frame after a reload — before the analysis had
 * arrived, while the relationship decisions were still empty — and wrote `{}`
 * over decisions somebody had spent twenty minutes making. The offer was still
 * on screen at the time. Accepting it restored an entry that had already been
 * overwritten.
 *
 * So hydration is a state machine with six states, and autosave is allowed in
 * exactly the three where nothing can be lost by writing.
 */
export type Hydration =
  /** Storage has not been read yet. Nothing may be written. */
  | { kind: 'LOADING' }
  /** Read, and there was nothing saved for this source. */
  | { kind: 'NONE' }
  /** Saved work exists and the person has neither taken it nor refused it. */
  | { kind: 'OFFERED'; saved: SavedProgress; description: string }
  /**
   * Saved work exists but no longer describes this import. It is NOT offered,
   * because restoring it would put decisions beside a file, a shop or a set of
   * locations they were never made against.
   */
  | { kind: 'INCOMPATIBLE'; reasons: string[] }
  /**
   * The person took it.
   *
   * Carries the scope it was taken under, because the file may still be being
   * read: an offer is answerable before the analysis lands, so the verdict has
   * to stay checkable after the answer.
   */
  | { kind: 'RESTORED'; scope: ProgressScope }
  /**
   * The person discarded it, and nothing has been done since.
   *
   * Autosave is BLOCKED here, and that is the whole point. Clearing the entry
   * changes the hydration state, the autosave effect lists hydration among its
   * dependencies, and so it re-fired and wrote the draft straight back —
   * measured at one entry restored within two flushes, with the restore offer
   * returning on the next reload. "Start again" did not start again.
   *
   * The fix is a state, not a delay. A timer would be a race with a different
   * number in it.
   */
  | { kind: 'DISCARDED_UNTOUCHED' }
  /**
   * Discarded, and then the person changed something themselves.
   *
   * Their new work is theirs and is saved like anyone's. Reaching this state
   * requires a genuine edit — a field assigned, a decision made. The reducer
   * actions the wizard issues to itself while loading a file do not count, or
   * the discarded draft would come back under a different name.
   */
  | { kind: 'DIRTY_AFTER_DISCARD' };

/**
 * Whether the wizard may write to storage.
 *
 * The whole point: `LOADING` and `OFFERED` are the two states in which a write
 * destroys something, and they are the two that return false. Everything else
 * has already resolved what was there.
 */
export function mayAutosave(hydration: Hydration): boolean {
  switch (hydration.kind) {
    // Nothing may be written before we know what is already there, and nothing
    // while an unanswered offer stands: both destroy something.
    case 'LOADING':
    case 'OFFERED':
      return false;
    // Discarded and untouched. Writing here recreates exactly what the person
    // just threw away.
    case 'DISCARDED_UNTOUCHED':
      return false;
    // `INCOMPATIBLE` allows writing: the entry it refused has already been
    // removed, so there is nothing left to destroy — and blocking would mean
    // the decisions somebody is being asked to make again are never saved.
    case 'INCOMPATIBLE':
    case 'NONE':
    case 'RESTORED':
    case 'DIRTY_AFTER_DISCARD':
      return true;
  }
}

/**
 * Whether a reducer action is a person changing something.
 *
 * Only these lift `DISCARDED_UNTOUCHED`. The wizard issues plenty of actions to
 * itself — loading the file, filling the editor, restoring, focusing — and if
 * any of those counted as an edit the discarded draft would reappear under
 * another name, which is the defect this exists to prevent rather than rename.
 */
export function isUserEdit(actionType: string): boolean {
  return [
    'FIELD_ASSIGNED',
    'COLUMN_IGNORED',
    'HEADER_ROW_CHANGED',
    'TRANSFORMATION_ADDED',
    'TRANSFORMATION_REMOVED',
    'TRANSFORMATION_MOVED',
    'TRANSFORMATION_OPTION_SET',
    'ISSUE_ACKNOWLEDGED',
    'ISSUE_UNACKNOWLEDGED',
    'TEMPLATE_APPLIED',
  ].includes(actionType);
}

/**
 * What the saved decisions were made against.
 *
 * Stored as the actual values rather than a hash of them. A hash would answer
 * "something changed" and nothing more, and requirement here is to say WHICH
 * saved work can no longer be restored — which needs the values back.
 *
 * None of this is new exposure: the headers are already saved inside the
 * mapping itself, and the ids are the ids the decisions point at.
 */
export interface ProgressScope {
  sourceId: string;
  importType: string;
  /**
   * The bytes. A source is immutable, so this pins the entry to the exact file
   * content the decisions were made against — a re-upload under a reused id, or
   * a hand-edited storage entry, cannot pass itself off as the same file.
   */
  sourceHash: string | null;
  /** The reading of the file these decisions were reviewed against. */
  analysisId: string | null;
  /** Which table in the file, and which row of it was the header. */
  sheet: string | null;
  headerRow: number | null;
  /** The column headers as they were when the decisions were made. */
  headers: string[];
  /** The shop this import was scoped to. */
  storeId: string | null;
  /** The locations and shops the decisions were allowed to name. */
  locationIds: string[];
  storeIds: string[];
}

/**
 * Why saved work cannot be restored, in the operator's words.
 *
 * Empty means it can. Every reason is phrased as something that happened to
 * their import rather than as a state name, because the person reading it did
 * not put the wizard into this state on purpose and has to decide what to do
 * next.
 */
export function incompatibilities(saved: ProgressScope, current: ProgressScope): string[] {
  const reasons: string[] = [];

  // Different file entirely. Belt and braces — the storage key is the source id
  // — but a tampered or hand-edited entry must not be trusted on its key alone.
  if (saved.sourceId !== current.sourceId) {
    reasons.push('Those decisions were made for a different file.');
    // Nothing below this is meaningful once the file differs.
    return reasons;
  }

  // Different bytes under the same id. Checked before anything derived from
  // the file, because every reason below it would be describing the wrong file.
  if (saved.sourceHash !== null && current.sourceHash !== null && saved.sourceHash !== current.sourceHash) {
    reasons.push('This file has changed since those decisions were made.');
    return reasons;
  }

  if (saved.importType !== current.importType) {
    reasons.push(`Those decisions were made for a ${label(saved.importType)} import, and this one is ${label(current.importType)}.`);
  }

  // A DIFFERENT company. Checked by whether the places the decisions could name
  // still exist for this caller: two companies share no location and no shop,
  // so sets that are both non-empty and completely disjoint are two different
  // companies looking at one browser.
  //
  // The server refuses a source belonging to another company outright, so this
  // is the second line rather than the first — but browser storage outlives a
  // sign-out, and a shared machine is ordinary in a shop.
  if (disjoint(saved.locationIds, current.locationIds) && disjoint(saved.storeIds, current.storeIds)) {
    reasons.push('Those decisions belong to a different company.');
    return reasons;
  }

  if ((saved.storeId ?? null) !== (current.storeId ?? null)) {
    reasons.push('Those decisions were made for a different shop.');
  }

  if ((saved.sheet ?? null) !== (current.sheet ?? null)) {
    reasons.push(`Those decisions were made against the sheet “${saved.sheet ?? 'unnamed'}”, and this import is reading “${current.sheet ?? 'unnamed'}”.`);
  }

  if ((saved.headerRow ?? null) !== (current.headerRow ?? null)) {
    reasons.push('The header row has changed since those decisions were made.');
  }

  // The file has been re-read and says something different. Column ORDER
  // matters as much as membership: the mapping is by index, so two files with
  // the same headers in a different order map to different columns.
  if (!sameOrder(saved.headers, current.headers)) {
    reasons.push('The columns in this file are not the ones those decisions were made against.');
  }

  // A place a decision names that is no longer offered. Checked by membership
  // rather than by comparing whole sets, so that merely ADDING a location — an
  // ordinary thing to do — does not throw away somebody's work.
  const missingLocations = saved.locationIds.filter((id) => !current.locationIds.includes(id));
  if (missingLocations.length > 0) {
    reasons.push('A stock location those decisions named is no longer available.');
  }
  const missingStores = saved.storeIds.filter((id) => !current.storeIds.includes(id));
  if (missingStores.length > 0) {
    reasons.push('A shop those decisions named is no longer available.');
  }

  // A different reading of the file. The decisions were reviewed against a
  // specific analysis, and this does NOT fire on an ordinary reopen: an
  // immutable source is analysed once and reopening returns that same analysis
  // rather than queueing another. When it does fire the file really was read
  // again — after a failure, say — and the review is owed afresh.
  if (saved.analysisId !== null && current.analysisId !== null && saved.analysisId !== current.analysisId) {
    reasons.push('This file has been read again since those decisions were made.');
  }

  return reasons;
}

/** The ids a set of saved decisions points at, so their survival can be checked. */
export function idsNamedBy(decisions: unknown): { locationIds: string[]; storeIds: string[] } {
  const locationIds: string[] = [];
  const storeIds: string[] = [];
  if (typeof decisions !== 'object' || decisions === null) return { locationIds, storeIds };

  const record = decisions as Record<string, unknown>;
  const inventory = record.inventory as { defaultLocationId?: unknown } | undefined;
  if (inventory && typeof inventory.defaultLocationId === 'string' && inventory.defaultLocationId) {
    locationIds.push(inventory.defaultLocationId);
  }

  const stores = record.stores as { storeIds?: unknown } | undefined;
  if (stores && Array.isArray(stores.storeIds)) {
    for (const id of stores.storeIds) if (typeof id === 'string' && id) storeIds.push(id);
  }

  return { locationIds, storeIds };
}

function disjoint(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return !a.some((id) => b.includes(id));
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function label(importType: string): string {
  return importType.toLowerCase().replace(/_/g, ' ');
}
