'use client';

import React from 'react';
import Modal from '../../../components/ui/modal';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import { apiFetch } from '../../../lib/api-client';
import { canManageCatalogue, effectiveStoreId, type SessionScope } from '../../../lib/permissions';
import { familyService, isLockRetryExhaustion } from '../services/family.service';
import type { Product } from '../types/product.types';

/** The backend's limit on what the selector shows (`AddFamilyMemberDto.label`). */
export const LABEL_MAX_LENGTH = 80;
/** Below this the search is not sent: two characters is where results start to mean something. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

type SearchState =
  | { kind: 'short' }
  | { kind: 'loading' }
  | { kind: 'done'; groups: Product[] }
  | { kind: 'failed' };

export interface JoinGroupModalProps {
  open: boolean;
  onClose: () => void;
  /** The standalone item that will become a child of the picked group. */
  product: Product;
  accessToken: string | null;
  scope: SessionScope | null | undefined;
  /** Called once the item has joined a group, so the page can read it again. */
  onJoined?: () => void;
}

/**
 * A STANDALONE ITEM JOINS A GROUP THAT ALREADY EXISTS.
 *
 * The same call the group's own page makes to add a child, from the other
 * side: the group is the parent, this item the member
 * (`POST /products/:group/family/members`). The rules are the backend's — the
 * group must be live wherever the item is published, the item must be in a
 * branch, the label must be free — and its refusal is shown as it was said.
 *
 * WHAT IS SEARCHED. Only groups (`family=models`, "has children"): a
 * standalone item is never offered, because attaching to one would promote it
 * to a card and take it off sale. For an actor working inside one branch, only
 * groups in that branch (`storeId`), because the attachment loads both
 * products narrowed to it and would answer anything else "not found" (#344).
 *
 * A SEARCH ANSWER IS USED ONLY IF IT IS THE LATEST ONE. Responses can come back
 * out of order; a slow answer for "La" must not replace the answer for "Lamp",
 * and an answer that arrives after the query fell below two characters must not
 * bring a list back (#344).
 *
 * A REFUSAL BELONGS TO THE REQUEST THAT WAS REFUSED. Changing the label or the
 * group clears it, so the one refusal offered again — the lock-retry
 * exhaustion, "Store membership kept changing…" — is always offered for
 * exactly the request that met it (#344).
 */
