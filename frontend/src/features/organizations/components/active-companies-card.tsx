'use client';

import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '../../../lib/i18n';
import Badge from '../../../components/ui/badge';
import CompanyPlanModal, { PlanOption, PlanTarget, planLabel } from './company-plan-modal';
import { useActiveCompanies } from '../../../lib/domain-queries';

/**
 * #294 P3 — the ACTIVE companies, listed as COMPANIES, with "Remove company"
 * on the rows that can take it.
 *
 * The Clients overview table lists BRANCHES, so a company with no live branch
 * has no row there at all — and the accepted contract says a company is
 * removable without being archived first. This card is where an active
 * company is a row of its own.
 *
 * The button is offered to the unscoped platform owner only (`canRemove`,
 * derived from the resolved scope by the page) and only on a company whose
 * server-counted live branches are ZERO. Both are discovery aids, not the
 * decision: clicking loads the authoritative removal preview, and the removal
 * transaction re-evaluates every blocker at execution time. A branch that
 * appears between the listing and the confirmation is refused with
 * `LIVE_STORES`, and the modal shows the server's reasons instead of success.
 */
interface Props {
  accessToken: string;
  /** Whether the current actor may remove a company (unscoped platform owner only). */
  /** Bumped by the page when a company is restored or removed elsewhere, so the list refreshes. */
  reloadNonce?: number;
  /** Whether the current actor may change a company's plan (unscoped platform owner only, #318). */
  canManagePlan?: boolean;
  /** The plan catalogue from the owner overview, Plan Gratis included. */
  plans?: PlanOption[];
  onPlanChanged?: () => void;
}

export default function ActiveCompaniesCard({
  accessToken,
  reloadNonce = 0,
  canManagePlan = false,
  plans = [],
  onPlanChanged,
}: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const [planTarget, setPlanTarget] = useState<PlanTarget | null>(null);
  const companiesQuery = useActiveCompanies(accessToken, reloadNonce);
  const companies = companiesQuery.data ?? null;
  const refreshCompanies = () => queryClient.invalidateQueries({ queryKey: ['organizations', 'active'] });

  if (!companies || companies.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white" data-testid="active-companies">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{t('Companies')}</h3>
        <p className="text-xs text-slate-500">
          {t('Every active company. One with no live branch can be removed here — nothing is deleted, and only the platform owner can restore it from Recovery.')}
        </p>
      </div>
      <ul className="divide-y divide-slate-100">
        {companies.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" data-testid={`active-company-${c.id}`}>
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-800">{c.name}</p>
              <p className="text-xs text-slate-500">
                <span data-testid={`active-company-branches-${c.id}`}>
                  {c.liveStoreCount === 0
                    ? t('No live branch')
                    : c.liveStoreCount === 1
                      ? t('1 live branch')
                      : `${c.liveStoreCount} ${t('live branches')}`}
                </span>{' '}
                · <Badge variant="neutral">{c.billingStatus}</Badge> ·{' '}
                <span className="font-medium text-slate-700" data-testid={`active-company-plan-${c.id}`}>
                  {planLabel(plans, c.plan, t)}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-3">
            {canManagePlan && plans.length > 0 && (
              <button
                className="text-xs font-semibold text-primary hover:underline"
                onClick={() => setPlanTarget({ id: c.id, name: c.name, plan: c.plan })}
                data-testid={`change-plan-${c.id}`}
              >
                {t('Change plan')}
              </button>
            )}
            </div>
          </li>
        ))}
      </ul>
      {canManagePlan && (
        <CompanyPlanModal
          company={planTarget}
          plans={plans}
          accessToken={accessToken}
          onClose={() => setPlanTarget(null)}
          onSaved={() => {
            setPlanTarget(null);
            void refreshCompanies();
            onPlanChanged?.();
          }}
        />
      )}
    </section>
  );
}
