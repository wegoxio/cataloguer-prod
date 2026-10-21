'use client';

import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, ExternalLink, Plus } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { isUnscopedPlatformOwner } from '../../../lib/permissions';
import { apiFetch } from '../../../lib/api-client';
import { useT } from '../../../lib/i18n';
import { useToast } from '../../../components/ui/toast';
import { enterManagedTenant } from '../../../lib/managed-tenant';
import Badge from '../../../components/ui/badge';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import Modal from '../../../components/ui/modal';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import ActiveCompaniesCard from '../../../features/organizations/components/active-companies-card';
import { useOwnerOverview } from '../../../lib/domain-queries';
import { queryKeys } from '../../../lib/query-client';

interface ClientRow {
  id: string;
  /** The client that owns this store (P0-11). */
  organizationId: string | null;
  name: string;
  websiteUrl: string | null;
  plan: { key: string; name: string; priceUsd: number | null; complimentary?: boolean };
  billingStatus: string;
  archivedAt: string | null;
  createdAt: string;
  usersCount: number;
  productsCount: number;
  ordersThisMonth: number;
  revenueThisMonth: number;
  totalPaid: number;
  lastPaymentAt: string | null;
}

// The orange "spark": a company onboarded in the last 7 days is worth noticing
const isRecent = (dateStr: string) => Date.now() - new Date(dateStr).getTime() < 7 * 24 * 60 * 60 * 1000;

interface Overview {
  totals: {
    activeClients: number;
    monthlyRecurringUsd: number;
    /** Companies counted in the recurring total, each exactly once (#318). */
    recurringCompanies?: number;
    ordersThisMonth: number;
    revenueThisMonth: number;
  };
  clients: ClientRow[];
  plans: { key: string; name: string; priceUsd: number | null; complimentary?: boolean }[];
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="text-2xl font-bold text-ink-strong tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function billingBadge(status: string, t: (key: string) => string) {
  if (status === 'PENDING_FIRST_PAYMENT') return <Badge variant="warning">{t('Awaiting first payment')}</Badge>;
  if (status === 'PAUSED') return <Badge variant="danger">{t('Paused')}</Badge>;
  return <Badge variant="success">{t('Active')}</Badge>;
}

type DeliveryStatus = 'DELIVERED' | 'FAILED' | 'UNKNOWN';

/**
 * The server's delivery status, defaulted to UNKNOWN rather than to a claim.
 *
 * Anything unrecognised — an older build, a truncated body — means we do not
 * know what happened to the email, which is exactly what UNKNOWN says. Reading
 * an absent field as "failed" is how the boolean this replaces put failure copy
 * in front of invitations that were fine.
 */
const deliveryStatusOf = (value: unknown): DeliveryStatus =>
  value === 'DELIVERED' || value === 'FAILED' ? value : 'UNKNOWN';

/**
 * Platform-owner control panel: every client company with its plan,
 * modules, activity and payments — actions inline, no per-client hunting
 * through the Websites section.
 */