export default function JoinGroupModal({ open, onClose, product, accessToken, scope, onJoined }: JoinGroupModalProps) {
  const t = useT();
  const toast = useToast();
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const labelRef = React.useRef<HTMLInputElement | null>(null);
  // Increments with every query; an answer is applied only if it carries the latest number.
  const latestSearch = React.useRef(0);

  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState<SearchState>({ kind: 'short' });
  const [picked, setPicked] = React.useState<Product | null>(null);
  const [label, setLabel] = React.useState('');
  const [refusal, setRefusal] = React.useState<{ message: string; retryable: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [focusLabel, setFocusLabel] = React.useState(false);

  const storeId = effectiveStoreId(scope);

  // Every closing forgets everything, so the next opening starts from nothing
  // and no answer still in flight can land in it.
  React.useEffect(() => {
    if (open) return;
    latestSearch.current += 1;
    setQuery('');
    setSearch({ kind: 'short' });
    setPicked(null);
    setLabel('');
    setRefusal(null);
    setBusy(false);
  }, [open]);

  React.useEffect(() => {
    if (!open || !accessToken) return;
    const ticket = ++latestSearch.current;
    const text = query.trim();
    if (text.length < MIN_QUERY_LENGTH) {
      setSearch({ kind: 'short' });
      return;
    }
    setSearch({ kind: 'loading' });
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: text, family: 'parent', limit: '10' });
      if (storeId) params.set('storeId', storeId);
      apiFetch(`/products?${params.toString()}`, { method: 'GET', token: accessToken })
        .then((response) => {
          if (ticket !== latestSearch.current) return;
          const groups: Product[] = (response?.items ?? response?.data?.items ?? []).filter(
            (group: Product) => group.id !== product.id,
          );
          setSearch({ kind: 'done', groups });
        })
        .catch(() => {
          if (ticket !== latestSearch.current) return;
          setSearch({ kind: 'failed' });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, accessToken, query, storeId, product.id]);

  // After a group is picked the search list is gone: focus goes to the label,
  // not to the top of the dialog.
  React.useEffect(() => {
    if (focusLabel && picked) {
      labelRef.current?.focus();
      setFocusLabel(false);
    }
  }, [focusLabel, picked]);

  const childCount = (group: Product) => {
    const n = group.children?.length ?? 0;
    return n === 1 ? t('1 child') : t('{count} children', { count: n });
  };

  const pick = (group: Product) => {
    setPicked(group);
    setRefusal(null);
    setFocusLabel(true);
  };

  const changeGroup = () => {
    setPicked(null);
    setRefusal(null);
    // The search list comes back with whatever the query still holds.
    setTimeout(() => searchRef.current?.focus(), 0);
  };

  const trimmed = label.trim();
  // A permanent refusal stands until the person changes or re-picks something:
  // sent again untouched it would be refused again, unless the catalogue has
  // changed meanwhile (the refusal may say how — "Publish the parent there
  // first"). Editing the label, changing the group or picking the same group
  // again clears it (above) and makes the request sendable: a deliberate step,
  // not an accidental resend. The lock-retry exhaustion is not permanent —
  // "Try again" sends it, and so may this.
  const refusedForGood = !!refusal && !refusal.retryable;
  const canSubmit =
    !!picked && trimmed.length > 0 && trimmed.length <= LABEL_MAX_LENGTH && !busy && !refusedForGood;

  const submit = async () => {
    if (!canSubmit || !picked) return;
    if (!accessToken || !canManageCatalogue(scope)) {
      toast.error(t('You do not have permission to do this.'));
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await familyService.addMember(accessToken, picked.id, product.id, trimmed);
      toast.success(t('Added to the group'));
      onJoined?.();
      onClose();
    } catch (err) {
      setRefusal({
        message: (err as { message?: string })?.message || t('Could not add this product to the group'),
        retryable: isLockRetryExhaustion(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const status = (() => {
    switch (search.kind) {
      case 'short':
        return t('Type at least two characters to search for a group.');
      case 'loading':
        return t('Searching…');
      case 'failed':
        return t('Groups could not be searched. Check your connection and try again.');
      case 'done':
        return search.groups.length === 0
          ? t('No group matches “{query}”.', { query: query.trim() })
          : search.groups.length === 1
            ? t('1 group found.')
            : t('{count} groups found.', { count: search.groups.length });
    }
  })();

  return (
    <Modal
      open={open}
      title={t('Add to an existing group')}
      // Closing mid-request would leave the answer with nowhere to go.
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocusRef={searchRef}
      className="max-w-lg"
      footer={
        <>
          <Button type="button" size="sm" variant="ghost" data-testid="family-join-cancel" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            type="submit"
            form="family-join-form"
            isLoading={busy}
            disabled={!canSubmit}
            data-testid="family-join-submit"
          >
            {t('Add to group')}
          </Button>
        </>
      }
    >
      <form
        id="family-join-form"
        data-testid="family-join-modal"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-xs text-slate-500">
          {t(
            '“{name}” becomes a child of the group: the website shows the group’s card with this product in its selector. The group must be published wherever this product is.',
            { name: product.name },
          )}
        </p>

        {picked ? (
          <div className="space-y-3">
            <div
              className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              data-testid="family-join-picked"
            >
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase text-slate-500">{t('Group')}</p>
                <p className="text-sm font-semibold text-slate-800 break-words" data-testid="family-join-picked-name">
                  {picked.name}
                </p>
                <p className="text-xs text-slate-500">{childCount(picked)}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="family-join-change"
                disabled={busy}
                onClick={changeGroup}
              >
                {t('Change group')}
              </Button>
            </div>
            <div>
              <Input
                ref={labelRef}
                id="family-join-label"
                label={t('Shows as')}
                placeholder={t('e.g. Green')}
                value={label}
                maxLength={LABEL_MAX_LENGTH}
                disabled={busy}
                aria-describedby="family-join-label-help"
                onChange={(event) => {
                  setLabel(event.target.value.slice(0, LABEL_MAX_LENGTH));
                  setRefusal(null);
                }}
              />
              <p id="family-join-label-help" className="mt-1 flex justify-between gap-2 text-[11px] text-slate-500">
                <span>{t('What the website selector shows for this product.')}</span>
                <span data-testid="family-join-label-count">
                  {label.length}/{LABEL_MAX_LENGTH}
                </span>
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Input
              ref={searchRef}
              id="family-join-search"
              type="search"
              label={t('Search groups')}
              placeholder={t('Search groups by name or SKU...')}
              value={query}
              autoComplete="off"
              aria-describedby="family-join-status"
              onChange={(event) => setQuery(event.target.value)}
            />
            <p id="family-join-status" role="status" aria-live="polite" className="text-[11px] text-slate-500">
              {status}
            </p>
            {search.kind === 'done' && search.groups.length > 0 && (
              <ul
                aria-label={t('Groups')}
                className="border border-slate-100 rounded-md divide-y divide-slate-100 max-h-60 overflow-y-auto"
              >
                {search.groups.map((group) => (
                  <li key={group.id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      data-testid={`family-join-candidate-${group.id}`}
                      onClick={() => pick(group)}
                    >
                      <span className="block text-sm text-slate-800 break-words">{group.name}</span>
                      <span className="block text-xs text-slate-500">{childCount(group)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {refusal && (
          <div
            role="alert"
            data-testid="family-join-refusal"
            className="text-xs text-danger bg-red-50 border border-red-100 rounded-md px-3 py-2 flex items-start justify-between gap-2 flex-wrap"
          >
            <span className="min-w-0 break-words">{refusal.message}</span>
            {refusal.retryable && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="family-join-refusal-retry"
                onClick={() => void submit()}
              >
                {t('Try again')}
              </Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
