'use client';

import React from 'react';
import { useT } from '../../../lib/i18n';
import type { BoundedLookup } from '../use-bounded-lookup';
import type { TenantRef } from '../services/platform-users.service';

/**
 * A PICKER OVER A LIST TOO BIG TO SHOW — companies, or one company's branches.
 *
 * Neither list is bounded by anything the product enforces: there is no cap on
 * client companies at all, and `PLANS.CORPORATIVO.maxWebsites` is null, so a
 * corporate client's branches are uncapped too. A plain `<select>` fed by "give
 * me everything" is therefore not a small shortcut — it is a control whose cost
 * and usability degrade with every client we sign.
 *
 * So: type to narrow, at most a page at a time, and SAY when there is more.
 * "Showing 20 of 137" is the difference between an operator narrowing their
 * search and an operator concluding a company was deleted.
 *
 * Native `<input>` and `<select>`, deliberately. They are reachable by Tab,
 * operable by the keyboard alone, announced by screen readers and searchable by
 * typing — none of which a hand-built listbox gets for free.
 */
export interface TenantPickerProps {
  id: string;
  label: string;
  /** The label for "no choice made" — "All companies", "Choose a branch". */
  anyLabel: string;
  searchLabel: string;
  lookup: BoundedLookup<TenantRef>;
  value: string;
  onChange: (value: string) => void;
  /**
   * A choice that must stay selectable even when it is not in the current
   * results — the person's EXISTING branch, which a search for something else
   * would otherwise silently drop out from under the operator.
   */
  pinned?: TenantRef | null;
  /** What to say when there is nothing to pick from yet. */
  disabledHint?: string;
}

export default function TenantPicker({
  id,
  label,
  anyLabel,
  searchLabel,
  lookup,
  value,
  onChange,
  pinned = null,
  disabledHint,
}: TenantPickerProps) {
  const t = useT();
  const { state, items, total, truncated, error, search, setSearch, retry } = lookup;

  const options = React.useMemo(() => {
    if (!pinned || items.some((item) => item.id === pinned.id)) return items;
    return [pinned, ...items];
  }, [items, pinned]);

  /**
   * A HELD VALUE THAT IS NO LONGER OFFERED IS DROPPED.
   *
   * Switching company clears the branch results; without this, the previous
   * company's branch id would still be sitting in the parent's filter state and
   * would still be sent to the server on the next read. The control would look
   * empty while filtering by a branch of a company nobody is looking at.
   */
  React.useEffect(() => {
    if (!value) return;
    if (options.some((option) => option.id === value)) return;
    onChange('');
  }, [value, options, onChange]);

  const busy = state === 'loading';
  const unusable = state === 'disabled' || state === 'failed';

  return (
    <div>
      <label className="text-[10px] font-semibold text-slate-500 uppercase" htmlFor={`${id}-search`}>
        {searchLabel}
      </label>
      <input
        id={`${id}-search`}
        data-testid={`${id}-search`}
        type="search"
        value={search}
        disabled={state === 'disabled'}
        placeholder={t('Type to narrow')}
        onChange={(event) => setSearch(event.target.value)}
        className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white disabled:bg-slate-50 disabled:text-slate-400"
      />
      <label className="text-[10px] font-semibold text-slate-500 uppercase mt-2 block" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        data-testid={id}
        value={value}
        disabled={unusable || busy}
        onChange={(event) => onChange(event.target.value)}
        className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white disabled:bg-slate-50 disabled:text-slate-400"
      >
        <option value="">{state === 'disabled' && disabledHint ? disabledHint : anyLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>

      {/*
        The four outcomes, each said out loud. `aria-live` because these lines
        replace one another in place: a keyboard user who never sees the region
        still hears that the list failed rather than being handed a silent,
        empty control.
      */}
      <p className="text-[11px] mt-1" data-testid={`${id}-state`} aria-live="polite">
        {busy && <span className="text-slate-500">{t('Loading…')}</span>}
        {state === 'ready' && truncated && (
          <span className="text-slate-500">
            {t('Showing')} {items.length} {t('of')} {total} — {t('type to narrow the list')}
          </span>
        )}
        {state === 'ready' && !truncated && items.length === 0 && (
          <span className="text-slate-500">{t('Nothing matches this search.')}</span>
        )}
        {state === 'failed' && (
          <span className="text-red-600">
            {error}{' '}
            <button
              type="button"
              data-testid={`${id}-retry`}
              onClick={retry}
              className="underline text-red-700 font-medium"
            >
              {t('Try again')}
            </button>
          </span>
        )}
      </p>
    </div>
  );
}
