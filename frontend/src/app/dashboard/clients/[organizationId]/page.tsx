'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Boxes, CalendarClock, CreditCard, ExternalLink, FolderTree, LogIn, Mail, PackageCheck, Receipt, Send, Store, UserPlus, Users } from 'lucide-react';
import { useAuth } from '../../../../lib/auth';
import { isUnscopedPlatformOwner } from '../../../../lib/permissions';
import { enterManagedTenant } from '../../../../lib/managed-tenant';
import { useClientDetails } from '../../../../lib/domain-queries';
import { queryKeys } from '../../../../lib/query-client';
import { useT } from '../../../../lib/i18n';
import { apiFetch } from '../../../../lib/api-client';
import { useToast } from '../../../../components/ui/toast';
import Button from '../../../../components/ui/button';
import Badge from '../../../../components/ui/badge';
import Input from '../../../../components/ui/input';
import Modal from '../../../../components/ui/modal';
import CompanyPlanModal from '../../../../features/organizations/components/company-plan-modal';

const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value || 0);
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString() : '—';

function Metric({ icon: Icon, label, value, detail }: { icon: any; label: string; value: string | number; detail?: string }) {
  return <div className="card min-w-0 p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">{label}</p>
        <p className="mt-1 truncate text-2xl font-bold tabular-nums text-ink-strong">{value}</p>
        {detail && <p className="mt-1 truncate text-xs text-slate-500">{detail}</p>}
      </div>
      <span className="rounded-lg bg-blue-50 p-2 text-primary"><Icon className="h-4 w-4" /></span>
    </div>
  </div>;
}

