import { randomUUID } from 'crypto';
import { hashPlan, type PlanInputs } from '../src/modules/imports/plan/plan-hash';

/**
 * A plan hash for a test that needs a plan row, not a hash under test.
 *
 * Seven pg suites built one by calling `hashPlan({ sourceHash, mapping,
 * unique }) as never` — the same cast, and the same silent incompleteness, that
 * hid the production defect. They do not care what the hash covers; they need a
 * unique, deterministic-looking value to hang a row off.
 *
 * So they get a complete `PlanInputs` from here. Two things follow: the cast
 * disappears from every one of them, and `hashPlan`'s completeness check has no
 * exceptions to carve out — which is what makes it a check rather than a
 * preference.
 *
 * `unique` defaults to a fresh UUID because most callers want a DIFFERENT plan
 * each time; the unique index on (organization_id, plan_hash) turns an
 * accidental repeat into a confusing insert failure several lines later. Pass a
 * fixed value where the test is specifically about two plans being the same.
 */
export function testPlanHash(over: Partial<PlanInputs> & { unique?: string | null } = {}): string {
  const { unique = randomUUID(), ...inputs } = over;
  return hashPlan({
    organizationId: 'test-organization',
    storeId: null,
    importType: 'PRODUCTS',
    salesInventoryMode: null,
    sourceHash: 'a'.repeat(64),
    parserVersion: 'p9-1',
    analyzerVersion: 'p9-1',
    selection: { sheet: null, headerRow: 1, firstRowNumber: 2 },
    mapping: {},
    // Where the uniqueness lives, so a caller overriding `decisions` on purpose
    // still gets a distinct plan unless it also pins `unique`.
    decisions: { relationships: {}, acknowledged: unique === null ? [] : [unique] },
    targetAssumptions: {},
    mutations: null,
    ...inputs,
  });
}
