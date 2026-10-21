'use client';

import React from 'react';
import Link from 'next/link';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Input from '../../../components/ui/input';
import ConfirmModal from '../../../components/ui/confirm-modal';
import { Table, THead, TH, TBody, TR, TD } from '../../../components/ui/table';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import { apiFetch } from '../../../lib/api-client';
import { canManageCatalogue, effectiveStoreId, type SessionScope } from '../../../lib/permissions';
import { familyService, isLockRetryExhaustion } from '../services/family.service';
import { labelOf, type Product } from '../types/product.types';
import JoinGroupModal from './join-group-modal';

export interface FamilyMemberRow {
  id: string;
  name: string;
  optionLabel?: string | null;
  price?: number;
  stockQuantity?: number;
  trackInventory?: boolean;
}

export interface FamilyView {
  parentId: string;
  parentName: string;
  members: FamilyMemberRow[];
}

/**
 * The family a product belongs to, if any (P5-W4, capability 3).
 *
 * Three cases and no guessing: the product IS the parent (its children arrive
 * with it), the product is a child (its parent has to be fetched to list its
 * siblings), or it stands alone and there is no family at all.
 */
export function familyRoleOf(product: Product): 'PARENT' | 'CHILD' | 'STANDALONE' {
  if (product.children && product.children.length > 0) return 'PARENT';
  const parentId = typeof product.parent === 'string' ? product.parent : product.parent?.id;
  return parentId ? 'CHILD' : 'STANDALONE';
}

const money = (value?: number | null) =>
  value === undefined || value === null ? '-' : `$${Number(value).toFixed(2)}`;

/**
 * The section heading takes focus after a join, so focus on it must be seen.
 * `focus`, not `focus-visible`: the heading is out of the tab order and is only
 * ever focused by the page, and a browser does not count script focus after a
 * pointer submit as `focus-visible` — the ring would show for a keyboard join
 * and not for a mouse one.
 */
const HEADING_FOCUS = 'rounded-sm focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2';

export interface ProductFamilyPanelProps {
  product: Product;
  family: FamilyView | null;
  accessToken: string | null;
  scope: SessionScope | null | undefined;
  onChanged?: () => void;
  /**
   * Focus belongs on this section's heading (after a join). Held by the PAGE,
   * because the page shows "Loading…" while it reads the item again and this
   * panel is unmounted: state kept in here would not survive the reload.
   */
  focusHeading?: boolean;
  onFocusHeadingChange?: (wanted: boolean) => void;
}

/**
 * Parent and child administration (P5-W4, capability 3).
 *
 * TERMINOLOGY IS THE CONTRACT (ADR 018, superseding ADR 015's role names):
 * parent product, child product, standalone product. `family` survives only as
 * the internal collective term. "Variant", "model" and "version" are not
 * user-facing words here, and the retired `ProductVariant` entity is never
 * consulted — a child is an ordinary product with a parent, which is exactly
 * why it keeps its own SKU, price, stock and photos.
 *
 * CREATING A VERSION is two deliberate steps, not one hidden one: a real
 * product is created, then joined to the family with the label the selector
 * will show. Both are ordinary authorised calls, so nothing here can mint a
 * product a person could not have created directly.
 */