export default function ClientDetailsPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const { user, scope, accessToken, refreshScope } = useAuth();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isOwner = isUnscopedPlatformOwner(scope);
  const detailsQuery = useClientDetails(accessToken, organizationId, isOwner);
  const details = detailsQuery.data;
  const [planOpen, setPlanOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ email: '', firstName: '', lastName: '' });
  const [inviting, setInviting] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  // Stable for this screen lifetime; avoids an impure Date.now() call in JSX.
  const [openedAt] = useState(Date.now);

  useEffect(() => { if (user && scope && !isOwner) router.replace('/dashboard'); }, [user, scope, isOwner, router]);
  if (!user || !isOwner) return null;

  const enterCompany = async () => {
    if (!details) return;
    enterManagedTenant({ organizationId, organizationName: details.company.name });
    await refreshScope();
    router.push('/dashboard');
  };

  const createManager = async () => {
    if (!accessToken || !invite.email.trim()) return;
    setInviting(true);
    try {
      const response = await apiFetch(`/organizations/${organizationId}/administrators`, {
        method: 'POST', token: accessToken,
        body: JSON.stringify({ email: invite.email.trim(), firstName: invite.firstName.trim() || undefined, lastName: invite.lastName.trim() || undefined }),
      });
      if (response?.data?.invitation?.deliveryStatus === 'DELIVERED') toast.success(t('The administrator was created and the invitation was delivered.'));
      else toast.error(t('The administrator was created, but the email could not be delivered. You can resend it below.'));
      setInviteOpen(false);
      setInvite({ email: '', firstName: '', lastName: '' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.clientDetails(organizationId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.ownerOverview });
    } catch (error: any) {
      toast.error(error?.message || t('The administrator could not be invited.'));
    } finally {
      setInviting(false);
    }
  };

  const resendInvitation = async (managerId: string) => {
    if (!accessToken) return;
    setResendingId(managerId);
    try {
      const response = await apiFetch(`/organizations/${organizationId}/managers/${managerId}/resend-invitation`, {
        method: 'POST', token: accessToken, body: JSON.stringify({}),
      });
      if (response?.data?.deliveryStatus === 'DELIVERED') toast.success(t('A new invitation was delivered.'));
      else toast.error(t('A new invitation was created, but the email could not be delivered.'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.clientDetails(organizationId) });
    } catch (error: any) {
      toast.error(error?.message || t('The invitation could not be resent.'));
    } finally {
      setResendingId(null);
    }
  };

  if (detailsQuery.isLoading) return <div className="space-y-4"><div className="h-8 w-60 animate-pulse rounded bg-slate-200" /><div className="h-40 animate-pulse rounded-xl bg-slate-100" /></div>;
  if (detailsQuery.isError || !details) return <div className="card p-8 text-center"><p className="font-semibold text-slate-800">{t('The client details could not be loaded.')}</p><Button variant="secondary" className="mt-4" onClick={() => detailsQuery.refetch()}>{t('Try again')}</Button></div>;

  const renewal = details.plan.nextChargeAt
    ? date(details.plan.nextChargeAt)
    : details.plan.stripeManaged ? t('Unavailable from Stripe') : t('No automatic renewal');

  return <div className="space-y-6 pb-10">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <Link href="/dashboard/clients" className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-primary"><ArrowLeft className="h-3.5 w-3.5" /> {t('Clients')}</Link>
        <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold text-ink-strong">{details.company.name}</h1><Badge variant={details.company.status === 'ARCHIVED' ? 'neutral' : 'success'}>{details.company.status}</Badge></div>
        <p className="mt-1 text-sm text-slate-500">{t('Client since')} {date(details.company.createdAt)} · {details.company.slug}</p>
      </div>
      <Button onClick={enterCompany} disabled={Boolean(details.company.archivedAt)}><LogIn className="h-4 w-4" /> {t('Access as client')}</Button>
    </div>

    <section className="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
      <div className="card p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div><p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">{t('Current plan')}</p>
            <h2 className="mt-1 text-xl font-bold text-slate-900">{details.plan.name}</h2>
            <p className="mt-1 text-sm text-slate-500">{details.plan.complimentary ? t('Complimentary plan') : details.plan.priceUsd == null ? t('Custom pricing') : `${money(details.plan.priceUsd)} / ${t('month')}`}</p>
          </div>
          <Button variant="secondary" onClick={() => setPlanOpen(true)}>{t('Change plan')}</Button>
        </div>
        <div className="mt-5 grid gap-3 border-t border-slate-100 pt-5 sm:grid-cols-3">
          <div><p className="text-xs text-slate-400">{t('Renewal')}</p><p className="mt-1 text-sm font-semibold text-slate-700">{renewal}</p></div>
          <div><p className="text-xs text-slate-400">{t('Website limit')}</p><p className="mt-1 text-sm font-semibold text-slate-700">{details.plan.maxWebsites ?? '∞'}</p></div>
          <div><p className="text-xs text-slate-400">{t('Team limit')}</p><p className="mt-1 text-sm font-semibold text-slate-700">{details.plan.maxTeamUsers ?? '∞'}</p></div>
        </div>
      </div>
      <Metric icon={CalendarClock} label={t('Next renewal')} value={renewal} detail={details.plan.subscriptionStatus ?? undefined} />
    </section>

    <section><h2 className="mb-3 text-sm font-bold text-slate-800">{t('Catalog and team')}</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon={Boxes} label={t('Products')} value={details.usage.products} detail={`${details.usage.publishedProducts} ${t('published')}`} />
        <Metric icon={FolderTree} label={t('Categories')} value={details.usage.categories} />
        <Metric icon={Store} label={t('Branches')} value={details.usage.activeStores} detail={`${details.usage.stores} ${t('total')}`} />
        <Metric icon={Users} label={t('Team')} value={details.usage.activeTeamUsers} detail={`${details.usage.pendingInvitations} ${t('pending invitations')}`} />
      </div>
    </section>

    <section><h2 className="mb-3 text-sm font-bold text-slate-800">{t('Commercial activity')}</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon={PackageCheck} label={t('Orders this month')} value={details.commerce.ordersThisMonth} detail={`${details.commerce.ordersTotal} ${t('total')}`} />
        <Metric icon={Receipt} label={t('Revenue this month')} value={money(details.commerce.revenueThisMonth)} detail={`${money(details.commerce.revenueTotal)} ${t('all time')}`} />
        <Metric icon={CreditCard} label={t('Paid to date')} value={money(details.commerce.totalPaid)} detail={`${details.commerce.paymentsCount} ${t('payments')}`} />
        <Metric icon={CalendarClock} label={t('Last payment')} value={date(details.commerce.lastPaymentAt)} />
      </div>
    </section>

    <section className="grid gap-4 lg:grid-cols-2">
      <div className="card overflow-hidden"><div className="border-b border-slate-100 px-5 py-4"><h2 className="font-bold text-slate-800">{t('Branches and websites')}</h2></div>
        <div className="divide-y divide-slate-100">{details.stores.length ? details.stores.map((store) => <div key={store.id} className="flex items-center justify-between gap-3 px-5 py-4"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{store.name}</p><p className="truncate text-xs text-slate-400">{store.websiteUrl || t('No website connected')}</p></div><Badge variant={store.archivedAt ? 'neutral' : 'success'}>{store.archivedAt ? t('Archived') : t('Active')}</Badge></div>) : <p className="p-5 text-sm text-slate-400">{t('No branches yet.')}</p>}</div>
      </div>
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <h2 className="font-bold text-slate-800">{t('Company administrators')}</h2>
          {details.managers.length === 0 && !details.company.archivedAt && <Button size="sm" onClick={() => setInviteOpen(true)}><UserPlus className="h-4 w-4" /> {t('Invite administrator')}</Button>}
        </div>
        <div className="divide-y divide-slate-100">{details.managers.length ? details.managers.map((manager) => {
          const expired = manager.pendingInvite && (!manager.invitationExpiresAt || new Date(manager.invitationExpiresAt).getTime() <= openedAt);
          return <div key={manager.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3"><span className="rounded-full bg-slate-100 p-2"><Mail className="h-4 w-4 text-slate-500" /></span><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{[manager.firstName, manager.lastName].filter(Boolean).join(' ') || manager.email}</p><p className="truncate text-xs text-slate-400">{manager.email}</p>{manager.pendingInvite && manager.invitationExpiresAt && !expired && <p className="mt-1 text-[11px] text-slate-400">{t('Invitation expires')} {date(manager.invitationExpiresAt)}</p>}</div></div>
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <Badge variant={manager.deletedAt ? 'neutral' : manager.pendingInvite ? (expired ? 'danger' : 'warning') : 'success'}>{manager.deletedAt ? t('Deactivated') : manager.pendingInvite ? (expired ? t('Invitation expired') : t('Invitation pending')) : t('Active')}</Badge>
              {manager.pendingInvite && !manager.deletedAt && <Button size="sm" variant="secondary" isLoading={resendingId === manager.id} onClick={() => resendInvitation(manager.id)}><Send className="h-3.5 w-3.5" /> {t('Resend')}</Button>}
            </div>
          </div>;
        }) : <div className="m-4 rounded-lg border border-amber-200 bg-amber-50 p-4"><div className="flex gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" /><div><p className="text-sm font-semibold text-amber-900">{t('This company cannot access the panel yet.')}</p><p className="mt-1 text-xs leading-5 text-amber-800">{t('Invite its first administrator. They will receive a secure link to create their password and activate the account.')}</p></div></div></div>}</div>
      </div>
    </section>

    <section className="card overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-4"><h2 className="font-bold text-slate-800">{t('Recent payments')}</h2></div>
      {details.recentPayments.length ? <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3 text-left">{t('Date')}</th><th className="px-5 py-3 text-left">{t('Description')}</th><th className="px-5 py-3 text-left">{t('Branch')}</th><th className="px-5 py-3 text-right">{t('Amount')}</th><th className="px-5 py-3 text-right">{t('Invoice')}</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{details.recentPayments.map((payment) => <tr key={payment.id}><td className="whitespace-nowrap px-5 py-3 text-slate-500">{date(payment.paidAt)}</td><td className="px-5 py-3 font-medium text-slate-700">{payment.description || '—'}</td><td className="px-5 py-3 text-slate-500">{payment.storeName}</td><td className="whitespace-nowrap px-5 py-3 text-right font-semibold tabular-nums">{money(payment.amountUsd)}</td><td className="px-5 py-3 text-right">{payment.invoiceUrl ? <a href={payment.invoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-primary">{t('Open')}<ExternalLink className="h-3 w-3" /></a> : '—'}</td></tr>)}</tbody></table></div> : <p className="p-5 text-sm text-slate-400">{t('No payments recorded yet.')}</p>}
    </section>

    <CompanyPlanModal company={planOpen ? { id: organizationId, name: details.company.name, plan: details.plan.key } : null}
      plans={details.availablePlans} accessToken={accessToken as string} onClose={() => setPlanOpen(false)}
      onSaved={() => { setPlanOpen(false); queryClient.invalidateQueries({ queryKey: queryKeys.clientDetails(organizationId) }); queryClient.invalidateQueries({ queryKey: queryKeys.ownerOverview }); }} />

    <Modal open={inviteOpen} title={t('Invite company administrator')} onClose={() => !inviting && setInviteOpen(false)}>
      <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-500">{t('This person will manage the whole company. We will email a single-use activation link so they can choose their own password.')}</p>
        <Input name="managerEmail" type="email" label={t('Email address')} value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input name="managerFirstName" label={t('First name (optional)')} value={invite.firstName} onChange={(event) => setInvite({ ...invite, firstName: event.target.value })} />
          <Input name="managerLastName" label={t('Last name (optional)')} value={invite.lastName} onChange={(event) => setInvite({ ...invite, lastName: event.target.value })} />
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><Button variant="secondary" disabled={inviting} onClick={() => setInviteOpen(false)}>{t('Cancel')}</Button><Button isLoading={inviting} disabled={!invite.email.trim()} onClick={createManager}><Send className="h-4 w-4" /> {t('Create and send invitation')}</Button></div>
      </div>
    </Modal>
  </div>;
}
