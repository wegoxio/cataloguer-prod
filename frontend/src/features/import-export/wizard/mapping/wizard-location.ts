import type { EditorRegion, ImportType } from './mapping-state';

/**
 * Where in the wizard a link points.
 *
 * Import work is interrupted constantly — someone opens the file to check a
 * price, a colleague is asked which column is the cost, the tab is closed at
 * five and reopened at nine. A link has to survive all of that, and it has to
 * fail gracefully when it cannot: a deep link into a source that has since
 * expired should land somewhere sensible with an explanation, never on an
 * error page or, worse, on an empty editor that looks like a fresh start.
 *
 * Only IDENTIFIERS travel in the URL. Never a mapping, never a sample, never a
 * cell value — a URL is copied into chat messages and ticket comments, and a
 * customer's prices must not ride along. It is also logged by every proxy
 * between here and the server.
 */

export interface WizardLocation {
  sourceId?: string;
  /**
   * A stored plan to REVIEW, rather than a file to map.
   *
   * Present only when the listing found an unexecuted DRAFT plan the caller may
   * see. It changes which screen opens; it grants nothing.
   */
  planId?: string;
  importType?: ImportType;
  region?: EditorRegion;
  /** Column the link was pointing at, for "look at this column" links. */
  column?: number;
  /** Row a finding referred to, for "this row is wrong" links. */
  row?: number;
}

const REGIONS: EditorRegion[] = ['SOURCE', 'MAPPING', 'ISSUES', 'RESULT'];
const IMPORT_TYPES: ImportType[] = ['PRODUCTS', 'CATEGORIES', 'HISTORICAL_STORE_SALES'];

/** Identifiers we mint are UUIDs; anything else in the slot is not one of ours. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeWizardLocation(location: WizardLocation): string {
  const params = new URLSearchParams();
  if (location.sourceId) params.set('source', location.sourceId);
  if (location.planId) params.set('plan', location.planId);
  if (location.importType) params.set('type', location.importType);
  if (location.region) params.set('at', location.region.toLowerCase());
  if (location.column !== undefined) params.set('col', String(location.column));
  if (location.row !== undefined) params.set('row', String(location.row));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Read a link, keeping whatever makes sense and discarding the rest.
 *
 * Every field is validated independently. A link with a good source id and a
 * nonsense region should open the source at the default region rather than be
 * rejected wholesale — the useful half of a mangled link is still useful, and
 * links get mangled routinely by chat clients that helpfully "fix" them.
 */
export function decodeWizardLocation(search: string | URLSearchParams): WizardLocation {
  const params = typeof search === 'string' ? new URLSearchParams(search.replace(/^\?/, '')) : search;
  const location: WizardLocation = {};

  const sourceId = params.get('source');
  if (sourceId && UUID.test(sourceId)) location.sourceId = sourceId;

  // A plan to REVIEW rather than a file to map.
  //
  // A navigation hint and nothing more: the server re-derives what this caller
  // may do with it, and answers 404 for a plan belonging to anyone else. A
  // parameter in a URL has never been an authorization.
  const planId = params.get('plan');
  if (planId && UUID.test(planId)) location.planId = planId;

  const importType = params.get('type');
  if (importType && (IMPORT_TYPES as string[]).includes(importType)) {
    location.importType = importType as ImportType;
  }

  const region = params.get('at');
  const upper = (region ?? '').toUpperCase();
  if ((REGIONS as string[]).includes(upper)) location.region = upper as EditorRegion;

  const column = toIndex(params.get('col'));
  if (column !== null) location.column = column;

  const row = toPositive(params.get('row'));
  if (row !== null) location.row = row;

  return location;
}

/** A column index: a non-negative integer, bounded so a link cannot ask for column 10^9. */
function toIndex(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 4096) return null;
  return value;
}

/** A spreadsheet row: 1-based, as the person sees it. */
function toPositive(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000_000) return null;
  return value;
}

/**
 * What to do when a link's source can no longer be opened.
 *
 * Stated as data rather than thrown, because every one of these is a normal
 * thing that happens to a link left in a ticket for three months — not an
 * error, and certainly not a stack trace.
 */
export type LinkOutcome =
  | { kind: 'OPEN'; sourceId: string }
  | { kind: 'START_OVER'; reason: string }
  | { kind: 'RESUME_ELSEWHERE'; reason: string };

export function resolveLink(
  location: WizardLocation,
  status: 'AVAILABLE' | 'EXPIRED' | 'MISSING' | 'FORBIDDEN' | 'NONE' | 'CANCELLED',
): LinkOutcome {
  if (!location.sourceId || status === 'NONE') {
    return { kind: 'START_OVER', reason: 'Choose a file to import.' };
  }
  switch (status) {
    case 'AVAILABLE':
      return { kind: 'OPEN', sourceId: location.sourceId };
    case 'EXPIRED':
      return {
        kind: 'START_OVER',
        reason: 'That file was uploaded more than 90 days ago and is no longer available. Upload it again to continue.',
      };
    case 'CANCELLED':
      // Said plainly, and NOT folded into MISSING. Somebody ended this import
      // on purpose; telling them it "is no longer available" reads as a fault
      // and invites them to wonder what went wrong.
      return {
        kind: 'START_OVER',
        reason: 'This import was cancelled. Nothing in your catalogue was changed. Upload the file again to start over.',
      };

    case 'MISSING':
      return { kind: 'START_OVER', reason: 'That import is no longer available. You can start a new one.' };
    case 'FORBIDDEN':
      // Deliberately the same sentence as MISSING. Distinguishing them tells
      // the reader that a file exists in a company they cannot see, which is
      // itself a disclosure — and the link was probably shared by mistake.
      return { kind: 'START_OVER', reason: 'That import is no longer available. You can start a new one.' };
    default:
      return { kind: 'START_OVER', reason: 'Choose a file to import.' };
  }
}
