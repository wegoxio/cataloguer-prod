'use client';

import React from 'react';
import Modal from '../../../components/ui/modal';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import { useT } from '../../../lib/i18n';
import { effectiveAccessPreview, roleNeedsStore } from '../effective-access';
import {
  ASSIGNABLE_ROLES,
  type AccessShape,
  type AssignableRole,
  accessBody,
  accessSelectionProblem,
  describeAccess,
  isEscalation,
  roleLabel,
  rolesForShape,
  shapeOfRole,
} from '../platform-access';
import TenantPicker from './tenant-picker';
import type { PlatformUserRow } from '../services/platform-users.service';
import type { BoundedLookup } from '../use-bounded-lookup';
import type { TenantRef } from '../services/platform-users.service';

/**
 * ONE STATEMENT OF ACCESS: role and branch, chosen together (#275).
 *
 * The modal's shape follows the contract rather than describing it. The BINDING
 * is chosen first — company-wide or one branch — and the role list is derived
 * from that choice, so an illegal pair is not merely refused on submit: it
 * cannot be held. `ORGANIZATION_MANAGER` is unreachable while "one branch" is
 * selected, and a branch role is unreachable while "company-wide" is.
 *
 * NOTHING IS CLAIMED BEFORE THE SERVER COMMITS. The modal closes on the
 * endpoint's response and the caller re-reads the row; there is no optimistic
 * update, because an access change that appears to have happened and did not is
 * worse than one that visibly failed.
 */
const CONFIRM_WORD = 'PROMOTE';

export interface ChangeAccessModalProps {
  user: PlatformUserRow;
  /**
   * The branches of the TARGET's company — never every branch on the platform,
   * and never an unbounded read of that company either: `CORPORATIVO` caps
   * nothing, so the list arrives a bounded page at a time with a search.
   *
   * A lookup rather than an array so the modal can tell "this company has no
   * branches" apart from "we could not find out". The second must not become a
   * branch selector that silently offers nothing.
   */
  storeLookup: BoundedLookup<TenantRef>;
  busy?: boolean;
  /** The server's refusal, shown as given. The modal never invents a reason. */
  error?: string | null;
  onCancel: () => void;
  onSubmit: (body: { role: AssignableRole; storeId: string | null }) => void;
}

