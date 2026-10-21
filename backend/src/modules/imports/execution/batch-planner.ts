import { hashBatch } from '../plan/plan-hash';
import { MAX_BATCH_ROWS } from '../shared/import-limits';

/**
 * Cutting an approved plan into batches that can be committed independently.
 *
 * Whole-file atomicity is not on offer and must never be implied. Bounded
 * execution commits durable batches by design, so a run can end
 * PARTIALLY_COMPLETED — and that is a first-class outcome with a report and
 * repair guidance, not a failure to disguise as success.
 *
 * What IS atomic is the unit inside a batch: one row and everything that row
 * implies — its categories, field values and store pivots — commit together or
 * not at all, matching the per-row transaction the existing importer already
 * uses. A family and its children are a second atomic unit, because a parent
 * without its children is a card that sells nothing.
 */

export type AtomicUnitKind = 'ROW' | 'FAMILY';

export interface PlannedUnit {
  kind: AtomicUnitKind;
  /** Source rows this unit consumes. A family covers several. */
  sourceRows: number[];
  /** Opaque mutation description; the executor interprets it per import type. */
  mutations: unknown;
  /**
   * Which applier reads these mutations.
   *
   * Optional, and absent for every single-applier run — the executor is handed
   * one applier and uses it. It exists because a run can legitimately need
   * more than one: a product import that also proposes stock writes catalogue
   * rows through one applier and ledger entries through another, and the unit
   * has to say which is which rather than the executor guessing from the
   * mutation's shape.
   */
  applier?: string;
}

export interface PlannedBatch {
  index: number;
  firstRow: number;
  lastRow: number;
  units: PlannedUnit[];
  fingerprint: string;
}

/**
 * Rows per batch.
 *
 * 200 is chosen against two measured ceilings rather than picked: a batch must
 * finish well inside the 60-second lease so a heartbeat between batches is
 * enough to hold it, and its mutation payload must sit inside the stated body
 * limit. It is also comfortably above the legacy importer's effective ~76-row
 * ceiling, which existed only because nothing had ever measured it.
 */
export const DEFAULT_BATCH_ROWS = MAX_BATCH_ROWS;

/**
 * Group units into batches without ever splitting an atomic unit.
 *
 * A family spanning a batch boundary would be committed half in one batch and
 * half in another, so a resumed run could leave a parent with some of its
 * children. Units are therefore packed whole, and a batch may exceed the target
 * size slightly rather than break one.
 */
export function planBatches(planHash: string, units: PlannedUnit[], batchRows = DEFAULT_BATCH_ROWS): PlannedBatch[] {
  const batches: PlannedBatch[] = [];
  let current: PlannedUnit[] = [];
  let currentRows = 0;

  const flush = () => {
    if (current.length === 0) return;
    const rows = current.flatMap((u) => u.sourceRows);
    const index = batches.length;
    batches.push({
      index,
      firstRow: Math.min(...rows),
      lastRow: Math.max(...rows),
      units: current,
      fingerprint: hashBatch(
        planHash,
        index,
        current.map((u) => u.mutations),
      ),
    });
    current = [];
    currentRows = 0;
  };

  for (const unit of units) {
    // Pack whole units. Starting a new batch when this one would overflow keeps
    // families intact at the cost of slightly uneven batch sizes.
    if (currentRows > 0 && currentRows + unit.sourceRows.length > batchRows) flush();
    current.push(unit);
    currentRows += unit.sourceRows.length;
  }
  flush();

  return batches;
}

/**
 * Which batches still need running.
 *
 * Resume is driven by the checkpoints that exist, never by a counter: a worker
 * that died after committing batch 7 but before updating a progress column
 * would otherwise redo it. The fingerprint is compared as well as the index,
 * because "batch 7" only means something relative to a plan, and a plan that
 * changed would make the committed work and the pending work incomparable.
 */
export interface CommittedCheckpoint {
  batchIndex: number;
  batchFingerprint: string;
}

export interface ResumeDecision {
  pending: PlannedBatch[];
  alreadyCommitted: number[];
  /** Set when a committed batch does not match the current plan. */
  conflict?: { batchIndex: number; expected: string; found: string };
}

export function decideResume(batches: PlannedBatch[], committed: CommittedCheckpoint[]): ResumeDecision {
  const byIndex = new Map(committed.map((c) => [c.batchIndex, c.batchFingerprint]));
  const pending: PlannedBatch[] = [];
  const alreadyCommitted: number[] = [];

  for (const batch of batches) {
    const found = byIndex.get(batch.index);
    if (found === undefined) {
      pending.push(batch);
      continue;
    }
    if (found !== batch.fingerprint) {
      // The plan changed under a partly-executed run. Continuing would apply
      // work the committed half never anticipated, so the run stops for a human.
      return {
        pending: [],
        alreadyCommitted,
        conflict: { batchIndex: batch.index, expected: batch.fingerprint, found },
      };
    }
    alreadyCommitted.push(batch.index);
  }

  return { pending, alreadyCommitted };
}
