/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * WHICH CODE A LOCK TEST DRIVES.
 *
 * The API and the import runner are one image deployed to two places, and the
 * two are not replaced at the same instant. For as long as they differ, an
 * editor's request runs the old writers while a batch runs the new ones, or
 * the other way round — and the lock tests have to be able to stand in exactly
 * that state, in one process, with both versions loaded.
 *
 * `LOCK_BASE` says which half is the OLD one:
 *
 *   (unset)  both halves are the code in this tree
 *   http     the writers behind the API are the base; the runner is this tree
 *   runner   the runner is the base; the writers are this tree
 *   all      both are the base
 *
 * The base is a copy of another revision's files, written beside the originals
 * as `*.base.ts` by `test/lock-base-control.sh` and removed when it exits. It
 * is never committed, and nothing loads it unless `LOCK_BASE` asks.
 */
export type LockBase = 'none' | 'http' | 'runner' | 'all';

export const LOCK_BASE = (process.env.LOCK_BASE ?? 'none') as LockBase;

const load = (path: string, base: boolean): any => require(base ? `${path}.base` : path);

/** The writers an editor's request reaches, and the guard they are given. */
export const httpSide = () => {
  const base = LOCK_BASE === 'http' || LOCK_BASE === 'all';
  return {
    base,
    PublicationGuardService: load('../src/modules/products/publication-guard.service', base).PublicationGuardService,
    ProductsService: load('../src/modules/products/products.service', base).ProductsService,
    ProductFamilyService: load('../src/modules/products/product-family.service', base).ProductFamilyService,
    BulkOperationsService: load('../src/modules/bulk-operations/bulk-operations.service', base).BulkOperationsService,
  };
};

/** What a batch runs: the executor, the two appliers, and the guard THEY are given. */
export const runnerSide = () => {
  const base = LOCK_BASE === 'runner' || LOCK_BASE === 'all';
  return {
    base,
    PublicationGuardService: load('../src/modules/products/publication-guard.service', base).PublicationGuardService,
    ProductsApplier: load('../src/modules/imports/appliers/products.applier', base).ProductsApplier,
    ProductInventoryApplier: load('../src/modules/imports/runner/product-inventory.applier', base)
      .ProductInventoryApplier,
    executePlan: load('../src/modules/imports/execution/import-executor', base).executePlan,
  };
};
