'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/auth';
import { isUnscopedPlatformOwner } from '../../../lib/permissions';
import { useT } from '../../../lib/i18n';
import { useToast } from '../../../components/ui/toast';
import { useDebouncedValue } from '../../../lib/use-debounced-value';
import Badge from '../../../components/ui/badge';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import Pagination from '../../../components/ui/pagination';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import ChangeAccessModal from '../../../features/users/components/change-access-modal';
import TenantPicker from '../../../features/users/components/tenant-picker';
import { ASSIGNABLE_ROLES, describeAccess, roleLabel } from '../../../features/users/platform-access';
import { useBoundedLookup } from '../../../features/users/use-bounded-lookup';
import {
  platformUsersService,
  type PlatformUserFilters,
  type PlatformUserRow,
} from '../../../features/users/services/platform-users.service';
import { usePlatformUsers } from '../../../lib/domain-queries';
import { queryKeys } from '../../../lib/query-client';

/**
 * PLATFORM USERS — every person on the platform, for the one actor with no
 * company of their own (#275).
 *
 * `GET /users` is the TENANT listing and refuses without an organization; that
 * boundary is correct and unchanged. This screen reads a separate, separately
 * authorised endpoint, and it is the first surface an unscoped platform owner
 * has ever had for users at all.
 *
 * ONE PAGE AT A TIME, ALWAYS. The filters and the page number go to the server
 * and only the returned rows are held: this component never accumulates, never
 * concatenates and never filters client-side, so "how many users exist" is
 * never a thing the browser has to hold in order to show twenty-five of them.
 */
const ROLE_BADGE: Record<string, 'purple' | 'info' | 'success' | 'neutral' | 'warning'> = {
  SUPER_ADMIN: 'purple',
  ORGANIZATION_MANAGER: 'warning',
  ADMIN: 'info',
  STORE_ADMIN: 'info',
  EDITOR: 'success',
  VIEWER: 'neutral',
};

/** Roles a row may CARRY. Wider than what may be assigned, and deliberately so. */
const FILTERABLE_ROLES = ['SUPER_ADMIN', ...ASSIGNABLE_ROLES, 'STORE_ADMIN'] as const;

const EMPTY_FILTERS: PlatformUserFilters = {
  search: '',
  organizationId: '',
  storeId: '',
  role: '',
  status: 'active',
  invitation: 'all',
};