export default function ClientsPage() {
  const reloadNonce = 0;
  const { user, scope, accessToken } = useAuth();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  // New Client: creates the company AND invites its admin in one step
  const [isNewOpen, setIsNewOpen] = useState(false);
  const [newClient, setNewClient] = useState({ name: '', websiteUrl: '', adminEmail: '' });
  const [creating, setCreating] = useState(false);
  const [resending, setResending] = useState(false);
  /**
   * The result of the last onboarding, kept so the operator is told plainly
   * what happened — especially when the invitation email did not go out, which
   * is a delivery outcome and NOT a rollback (D5).
   *
   * `deliveryStatus` is three-valued because the truth is. A boolean forced
   * "no attempt was made on this request" into the same shape as "the attempt
   * failed", so an exact retry — which deliberately sends nothing — rendered
   * failure copy over an invitation that was perfectly fine, and went on doing
   * it after the manager had already accepted.
   */
  const [onboarded, setOnboarded] = useState<{
    organizationId: string;
    organizationName: string;
    managerId: string;
    managerEmail: string;
    pending: boolean;
    deliveryStatus: DeliveryStatus;
    idempotent: boolean;
  } | null>(null);

  // Derived from the resolved scope, never from an absent store binding.
  const isOwner = isUnscopedPlatformOwner(scope);
  const overviewQuery = useOwnerOverview(accessToken, isOwner);
  const overview = (overviewQuery.data ?? null) as Overview | null;
  const refreshOverview = () => queryClient.invalidateQueries({ queryKey: queryKeys.ownerOverview });

  useEffect(() => {
    // Only redirect once the scope has actually resolved: while it is null the
    // answer is "not known yet", not "not the owner".
    if (user && scope && !isOwner) router.replace('/dashboard');
  }, [user, scope, isOwner, router]);

  if (!user || !isOwner) return null;

  /**
   * ONE REQUEST, because a client is one thing.
   *
   * This used to be three: create the organization, create the store inside it,
   * then post a user with `role: 'ADMIN'` and that store's id. Any prefix could
   * commit on its own — a closed tab or a failed second call left a company
   * nobody could reach — and the third call was wrong even when it succeeded,
   * because a company's first user must be its ORGANIZATION_MANAGER. Every
   * client onboarded through this screen ended up with a branch administrator
   * and no manager.
   *
   * The role is deliberately absent from the body. There is one correct answer
   * and the server gives it; the screen cannot ask for a different one.
   */
  const createClient = async () => {
    if (!accessToken || !newClient.name.trim() || !newClient.adminEmail.trim()) return;
    setCreating(true);
    setOnboarded(null);
    try {
      const res = await apiFetch('/organizations/onboard', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          organization: { name: newClient.name.trim() },
          // D2: this screen ALWAYS sends a store, exactly as the old three-call
          // sequence always created one. The website inside it stays optional,
          // as it has always been — the cutover changes how many requests are
          // made, not what this form asks the operator for.
          store: { name: newClient.name.trim(), websiteUrl: newClient.websiteUrl.trim() || undefined },
          manager: { email: newClient.adminEmail.trim() },
        }),
      });
      const data = res?.data;
      if (!data?.organization?.id || !data?.manager?.id) throw new Error(t('The company was not created'));

      const deliveryStatus = deliveryStatusOf(data.invitation?.deliveryStatus);

      // No success message before the whole thing has committed — the toast
      // fires here, after one response, not between calls. A retry reports the
      // retry, never a delivery failure it did not observe.
      if (data.idempotent) {
        toast.success(t('That company was already created — nothing was duplicated.'));
      } else if (deliveryStatus === 'DELIVERED') {
        toast.success(`${t('Invitation sent to')} ${newClient.adminEmail.trim()}`);
      } else {
        // NOT a rollback: everything is committed, only the email did not go.
        toast.error(t('The company was created, but the invitation email could not be delivered.'));
      }
      setOnboarded({
        organizationId: data.organization.id,
        organizationName: data.organization.name,
        managerId: data.manager.id,
        managerEmail: data.manager.email,
        pending: data.invitation?.pending !== false,
        deliveryStatus,
        idempotent: Boolean(data.idempotent),
      });
      setIsNewOpen(false);
      setNewClient({ name: '', websiteUrl: '', adminEmail: '' });
      await refreshOverview();
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setCreating(false);
    }
  };

  /** The supported recovery when the invitation email did not arrive (D5). */
  const resendManagerInvitation = async () => {
    if (!accessToken || !onboarded) return;
    setResending(true);
    try {
      const res = await apiFetch(
        `/organizations/${onboarded.organizationId}/managers/${onboarded.managerId}/resend-invitation`,
        { method: 'POST', token: accessToken, body: JSON.stringify({}) },
      );
      // An explicit resend IS an attempt, so its outcome is knowable: the state
      // moves off UNKNOWN to whatever this attempt actually did.
      const deliveryStatus = deliveryStatusOf(res?.data?.deliveryStatus);
      setOnboarded({ ...onboarded, deliveryStatus, pending: res?.data?.pending !== false });
      if (deliveryStatus === 'DELIVERED') toast.success(`${t('Invitation sent to')} ${onboarded.managerEmail}`);
      else toast.error(t('The invitation still could not be delivered.'));
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setResending(false);
    }
  };

  const money = (value: number) => `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
  const activeClients = overview?.clients.filter((client) => !client.archivedAt) ?? [];
  const archivedClients = overview?.clients.filter((client) => client.archivedAt) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Clients')}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {t('Every client company: their plan, paid modules, activity and payments.')}
          </p>
        </div>
        <Button size="sm" tooltip={t('Create the company and invite its admin in one step')} onClick={() => setIsNewOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> {t('New Client')}
        </Button>
      </div>

      {/*
       * The outcome of the last onboarding, stated plainly.
       *
       * An undelivered invitation is NOT a failed onboarding: the company, its
       * website, its manager and the invitation itself are all committed. Saying
       * "failed" here would send the operator looking for a company that exists,
       * so the banner says exactly what happened and offers the one action that
       * fixes it.
       */}
      {onboarded && (
        <div
          data-testid="onboarding-result"
          data-delivery={onboarded.deliveryStatus}
          data-pending={onboarded.pending ? 'yes' : 'no'}
          className={`card p-4 flex items-start justify-between gap-4 ${
            !onboarded.pending || onboarded.deliveryStatus === 'DELIVERED'
              ? 'border-emerald-200 bg-emerald-50/40'
              : onboarded.deliveryStatus === 'FAILED'
                ? 'border-amber-200 bg-amber-50/40'
                : 'border-slate-200 bg-slate-50/60'
          }`}
        >
          <div className="space-y-1">
            <p className="text-sm font-semibold text-ink-strong">
              {onboarded.idempotent
                ? t('That company already existed — nothing was created twice.')
                : `${onboarded.organizationName} ${t('is ready.')}`}
            </p>
            {/*
             * FOUR STATES, and each says only what is known.
             *
             * An accepted invitation is read FIRST, because after acceptance
             * there is no invitation left to describe as delivered or failed —
             * and the old boolean kept offering to re-send one.
             */}
            <p className="text-xs text-slate-600" data-testid="onboarding-invitation-state">
              {!onboarded.pending
                ? `${t('Its manager')} ${onboarded.managerEmail} ${t('has already accepted the invitation and can sign in.')}`
                : onboarded.deliveryStatus === 'DELIVERED'
                  ? `${t('Its manager')} ${onboarded.managerEmail} ${t('has been invited and has not signed in yet.')}`
                  : onboarded.deliveryStatus === 'FAILED'
                    ? `${t('Its manager')} ${onboarded.managerEmail} ${t('was created, but the invitation email could not be delivered. Nothing was lost — send it again.')}`
                    : `${t('Its manager')} ${onboarded.managerEmail} ${t('still has an invitation open. Nothing was duplicated and no new email was sent — send it again if they need one.')}`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onboarded.pending && onboarded.deliveryStatus !== 'DELIVERED' && (
              <Button
                size="sm"
                variant="secondary"
                isLoading={resending}
                onClick={resendManagerInvitation}
                data-testid="onboarding-resend"
              >
                {t('Resend invitation')}
              </Button>
            )}
            <button
              type="button"
              className="text-xs text-slate-400 hover:text-slate-600"
              onClick={() => setOnboarded(null)}
              aria-label={t('Dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <Modal open={isNewOpen} title={t('New Client')} onClose={() => setIsNewOpen(false)}>
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            {t('Creates the company (Básico plan, read-only until its first payment) and emails its administrator an activation link.')}
          </p>
          <Input
            // The shared Input derives the label's `for` from `id || name`;
            // without one the label is decoration, not an association.
            name="clientCompanyName"
            label={t('Company name')}
            placeholder="Panadería La Estrella"
            value={newClient.name}
            onChange={(e) => setNewClient({ ...newClient, name: e.target.value })}
          />
          <Input
            name="clientAdminEmail"
            label={t('Client admin email')}
            placeholder="dueno@empresa.com"
            value={newClient.adminEmail}
            onChange={(e) => setNewClient({ ...newClient, adminEmail: e.target.value })}
          />
          <Input
            name="clientWebsiteUrl"
            label={t('Website URL (optional)')}
            placeholder="https://www.empresa.com"
            value={newClient.websiteUrl}
            onChange={(e) => setNewClient({ ...newClient, websiteUrl: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <Button variant="secondary" onClick={() => setIsNewOpen(false)}>{t('Cancel')}</Button>
            <Button
              isLoading={creating}
              disabled={!newClient.name.trim() || !newClient.adminEmail.trim()}
              onClick={createClient}
            >
              {t('Create and invite')}
            </Button>
          </div>
        </div>
      </Modal>

      {accessToken && (
        // #294: an ACTIVE company is a row of its own here, and is removable
        // without an archive first when it has no live branch. The overview
        // table below lists branches, so a branch-less company has no row there.
        <ActiveCompaniesCard
          accessToken={accessToken}
          canManagePlan={isOwner}
          plans={overview?.plans ?? []}
          onPlanChanged={refreshOverview}
          reloadNonce={reloadNonce}
        />
      )}

      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi label={t('Active clients')} value={String(overview.totals.activeClients)} />
          <Kpi
            label={t('Monthly recurring')}
            value={money(overview.totals.monthlyRecurringUsd)}
            sub={t('one plan per company')}
          />
          <Kpi label={t('Client orders this month')} value={String(overview.totals.ordersThisMonth)} />
          <Kpi label={t('Client sales this month')} value={money(overview.totals.revenueThisMonth)} />
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold text-slate-800">{t('Client companies')}</h3>
        </div>
        {!overview ? (
          <p className="p-5 text-xs text-slate-400">{t('Loading…')}</p>
        ) : overview.clients.length === 0 ? (
          <EmptyState message={t('No client companies yet.')} hint={t('Create their website in Websites / Apps.')} />
        ) : (
          <Table>
            <THead>
              <TH>{t('Client')}</TH>
              <TH>{t('Plan')}</TH>
              <TH>{t('Status')}</TH>
              <TH align="right">{t('Orders (month)')}</TH>
              <TH align="right">{t('Sales (month)')}</TH>
              <TH align="right">{t('Paid to date')}</TH>
              <TH align="right">{t('Actions')}</TH>
            </THead>
            <TBody>
              {[...activeClients, ...archivedClients].map((client) => (
                <TR key={client.id} className={client.archivedAt ? 'bg-slate-50 text-slate-400' : ''}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{client.name}</span>
                      {!client.archivedAt && isRecent(client.createdAt) && (
                        <Badge variant="accent">{t('New')}</Badge>
                      )}
                    </div>
                    {client.websiteUrl && (
                      <a
                        href={client.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-primary"
                      >
                        {client.websiteUrl.replace(/^https?:\/\//, '')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </TD>
                  <TD>
                    <span className="text-xs font-medium text-slate-700" data-testid={`client-plan-${client.id}`}>
                      {client.plan.name}
                      {client.plan.complimentary ? (
                        <>
                          {' '}
                          <Badge variant="success">{t('Free')}</Badge>
                        </>
                      ) : (
                        client.plan.priceUsd !== null && (
                          <span className="text-slate-400 font-normal"> — ${client.plan.priceUsd}</span>
                        )
                      )}
                    </span>
                  </TD>
                  <TD>
                    {client.archivedAt ? <Badge variant="neutral">{t('Archived')}</Badge> : billingBadge(client.billingStatus, t)}
                  </TD>
                  <TD align="right" className="tabular-nums text-xs">{client.ordersThisMonth}</TD>
                  <TD align="right" className="tabular-nums text-xs">{money(client.revenueThisMonth)}</TD>
                  <TD align="right" className="tabular-nums text-xs">
                    {money(client.totalPaid)}
                    {client.lastPaymentAt && (
                      <div className="text-[10px] text-slate-400">
                        {t('last one')} {new Date(client.lastPaymentAt).toLocaleDateString()}
                      </div>
                    )}
                  </TD>
                  <TD align="right">
                    <div className="inline-flex items-center gap-3">
                      {!client.archivedAt && (
                        <button
                          onClick={() => {
                            // Managing means entering the COMPANY, at company
                            // level (corrected in P5-W5).
                            //
                            // This used to narrow to the client's store as an
                            // "initial branch narrowing" (P0-11), which the
                            // P5-A2 authority model turned into a trap: a
                            // narrowed actor is acting as ONE BRANCH, so it may
                            // not archive a product or a category, may not
                            // reassign stores, and may not delete a shared
                            // file — and the branch selector that widens back
                            // out only appears for a company with more than one
                            // store. Entering a one-store client therefore left
                            // the owner permanently below the authority it
                            // actually holds, with no way back.
                            //
                            // Narrowing stays available and deliberate: pick a
                            // branch from the selector once inside.
                            enterManagedTenant({
                              organizationId: client.organizationId ?? client.id,
                              organizationName: client.name,
                            });
                            router.push('/dashboard');
                          }}
                          className="text-xs font-semibold text-primary hover:underline"
                          title={t('Work inside this company: its items, sales and settings')}
                        >
                          {t('Manage')}
                        </button>
                      )}
                      <Link href={`/dashboard/website/${client.id}`} className="text-xs font-semibold text-slate-400 hover:text-primary">
                        {t('Open')}
                      </Link>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}