export default function ProductFamilyPanel({
  product,
  family,
  accessToken,
  scope,
  onChanged,
  focusHeading = false,
  onFocusHeadingChange,
}: ProductFamilyPanelProps) {
  const t = useT();
  const toast = useToast();
  const canManage = canManageCatalogue(scope);

  const [editingLabel, setEditingLabel] = React.useState<{ memberId: string; value: string } | null>(null);
  /**
   * WHERE FOCUS GOES AFTER A JOIN. The dialog hands focus back to the button
   * that opened it, but that button exists only while the item is standalone:
   * once the page reads the item again it is a child, the section is rebuilt,
   * and the button is gone — focus would fall to the top of the document. So
   * focus goes to this section's heading, and follows it to the new heading
   * once the family has loaded. The wish is the page's to keep
   * (`focusHeading`); kept here as well for a panel nobody controls.
   */
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const [focusHeadingHere, setFocusHeadingHere] = React.useState(false);
  const wantsHeadingFocus = focusHeading || focusHeadingHere;
  // Read through a ref: a caller passing an inline callback must not re-run
  // the focus effect on every render.
  const onFocusHeadingChangeRef = React.useRef(onFocusHeadingChange);
  onFocusHeadingChangeRef.current = onFocusHeadingChange;
  const setHeadingWish = (wanted: boolean) => {
    setFocusHeadingHere(wanted);
    onFocusHeadingChangeRef.current?.(wanted);
  };
  const [creating, setCreating] = React.useState(false);
  const [newChild, setNewChild] = React.useState({ name: '', label: '', sku: '' });
  const [addSearch, setAddSearch] = React.useState('');
  const [addResults, setAddResults] = React.useState<Product[]>([]);
  const [addPick, setAddPick] = React.useState<Product | null>(null);
  const [addLabel, setAddLabel] = React.useState('');
  /**
   * The backend's refusal of the last attach, shown beside the form rather
   * than in a toast that slides away: "hidden in Centro", "is draft", "belongs
   * to no store", "kept changing — try again" are all things a person has to
   * read and act on, and the form they came from stays as it was.
   */
  const [addRefusal, setAddRefusal] = React.useState<{ message: string; retryable: boolean } | null>(null);
  // A STANDALONE joining an existing group happens in its own dialog.
  const [joining, setJoining] = React.useState(false);
  // Increments with every "Add child" search; an answer is applied only if it
  // carries the latest number (#344: a slow answer must not replace a newer one).
  const latestAddSearch = React.useRef(0);
  const [busy, setBusy] = React.useState(false);
  const [confirmAction, setConfirmAction] = React.useState<
    { type: 'remove'; memberId: string; memberName: string } | { type: 'dissolve' } | null
  >(null);

  const storeId = effectiveStoreId(scope);

  React.useEffect(() => {
    if (!wantsHeadingFocus) return;
    headingRef.current?.focus();
    // Kept until the family has loaded, so the rebuilt heading takes it too.
    if (family) {
      setFocusHeadingHere(false);
      onFocusHeadingChangeRef.current?.(false);
    }
  }, [wantsHeadingFocus, family]);

  React.useEffect(() => {
    const ticket = ++latestAddSearch.current;
    if (!accessToken || !family || !canManage || addSearch.trim().length < 2) {
      setAddResults([]);
      return;
    }
    const timer = setTimeout(() => {
      // Ask the SERVER for standalone candidates only. `family=standalone`
      // already means "no parent and no children", which is exactly what may
      // become a child — so an already-grouped item and an existing parent
      // never reach the picker.
      //
      // The deeper rules are NOT restated here: a store-less item, a
      // specification conflict, tenancy, and anything that changes between
      // this search and the attach are the backend’s to refuse — and it does.
      //
      // An actor working inside one branch is offered only that branch's
      // items: the attachment loads the member narrowed to it, and would
      // answer anything else "not found" (#344).
      const params = new URLSearchParams({ search: addSearch.trim(), family: 'standalone', limit: '10' });
      if (storeId) params.set('storeId', storeId);
      apiFetch(`/products?${params.toString()}`, {
        method: 'GET',
        token: accessToken,
      })
        .then((response) => {
          if (ticket !== latestAddSearch.current) return;
          const inFamily = new Set([family.parentId, ...family.members.map((member) => member.id)]);
          setAddResults((response?.items ?? response?.data?.items ?? []).filter((p: Product) => !inFamily.has(p.id)));
        })
        .catch(() => {
          if (ticket === latestAddSearch.current) setAddResults([]);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [accessToken, addSearch, family, canManage, storeId]);

  /**
   * What the endpoint said, in the shape the form shows. Only the lock-retry
   * exhaustion — "the branches kept changing while this was being applied",
   * nothing written — is offered again; see `isLockRetryExhaustion` for how
   * it is told apart from the other 409s. Everything else is a rule, shown as
   * it was said, and asking again changes nothing until the person changes
   * something.
   */
  const refusalOf = (err: unknown, fallback: string) => ({
    message: (err as { message?: string })?.message || fallback,
    retryable: isLockRetryExhaustion(err),
  });

  const guard = (): boolean => {
    if (!canManage || !accessToken) {
      toast.error(t('You do not have permission to do this.'));
      return false;
    }
    return true;
  };

  const reset = () => {
    setEditingLabel(null);
    setAddPick(null);
    setAddSearch('');
    setAddLabel('');
    setAddRefusal(null);
    setNewChild({ name: '', label: '', sku: '' });
    setCreating(false);
  };

  const saveLabel = async () => {
    if (!guard() || !family || !editingLabel) return;
    setBusy(true);
    try {
      await familyService.renameMember(accessToken as string, family.parentId, editingLabel.memberId, editingLabel.value);
      toast.success(t('Label updated'));
      reset();
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not update the label'));
    } finally {
      setBusy(false);
    }
  };

  const addExisting = async () => {
    if (!guard() || !family || !addPick || !addLabel.trim()) return;
    setBusy(true);
    setAddRefusal(null);
    try {
      await familyService.addMember(accessToken as string, family.parentId, addPick.id, addLabel.trim());
      toast.success(t('Child product added'));
      reset();
      onChanged?.();
    } catch (err: any) {
      setAddRefusal(refusalOf(err, t('Could not add the child product')));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Creates a NEW product and joins it to this family in one operator action.
   *
   * Deliberately two API calls rather than a special endpoint: the child is
   * an ordinary product, born as a DRAFT in no branch, and the family join is
   * the same authorised call an existing product would take. If the join
   * fails, the product still exists as a standalone draft and the message says
   * so — a half-finished action that lies about what happened is worse than
   * one that reports the truth.
   */
  const createChild = async () => {
    if (!guard() || !family) return;
    if (!newChild.name.trim() || !newChild.label.trim()) {
      toast.error(t('A child product needs a name and the label the website selector will show'));
      return;
    }
    setBusy(true);
    let createdId: string | null = null;
    try {
      const created = await apiFetch('/products', {
        method: 'POST',
        token: accessToken as string,
        body: JSON.stringify({
          name: newChild.name.trim(),
          sku: newChild.sku.trim() || null,
          status: 'DRAFT',
          price: 0,
          storeIds: [],
        }),
      });
      createdId = created?.data?.id ?? created?.id ?? null;
      if (!createdId) throw new Error(t('The item was not created'));
      await familyService.addMember(accessToken as string, family.parentId, createdId, newChild.label.trim());
      toast.success(t('Child product created and attached'));
      reset();
      onChanged?.();
    } catch (err: any) {
      toast.error(
        createdId
          ? t('The product was created but could not be attached to the parent. It is a standalone draft; add it from the search below.')
          : err?.message || t('Could not create the child product'),
      );
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const runConfirmedAction = async () => {
    if (!guard() || !family || !confirmAction) return;
    setBusy(true);
    try {
      if (confirmAction.type === 'remove') {
        await familyService.removeMember(accessToken as string, family.parentId, confirmAction.memberId);
        toast.success(t('Child released as a standalone product'));
      } else {
        await familyService.dissolve(accessToken as string, family.parentId);
        toast.success(t('Released — every child is a standalone product again'));
      }
      setConfirmAction(null);
      reset();
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not complete the action'));
      setConfirmAction(null);
    } finally {
      setBusy(false);
    }
  };

  /** The backend's refusal, where the form is; only the lock-retry exhaustion offers the request again. */
  const refusalNotice = (
    refusal: { message: string; retryable: boolean } | null,
    testId: string,
    retry: () => void,
  ) =>
    refusal && (
      <div
        role="alert"
        data-testid={testId}
        className="text-xs text-danger bg-red-50 border border-red-100 rounded-md px-3 py-2 flex items-start justify-between gap-2 flex-wrap"
      >
        <span>{refusal.message}</span>
        {refusal.retryable && (
          <Button size="sm" variant="secondary" isLoading={busy} data-testid={`${testId}-retry`} onClick={retry}>
            {t('Try again')}
          </Button>
        )}
      </div>
    );

  if (!family) {
    return (
      <div className="card p-6" data-testid="family-panel">
        <h3
          ref={headingRef}
          tabIndex={-1}
          data-testid="family-heading"
          className={`text-sm font-bold text-slate-800 mb-1 ${HEADING_FOCUS}`}
        >
          {t('Parent and children')}
        </h3>
        {/* TRUTHFUL: the copy states the fact, and the one action that exists
            follows it. Grouping SEVERAL standalones under a new card lives in
            the Items list; here a standalone joins a group that already
            exists. */}
        <p className="text-xs text-slate-500" data-testid="standalone-explainer">
          {t('This is a standalone product: it has no parent and no children.')}
        </p>
        {canManage && (
          <div
            className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap"
            data-testid="family-join"
          >
            <p className="text-xs text-slate-500 min-w-0 flex-1">
              {t('It can join a group that already exists, as one of the options on the group’s card.')}
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="family-join-open"
              aria-haspopup="dialog"
              onClick={() => {
                // A wish left over from an earlier join whose reload never
                // brought a family is moot now: the dialog takes the focus.
                if (wantsHeadingFocus) setHeadingWish(false);
                setJoining(true);
              }}
            >
              {t('Add to an existing group')}
            </Button>
          </div>
        )}
        {canManage && (
          <JoinGroupModal
            open={joining}
            onClose={() => setJoining(false)}
            product={product}
            accessToken={accessToken}
            scope={scope}
            onJoined={() => {
              setHeadingWish(true);
              onChanged?.();
            }}
          />
        )}
      </div>
    );
  }

  const isModel = family.parentId === product.id;

  return (
    <div className="card p-6" data-testid="family-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h3
          ref={headingRef}
          tabIndex={-1}
          data-testid="family-heading"
          className={`text-sm font-bold text-slate-800 ${HEADING_FOCUS}`}
        >
          {t('Parent and children')}:{' '}
          {isModel ? (
            family.parentName
          ) : (
            <Link href={`/dashboard/products/${family.parentId}`} className="text-primary hover:underline">
              {family.parentName}
            </Link>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {isModel && <Badge variant="info">{t('This is the card')}</Badge>}
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              data-testid="family-dissolve"
              tooltip={t('Every child becomes a standalone product again; the parent stays as a normal product')}
              onClick={() => setConfirmAction({ type: 'dissolve' })}
            >
              {t('Release all children')}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        {t(
          'The website shows one card — the parent — with a selector of its children. Each child keeps its own price, stock and photos.',
        )}
      </p>

      <Table>
        {/* `THead` renders the header row itself: it takes cells, not a row.
            A `TR` here made `<tr>` a child of `<tr>`, invalid markup that React
            reports as a hydration error. */}
        <THead>
          <TH>{t('Item')}</TH>
          <TH>{t('Shows as')}</TH>
          <TH>{t('Price')}</TH>
          <TH>{t('Stock')}</TH>
          {canManage && <TH align="center">{t('Actions')}</TH>}
        </THead>
        <TBody>
          {family.members.map((member) => (
            <TR key={member.id}>
              <TD>
                {member.id === product.id ? (
                  <span className="font-semibold text-slate-800">{member.name}</span>
                ) : (
                  <Link href={`/dashboard/products/${member.id}`} className="text-primary hover:underline">
                    {member.name}
                  </Link>
                )}
              </TD>
              <TD className="text-xs text-slate-600">
                {editingLabel?.memberId === member.id ? (
                  <span className="inline-flex items-center gap-1">
                    <input
                      className="border border-slate-200 rounded px-1.5 py-0.5 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-primary"
                      aria-label={t('Shows as')}
                      value={editingLabel.value}
                      autoFocus
                      onChange={(e) => setEditingLabel({ memberId: member.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveLabel();
                        if (e.key === 'Escape') setEditingLabel(null);
                      }}
                    />
                    <Button size="sm" data-testid={`family-label-save-${member.id}`} onClick={saveLabel}>
                      {t('Save')}
                    </Button>
                  </span>
                ) : (
                  labelOf(member) || <span className="text-slate-400 italic">{t('No label')}</span>
                )}
              </TD>
              <TD>{money(member.price)}</TD>
              <TD>{member.trackInventory ? (member.stockQuantity ?? 0) : t('Untracked')}</TD>
              {canManage && (
                <TD align="center" className="whitespace-nowrap space-x-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`family-label-${member.id}`}
                    tooltip={t('Change what the website selector shows for this child')}
                    onClick={() => setEditingLabel({ memberId: member.id, value: labelOf(member) ?? '' })}
                  >
                    {t('Edit label')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    data-testid={`family-remove-${member.id}`}
                    tooltip={t('Detach this child — it becomes a standalone product')}
                    onClick={() => setConfirmAction({ type: 'remove', memberId: member.id, memberName: member.name })}
                  >
                    {t('Remove')}
                  </Button>
                </TD>
              )}
            </TR>
          ))}
        </TBody>
      </Table>

      {canManage && (
        <div className="mt-4 pt-3 border-t border-slate-100 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs font-semibold text-slate-700">{t('Add a child product')}</p>
            <Button size="sm" variant="secondary" data-testid="family-create-toggle" onClick={() => setCreating((open) => !open)}>
              {creating ? t('Cancel') : t('Create a new child product')}
            </Button>
          </div>

          {creating && (
            <div className="p-3 rounded-md border border-slate-100 bg-slate-50 space-y-2" data-testid="family-create-form">
              <Input
                label={t('Name')}
                aria-label={t('Name')}
                placeholder={t('e.g. Nordic chair - green')}
                value={newChild.name}
                onChange={(e) => setNewChild({ ...newChild, name: e.target.value })}
              />
              <Input
                label={t('Shows as')}
                aria-label={t('Shows as')}
                placeholder={t('e.g. Green')}
                value={newChild.label}
                onChange={(e) => setNewChild({ ...newChild, label: e.target.value })}
              />
              <Input
                label={t('SKU (optional)')}
                aria-label={t('SKU (optional)')}
                value={newChild.sku}
                onChange={(e) => setNewChild({ ...newChild, sku: e.target.value })}
              />
              <p className="text-[11px] text-slate-400">
                {t('Created as a draft, in no branch and with no stock. Publishing it is a separate, deliberate act.')}
              </p>
              <Button size="sm" isLoading={busy} data-testid="family-create-submit" onClick={createChild}>
                {t('Create child')}
              </Button>
            </div>
          )}

          {addPick ? (
            <div className="flex items-end gap-2 flex-wrap">
              <span className="text-sm text-slate-700 pb-2">{addPick.name}</span>
              <Input
                label={t('Shows as')}
                aria-label={t('Shows as')}
                placeholder={t('e.g. Green')}
                value={addLabel}
                maxLength={80}
                onChange={(e) => {
                  setAddLabel(e.target.value.slice(0, 80));
                  // A refusal belongs to the request that met it (#344).
                  setAddRefusal(null);
                }}
              />
              <Button size="sm" isLoading={busy} data-testid="family-add-submit" onClick={addExisting} disabled={!addLabel.trim()}>
                {t('Add child')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAddPick(null);
                  setAddRefusal(null);
                }}
              >
                {t('Cancel')}
              </Button>
              <div className="basis-full">{refusalNotice(addRefusal, 'family-add-refusal', addExisting)}</div>
            </div>
          ) : (
            <>
              <Input
                placeholder={t('Search items by name or SKU...')}
                aria-label={t('Search items by name or SKU...')}
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
              />
              {addResults.length > 0 && (
                <ul className="border border-slate-100 rounded-md divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {addResults.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50"
                        data-testid={`family-candidate-${candidate.id}`}
                        onClick={() => setAddPick(candidate)}
                      >
                        {candidate.name}
                        <span className="text-xs text-slate-400 ml-2">{money(candidate.price)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmAction !== null}
        title={confirmAction?.type === 'dissolve' ? t('Release every child product?') : t('Remove this child product?')}
        message={
          confirmAction?.type === 'dissolve'
            ? t(
                'Every child becomes a standalone product again and the website shows them as separate cards. Nothing is deleted.',
              )
            : t('"{name}" is detached and becomes a standalone product. Nothing is deleted.', {
                name: confirmAction?.type === 'remove' ? confirmAction.memberName : '',
              })
        }
        danger
        confirmLabel={confirmAction?.type === 'dissolve' ? t('Release all children') : t('Remove')}
        onConfirm={runConfirmedAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
