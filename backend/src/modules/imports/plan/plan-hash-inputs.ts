import { IMPORT_PIPELINE_VERSION } from '../shared/import-limits';
import type { PlanDecisions, PlanInputs } from './plan-hash';
import type { TableMapping } from '../preview/normalized-preview';

/**
 * The hash inputs a plan is built from, as one named function.
 *
 * These were written inline inside `createPlan`, where they were wrong for
 * months and no test could reach them. `plan-hash.spec.ts` exercised `hashPlan`
 * with a complete, correctly-typed `PlanInputs` and proved every field moved
 * the hash — which was true, and irrelevant, because the only caller passed a
 * differently-shaped object behind `as never`. The function was covered; the
 * CALL was not.
 *
 * So the call is a function now, and it is tested directly. A hash is only as
 * trustworthy as the thing that decides what goes into it.
 */
export function planHashInputs(input: {
  organizationId: string;
  storeId: string | null;
  importType: string;
  sourceHash: string;
  mapping: TableMapping;
  sample: { firstRowNumber: number };
  decisions: PlanDecisions;
  targetAssumptions: Record<string, unknown>;
}): PlanInputs {
  return {
    organizationId: input.organizationId,
    storeId: input.storeId,
    importType: input.importType,
    // Derived from the type rather than passed in, so the stored column and the
    // hash cannot be given different answers.
    salesInventoryMode: input.importType === 'HISTORICAL_STORE_SALES' ? 'HISTORICAL_RECORD_ONLY' : null,
    sourceHash: input.sourceHash,
    parserVersion: IMPORT_PIPELINE_VERSION,
    analyzerVersion: IMPORT_PIPELINE_VERSION,
    /*
      Which part of the file was read.

      The sheet and the header row decide what every column INDEX means, so the
      same bytes with the same mapping read from a different header row are a
      different plan. It was not in the hash at all.
    */
    selection: {
      sheet: input.mapping.sheet ?? null,
      headerRow: input.mapping.headerRow,
      firstRowNumber: input.sample.firstRowNumber,
    },
    mapping: input.mapping as unknown as Record<string, unknown>,
    decisions: input.decisions,
    targetAssumptions: input.targetAssumptions,
    /*
      No mutation set exists yet.

      The runner compiles it at execution time from the bytes, the mapping and
      the decisions — all three covered above — so there is nothing here to
      attest to. Null is a stated answer. The old call site's silence was not,
      and canonicalisation made the two indistinguishable.
    */
    mutations: null,
  };
}
