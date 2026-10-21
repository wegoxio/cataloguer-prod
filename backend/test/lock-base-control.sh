#!/usr/bin/env bash
#
# Run lock tests with one half of the system replaced by another revision's code.
#
#   test/lock-base-control.sh <ref> <http|runner|all> <jest arguments…>
#
# Writes <ref>'s copy of each file this change touches beside the original as
# `*.base.ts`, points the copies at each other, runs jest with LOCK_BASE set, and
# removes every copy it wrote — on success, on failure and on interruption.
#
# Run from `backend/`. Needs ALLOW_PG_DISPOSABLE_TESTS=1 and a loopback
# TEST_DATABASE_URL, exactly as the pg suite does.
set -euo pipefail

REF="${1:?a git revision to take the base from}"
HALF="${2:?http, runner or all}"
shift 2

case "$HALF" in http | runner | all) ;; *) echo "second argument must be http, runner or all" >&2; exit 64 ;; esac
[ -f package.json ] && [ -d src/modules ] || { echo "run this from backend/" >&2; exit 64; }
git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || { echo "no such revision: $REF" >&2; exit 64; }

FILES=(
  src/modules/products/publication-guard.service.ts
  src/modules/products/products.service.ts
  src/modules/products/product-family.service.ts
  src/modules/bulk-operations/bulk-operations.service.ts
  src/modules/imports/execution/import-executor.ts
  src/modules/imports/runner/product-inventory.applier.ts
  src/modules/imports/appliers/products.applier.ts
)

WRITTEN=()
SCRATCH="$(mktemp -d)"
cleanup() {
  for copy in "${WRITTEN[@]:-}"; do
    # Only ever a file this script wrote, and only ever one named *.base.ts.
    case "$copy" in src/modules/*.base.ts) rm -f -- "$copy" ;; esac
  done
  rm -rf -- "$SCRATCH"
}
trap cleanup EXIT INT TERM

# Every copy is prepared OUTSIDE the tree and only then moved into it, so a
# revision that lacks one of the files leaves nothing behind — and nothing in
# the tree is edited in place, so nothing of anybody else's can be overwritten.
for file in "${FILES[@]}"; do
  copy="${file%.ts}.base.ts"
  if [ -e "$copy" ]; then echo "refusing to overwrite $copy" >&2; exit 1; fi
  prepared="$SCRATCH/$(basename "$copy")"
  git show "$REF:backend/$file" >"$prepared"
  # The copies import each other, never the code under test.
  for other in "${FILES[@]}"; do
    name="$(basename "${other%.ts}")"
    sed -E "s#(from '[./a-z-]*/${name})'#\\1.base'#" "$prepared" >"$prepared.next"
    mv -- "$prepared.next" "$prepared"
  done
  WRITTEN+=("$copy")
  mv -- "$prepared" "$copy"
done

LOCK_BASE="$HALF" npx jest --runInBand "$@"