export default function PlatformUsersPage() {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user, scope, accessToken } = useAuth();

  const isOwner = isUnscopedPlatformOwner(scope);

  const [filters, setFilters] = useState<PlatformUserFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const [target, setTarget] = useState<PlatformUserRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const debouncedSearch = useDebouncedValue(filters.search ?? '');
  const queryKey = JSON.stringify({ ...filters, search: debouncedSearch });
  const query = useMemo<PlatformUserFilters>(() => JSON.parse(queryKey), [queryKey]);

  const usersQuery = usePlatformUsers(accessToken, page, query, isOwner);
  const result = usersQuery.data ?? null;
  const loading = usersQuery.isPending;
  const error = usersQuery.error instanceof Error
    ? usersQuery.error.message
    : usersQuery.isError ? t('Could not load the platform users') : null;
  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: queryKeys.platformUsersRoot });

  /**
   * THE COMPANY PICKER — bounded and searchable, never "every organization".
   *
   * A failed lookup here leaves the picker in its `failed` state with a retry,
   * NOT in an empty one. An empty company list on a platform-owner screen reads
   * as "there are no client companies", which is the single most misleading
   * thing this page could say, and it used to be what a caught error produced.
   */
  const organizationLookup = useBoundedLookup({
    fetcher: accessToken && isOwner ? (search) => platformUsersService.organizationLookup(accessToken, search) : null,
    subject: 'organizations',
  });

  /**
   * The branch picker is a function of the company picker: branches only mean
   * something inside one company. `subject` is the chosen company, so switching
   * companies clears the previous company's branches in the same render — they
   * are never displayed, never selectable and never submitted.
   */
  const storeLookup = useBoundedLookup({
    fetcher:
      accessToken && filters.organizationId
        ? (search) => platformUsersService.storeLookup(accessToken, filters.organizationId!, search)
        : null,
    subject: filters.organizationId || '',
  });

  /** The modal's branch list — the TARGET's company, bounded the same way. */
  const targetStoreLookup = useBoundedLookup({
    fetcher:
      accessToken && target?.organization
        ? (search) => platformUsersService.storeLookup(accessToken, target.organization!.id, search)
        : null,
    subject: target?.organization?.id || '',
  });

  useEffect(() => {
    if (user && scope && !isOwner) router.replace('/dashboard');
  }, [user, scope, isOwner, router]);

  /**
   * WHERE THE KEYBOARD GOES AFTER A CHANGE COMMITS.
   *
   * `Modal` hands focus back to whatever opened it, which is the right default
   * — but not here. A committed access change re-reads the list, so the row's
   * button is destroyed and rebuilt, and focusing a detached node silently
   * drops focus to `document.body`: a keyboard user lands at the top of the
   * document with no announcement of what happened. The row may not even be on
   * this page any more, since the change can move it out of the current filter.
   *
   * So focus goes to the OUTCOME, which is both a real destination and the
   * sentence that says what the server committed. Found by the keyboard
   * journey, which is the only test that can see focus at all.
   */
  const outcomeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (outcome) outcomeRef.current?.focus();
  }, [outcome]);

  if (!user || !isOwner) return null;

  const update = (partial: Partial<PlatformUserFilters>) => {
    // Any filter change returns to page one: keeping page 7 while narrowing to
    // three results shows an empty screen that looks like "no users".
    setPage(1);
    setFilters((prev) => ({ ...prev, ...partial }));
  };

  // Opening the modal sets the target; the branch list follows from it through
  // `targetStoreLookup`, which owns its own loading, failure and retry states.
  const openChangeAccess = (row: PlatformUserRow) => {
    setAccessError(null);
    setOutcome(null);
    setTarget(row);
  };

  /**
   * NOTHING IS CLAIMED BEFORE THE SERVER COMMITS.
   *
   * The modal stays open and the row unchanged until the endpoint answers. On
   * success the committed row IS the response, and the list is re-read from the
   * server rather than patched in place — a locally edited row would show what
   * this browser believes rather than what the database holds.
   */
  const submitAccess = async (body: { role: string; storeId: string | null }) => {
    if (!accessToken || !target?.organization) return;
    setSaving(true);
    setAccessError(null);
    try {
      const committed = await platformUsersService.changeAccess(
        accessToken,
        target.organization.id,
        target.id,
        body as never,
      );
      setTarget(null);
      setOutcome(
        `${committed.email} — ${describeAccess(
          committed.role,
          committed.organization?.name ?? null,
          committed.store?.name ?? null,
          t,
        )}`,
      );
      toast.success(t('Access changed. Their sessions were ended.'));
      await refreshUsers();
    } catch (err: any) {
      // Shown as the server gave it: invariant, conflict, stale target and
      // authorization refusals each say something different and actionable,
      // and the modal must not flatten them into one invented sentence.
      setAccessError(err?.message || t('The access change was refused'));
    } finally {
      setSaving(false);
    }
  };

  const rows = result?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t('Platform Users')}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {t('Every person on the platform, across all client companies. Only you can see this page.')}
        </p>
      </div>

      {outcome && (
        <div
          ref={outcomeRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className="card p-3 border-emerald-200 bg-emerald-50/40 flex items-start justify-between gap-3 outline-none focus:ring-2 focus:ring-emerald-400"
          data-testid="access-outcome"
        >
          <p className="text-xs text-slate-700">
            {t('Saved:')} {outcome}
          </p>
          <button
            type="button"
            className="text-xs text-slate-400 hover:text-slate-600"
            onClick={() => setOutcome(null)}
            aria-label={t('Dismiss')}
          >
            ✕
          </button>
        </div>
      )}

      <div className="card p-4 grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="platform-user-filters">
        <Input
          name="platformUserSearch"
          label={t('Search')}
          placeholder={t('Email, name or company')}
          value={filters.search ?? ''}
          onChange={(e) => update({ search: e.target.value })}
        />
        <TenantPicker
          id="filter-organization"
          label={t('Company')}
          searchLabel={t('Find a company')}
          anyLabel={t('All companies')}
          lookup={organizationLookup}
          value={filters.organizationId ?? ''}
          onChange={(value) => update({ organizationId: value, storeId: '' })}
        />
        <TenantPicker
          id="filter-store"
          label={t('Branch')}
          searchLabel={t('Find a branch')}
          anyLabel={t('All branches')}
          disabledHint={t('Choose a company first')}
          lookup={storeLookup}
          value={filters.storeId ?? ''}
          onChange={(value) => update({ storeId: value })}
        />
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase" htmlFor="filter-role">
            {t('Role')}
          </label>
          <select
            id="filter-role"
            name="role"
            data-testid="filter-role"
            value={filters.role ?? ''}
            onChange={(e) => update({ role: e.target.value })}
            className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
          >
            <option value="">{t('All roles')}</option>
            {FILTERABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(roleLabel(role))}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase" htmlFor="filter-status">
            {t('Account status')}
          </label>
          <select
            id="filter-status"
            name="status"
            data-testid="filter-status"
            value={filters.status ?? 'active'}
            onChange={(e) => update({ status: e.target.value as PlatformUserFilters['status'] })}
            className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
          >
            <option value="active">{t('Active')}</option>
            <option value="deactivated">{t('Deactivated')}</option>
            <option value="all">{t('Active and deactivated')}</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase" htmlFor="filter-invitation">
            {t('Invitation')}
          </label>
          <select
            id="filter-invitation"
            name="invitation"
            data-testid="filter-invitation"
            value={filters.invitation ?? 'all'}
            onChange={(e) => update({ invitation: e.target.value as PlatformUserFilters['invitation'] })}
            className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
          >
            {/*
              "No pending invitation" — never "accepted", never "signed in".
              A password can be set by a reset or by an administrator, so the
              only thing the row proves is that no invitation is outstanding.
            */}
            <option value="all">{t('Any invitation state')}</option>
            <option value="pending">{t('Invitation pending')}</option>
            <option value="none">{t('No pending invitation')}</option>
          </select>
        </div>
      </div>

      {loading && (
        <p className="text-xs text-slate-500" data-testid="platform-users-loading">
          {t('Loading…')}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-600" data-testid="platform-users-error">
          {error}
        </p>
      )}

      {!loading && !error && rows.length === 0 && (
        <EmptyState message={t('No users match these filters.')} hint={t('Widen the filters to see more people.')} />
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-500" data-testid="platform-users-count">
            {/* The TOTAL comes from the server; the browser holds one page. */}
            {t('Showing')} {rows.length} {t('of')} {result?.total ?? 0} {t('people')}
          </p>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TH>{t('Person')}</TH>
                <TH>{t('Company')}</TH>
                <TH>{t('Branch')}</TH>
                <TH>{t('Role')}</TH>
                <TH>{t('Status')}</TH>
                <TH>{t('Invitation')}</TH>
                <TH> </TH>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      {/* The row hook lives on a cell: `TR` forwards nothing but
                          `className`, so a `data-testid` on it would go nowhere
                          — the same trap `Badge` documents. */}
                      <span className="font-medium text-ink-strong" data-testid={`platform-user-${row.id}`}>
                        {row.email}
                      </span>
                      {(row.firstName || row.lastName) && (
                        <span className="block text-[11px] text-slate-500">
                          {[row.firstName, row.lastName].filter(Boolean).join(' ')}
                        </span>
                      )}
                    </TD>
                    <TD>{row.organization?.name ?? <span className="text-slate-400">{t('None')}</span>}</TD>
                    <TD>
                      {/* An organization-wide role has NO branch, and saying so
                          plainly is the point — an empty cell reads as missing
                          data rather than as company-wide authority. */}
                      {row.store?.name ?? (
                        <span className="text-slate-500 text-[11px]">
                          {row.organization ? t('Company-wide') : t('None')}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <Badge variant={ROLE_BADGE[row.role] ?? 'neutral'}>{t(roleLabel(row.role))}</Badge>
                    </TD>
                    <TD>
                      {row.deactivatedAt ? (
                        <Badge variant="danger">{t('Deactivated')}</Badge>
                      ) : (
                        <Badge variant="success">{t('Active')}</Badge>
                      )}
                    </TD>
                    <TD>
                      {/* The column reports the INVITATION, not the person's
                          behaviour: `pendingInvite` is "no password is set",
                          and its absence is not evidence of a sign-in. */}
                      {row.pendingInvite ? (
                        <Badge variant="warning">{t('Invitation pending')}</Badge>
                      ) : (
                        <span className="text-[11px] text-slate-500">{t('No pending invitation')}</span>
                      )}
                    </TD>
                    <TD>
                      {/* Offered only where the contract can act: the access
                          endpoint's subject is an organization, so a user
                          without one has nothing for it to change. */}
                      {row.organization && (
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid={`change-access-${row.id}`}
                          onClick={() => openChangeAccess(row)}
                        >
                          {t('Change access')}
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <Pagination page={result?.page ?? 1} totalPages={result?.totalPages ?? 1} onPageChange={setPage} />
        </div>
      )}

      {target && (
        <ChangeAccessModal
          user={target}
          storeLookup={targetStoreLookup}
          busy={saving}
          error={accessError}
          onCancel={() => {
            setTarget(null);
            setAccessError(null);
          }}
          onSubmit={submitAccess}
        />
      )}
    </div>
  );
}

