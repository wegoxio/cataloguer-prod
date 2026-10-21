'use client';

import React from 'react';
import { useT } from '../../../lib/i18n';

/**
 * WHAT A STORE-DEPENDENT SCREEN SAYS WHEN THERE ARE NO BRANCHES (#293).
 *
 * A company may now hold zero active branches — it can archive its last one, or
 * remove it — and the owner's decision is explicit that this must be a TRUTHFUL
 * blocked state rather than a silent one. Two ways of being silent were already
 * in the interface and both are wrong here:
 *
 *   · hiding the control, which reads as "this feature does not exist" and
 *     leaves the operator with nothing to act on; and
 *   · leaving the control enabled, which produces a server refusal phrased in
 *     terms of a rule the operator was never shown.
 *
 * So this says the state and names EVERY route out of it, in the order an
 * operator would try them. All three are real: a branch can be created, an
 * archived one reactivated by the company itself, and a removed one restored —
 * but only by the platform owner, which is why that one is worded as a request
 * rather than as a button they are expected to find.
 */
export default function NoActiveStores({ what }: { what: string }) {
  const t = useT();
  return (
    <div
      data-testid="no-active-stores"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      <p className="font-semibold">{t('This company has no active branch.')}</p>
      <p className="mt-1">
        {what} {t('needs one. Create a branch, reactivate an archived one, or ask the platform owner to restore a removed one.')}
      </p>
    </div>
  );
}