export default function ChangeAccessModal({
  user,
  storeLookup,
  busy = false,
  error = null,
  onCancel,
  onSubmit,
}: ChangeAccessModalProps) {
  const t = useT();
  const currentShape = shapeOfRole(user.role);
  const [shape, setShape] = React.useState<AccessShape>(currentShape);
  const [role, setRole] = React.useState<AssignableRole | null>(
    (ASSIGNABLE_ROLES as readonly string[]).includes(user.role) ? (user.role as AssignableRole) : null,
  );
  const [storeId, setStoreId] = React.useState<string | null>(user.store?.id ?? null);
  const [typed, setTyped] = React.useState('');

  const available = rolesForShape(shape);

  /**
   * The person's CURRENT branch stays selectable no matter what the search
   * returns. Without pinning it, typing another branch's name would quietly
   * drop the selection the operator arrived with and leave the form invalid
   * for a reason nothing on screen explains.
   */
  const pinnedStore = user.store ? { id: user.store.id, name: user.store.name } : null;

  /**
   * Changing the binding re-derives the role, because the previous one may not
   * exist in the new list. Falling back to the first legal role keeps the form
   * in a valid state at every moment rather than in an "impossible" one the
   * operator has to repair.
   */
  const chooseShape = (next: AccessShape) => {
    setShape(next);
    setRole((current) => (current && rolesForShape(next).includes(current) ? current : rolesForShape(next)[0]));
    if (next === 'ORGANIZATION') setStoreId(null);
  };

  /**
   * A BRANCH CHANGE CANNOT BE SUBMITTED WHILE THE BRANCH LIST IS UNKNOWN.
   *
   * If the lookup failed, the operator has not been shown the real set of
   * branches. Letting them submit anyway would mean confirming a binding chosen
   * from a list we could not read — and the pinned current branch would be the
   * only option offered, making "no change" look like the only possible answer.
   */
  const branchListUnusable = shape === 'BRANCH' && (storeLookup.state === 'failed' || storeLookup.state === 'loading');

  const problem = accessSelectionProblem(role, storeId);
  const escalating = role ? isEscalation(user.role, role) : false;
  const confirmed = !escalating || typed.trim().toUpperCase() === CONFIRM_WORD;
  const unchanged = role === user.role && (roleNeedsStore(user.role) ? storeId === (user.store?.id ?? null) : true);

  const preview = role ? effectiveAccessPreview(role, roleNeedsStore(role) ? storeId : null) : [];
  const before = effectiveAccessPreview(user.role, user.store?.id ?? null);

  return (
    <Modal open title={t('Change access')} onClose={onCancel}>
      <div className="space-y-4">
        <div className="p-3 rounded-md bg-slate-50 border border-slate-100 space-y-1">
          <p className="text-sm font-semibold text-ink-strong">{user.email}</p>
          {/* Access as a SENTENCE, not a code — the operator reads people, not enums. */}
          <p className="text-xs text-slate-600" data-testid="current-access">
            {t('Today:')} {describeAccess(user.role, user.organization?.name ?? null, user.store?.name ?? null, t)}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-semibold text-slate-500 uppercase mb-1">{t('Access shape')}</p>
          <div className="flex gap-2">
            {(['ORGANIZATION', 'BRANCH'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-testid={`shape-${option}`}
                aria-pressed={shape === option}
                onClick={() => chooseShape(option)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium border ${
                  shape === option ? 'border-primary text-primary bg-primary/5' : 'border-slate-200 text-slate-600'
                }`}
              >
                {option === 'ORGANIZATION' ? t('Organization-wide') : t('One branch')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase" htmlFor="access-role">
            {t('Role')}
          </label>
          {/*
            The list IS the derivation. There is no STORE_ADMIN option and no
            SUPER_ADMIN option anywhere in this component — not disabled,
            absent — because neither is assignable through this contract.
          */}
          <select
            id="access-role"
            name="role"
            data-testid="access-role"
            value={role ?? ''}
            onChange={(e) => setRole(e.target.value as AssignableRole)}
            className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:border-primary"
          >
            {available.map((option) => (
              <option key={option} value={option}>
                {t(roleLabel(option))}
              </option>
            ))}
          </select>
        </div>

        {shape === 'BRANCH' && (
          <TenantPicker
            id="access-store"
            label={t('Branch')}
            searchLabel={t('Find a branch')}
            anyLabel={t('Choose a branch')}
            lookup={storeLookup}
            pinned={pinnedStore}
            value={storeId ?? ''}
            onChange={(value) => setStoreId(value || null)}
          />
        )}

        {/*
          The preview is computed by the SAME predicates the screens gate on,
          fed the scope the backend would resolve — so a wrong line here means a
          wrong screen there, not merely a wrong description.
        */}
        {role && (
          <div className="p-3 rounded-md border border-slate-100" data-testid="access-preview">
            <p className="text-[10px] font-semibold text-slate-500 uppercase mb-1">{t('After this change they can')}</p>
            <ul className="space-y-0.5">
              {preview.map((line, index) => {
                const had = before[index]?.allowed ?? false;
                const changed = had !== line.allowed;
                return (
                  <li
                    key={line.label}
                    data-testid={`preview-${line.label}`}
                    data-changed={changed ? 'yes' : 'no'}
                    className={`text-[11px] ${line.allowed ? 'text-slate-700' : 'text-slate-400 line-through'}`}
                  >
                    {line.allowed ? '✓' : '✕'} {t(line.label)}
                    {changed && <span className="ml-1 text-primary">{line.allowed ? t('(gained)') : t('(lost)')}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2" data-testid="session-warning">
          {t('All of this person’s sessions will be ended. They must sign in again.')}
        </p>

        {escalating && (
          <div data-testid="escalation-gate">
            <p className="text-[11px] text-slate-600 mb-1">
              {t('This grants authority over the whole company. Type PROMOTE to confirm.')}
            </p>
            <Input name="confirmEscalation" label={t('Confirm')} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}

        {problem && (
          <p className="text-[11px] text-slate-500" data-testid="selection-problem">
            {t(problem)}
          </p>
        )}
        {error && (
          <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-md p-2" data-testid="access-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <Button variant="secondary" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button
            isLoading={busy}
            disabled={!!problem || !confirmed || unchanged || busy || branchListUnusable}
            data-testid="submit-access"
            onClick={() => role && onSubmit(accessBody(role, storeId))}
          >
            {t('Change access')}
          </Button>
        </div>
        {unchanged && !problem && (
          <p className="text-[11px] text-slate-400" data-testid="unchanged-note">
            {t('This is the access they already have.')}
          </p>
        )}
      </div>
    </Modal>
  );
}
