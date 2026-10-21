'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { CreditCard, Receipt } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { canViewSubscription, isUnscopedPlatformOwner } from '../../../lib/permissions';
import { apiFetch } from '../../../lib/api-client';
import { publishBillingInvalidation } from '../../../lib/billing-status';
import { createSingleFlight } from '../../../lib/checkout-flight';
import { useT } from '../../../lib/i18n';
import { useStores } from '../../../lib/use-website-config';
import { useToast } from '../../../components/ui/toast';
import Badge from '../../../components/ui/badge';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Modal from '../../../components/ui/modal';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import { tenantQueryIdentity, useBillingPageData } from '../../../lib/domain-queries';
import { queryKeys } from '../../../lib/query-client';

/** Billing: the company's subscription + its payment history. */
export default function BillingPage() {
  const { user, scope, accessToken } = useAuth();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { stores } = useStores();
  const [isRecordOpen, setIsRecordOpen] = useState(false);
  const [rec, setRec] = useState({ storeId: '', amountUsd: '', description: '', paidAt: '' });
  const [saving, setSaving] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  // One checkout request at a time for THIS mounted page (#248 PR C, D-9): a
  // second click while one is in flight joins it; a fresh mount (another
  // company, another visit) starts with no flight to join.
  const checkoutFlight = useRef(createSingleFlight<any>()).current;

  // Platform-owner detection comes from the resolved scope: a SUPER_ADMIN
  // working inside a managed organization is legitimately store-less and is
  // NOT the platform owner.
  const isOwner = isUnscopedPlatformOwner(scope);
  // A subscription describes a client ORGANIZATION. ADMIN, EDITOR and VIEWER
  // hold no billing authority; the platform owner keeps only the placeholder.
  const showSubscription = canViewSubscription(scope);
  const identity = tenantQueryIdentity(scope?.organizationId, scope?.storeId);
  const billingQuery = useBillingPageData(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    showSubscription,
    isOwner,
  );
  const subscription = billingQuery.data?.subscription ?? null;
  const payments = billingQuery.data?.payments ?? [];
  const stripeInfo = billingQuery.data?.stripeInfo ?? null;
  const recurring = billingQuery.data?.recurring ?? null;
  const refreshBilling = () => queryClient.invalidateQueries({ queryKey: queryKeys.billingPage(identity, isOwner ? 'owner' : showSubscription ? 'subscriber' : 'none') });

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('paid') === '1') {
      toast.success(t('Payment received — your plan is now active'));
      router.replace('/dashboard/billing');
      // Checkout ran in THIS tab (Stripe opened it with target=_blank), so the
      // tab the user started from still holds the pre-payment status. Broadcast
      // so every tab of this origin re-reads it, whatever its cache age (#185).
      publishBillingInvalidation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const payWithCard = async (planKey: string) => {
    setCheckingOut(true);
    try {
      const r = await checkoutFlight(() =>
        apiFetch('/billing/checkout', {
          method: 'POST',
          token: accessToken || '',
          body: JSON.stringify({ plan: planKey }),
        }),
      );
      if (r?.data?.url) window.open(r.data.url, '_blank');
    } catch (err: any) {
      toast.error(err.message || 'Failed to start checkout');
    } finally {
      setCheckingOut(false);
    }
  };

  const openPortal = async () => {
    try {
      const r = await apiFetch('/billing/portal', { method: 'POST', token: accessToken || '' });
      if (r?.data?.url) window.location.href = r.data.url;
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    }
  };

  const record = async () => {
    if (!accessToken || !rec.storeId || !rec.amountUsd || !rec.paidAt) return;
    setSaving(true);
    try {
      await apiFetch('/billing/payments', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          storeId: rec.storeId,
          amountUsd: parseFloat(rec.amountUsd),
          description: rec.description || 'Pago de suscripción',
          paidAt: new Date(rec.paidAt).toISOString(),
        }),
      });
      toast.success(t('Payment recorded'));
      setIsRecordOpen(false);
      setRec({ storeId: '', amountUsd: '', description: '', paidAt: '' });
      await refreshBilling();
      // Recording a payment can lift the client's read-only gate (#185)
      publishBillingInvalidation();
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Billing')}</h2>
          <p className="text-xs text-slate-500 mt-1">{t('Your subscription and payment history')}</p>
        </div>
        {isOwner && (
          <Button size="sm" tooltip={t('Record a payment received outside the platform')} onClick={() => setIsRecordOpen(true)}>
            {t('Record payment')}
          </Button>
        )}
      </div>

      {/* Subscription — organization-level, and only for actors entitled to it */}
      {(showSubscription || isOwner) && (
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold text-slate-800">{t('My subscription')}</h3>
        </div>
        <div className="p-5">
          {subscription === null ? (
            <p className="text-xs text-slate-400">{t('Loading…')}</p>
          ) : subscription.platformOwner ? (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-slate-600">{t('Platform owner — full access to every plan and client.')}</p>
              <Badge variant="success">{t('Active')}</Badge>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-800" data-testid="billing-current-plan">
                    {/^plan\b/i.test(subscription.plan.name) ? subscription.plan.name : `${t('Plan')} ${subscription.plan.name}`}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5" data-testid="billing-current-price">
                    {subscription.plan.complimentary
                      ? t('Free')
                      : subscription.plan.priceUsd !== null
                        ? `$${subscription.plan.priceUsd} / ${t('month')}`
                        : t('Custom pricing')}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="success">{t('Active')}</Badge>
                  {subscription.plan.complimentary ? (
                    // A complimentary plan is never billed: no card checkout, no
                    // portal, and no plan change a tenant could make itself.
                    <p className="text-xs text-slate-500 max-w-xs text-right" data-testid="billing-complimentary-note">
                      {t('Plan Gratis is assigned by Wegox and is never billed.')}
                    </p>
                  ) : subscription.stripeManaged ? (
                    <Button size="sm" variant="secondary" tooltip={t('Change card or cancel in the secure payment portal')} onClick={openPortal}>
                      {t('Manage payment')}
                    </Button>
                  ) : subscription.plan.priceUsd !== null ? (
                    <div className="text-right">
                      <Button size="sm" isLoading={checkingOut} onClick={() => payWithCard(subscription.plan.key)}>
                        {t('Activate card payment')} — ${subscription.plan.priceUsd}/{t('month')}
                      </Button>
                      <p className="mt-2 text-[11px] text-slate-400">
                        {t('By paying you accept the')}{' '}
                        <a href="/terminos" target="_blank" className="text-primary hover:underline">
                          {t('Terms of Service')}
                        </a>
                        . {t('Cancel anytime — no lock-in.')}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
              {stripeInfo?.active && stripeInfo.nextChargeAt && (
                <p className="text-xs text-slate-500">
                  {t('Next charge')}: <b>{new Date(stripeInfo.nextChargeAt).toLocaleDateString()}</b>
                  {stripeInfo.cardLast4 ? ` — ${t('card')} •••• ${stripeInfo.cardLast4}` : ''}
                </p>
              )}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="bg-slate-50 rounded-md p-3">
                  <p className="text-xs text-slate-400">{t('Team members')}</p>
                  <p className="font-bold text-slate-800">
                    {subscription.usage.teamUsers}
                    <span className="text-slate-400 font-normal"> / {subscription.usage.maxTeamUsers ?? '∞'}</span>
                  </p>
                </div>
                <div className="bg-slate-50 rounded-md p-3">
                  <p className="text-xs text-slate-400">{t('Websites')}</p>
                  <p className="font-bold text-slate-800">
                    {subscription.usage.websites}
                    <span className="text-slate-400 font-normal"> / {subscription.usage.maxWebsites ?? '∞'}</span>
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Payment history — the COMPANY's, so only actors entitled to its
          commercial terms see it at all. The owner-only "every company" table
          is gone with the unfiltered query that fed it. */}
      {showSubscription && (
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <Receipt className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold text-slate-800">{t('Payment history')}</h3>
        </div>
        {payments.length === 0 ? (
          <div className="p-6"><EmptyState message={t('No payments recorded yet.')} /></div>
        ) : (
          <Table>
            <THead>
              <TH>{t('Date')}</TH>
              <TH>{t('Branch')}</TH>
              <TH>{t('Description')}</TH>
              <TH>{t('Status')}</TH>
              <TH align="right">{t('Amount')}</TH>
            </THead>
            <TBody>
              {payments.map((p) => (
                <TR key={p.id}>
                  <TD className="text-xs text-slate-500">{new Date(p.paidAt).toLocaleDateString()}</TD>
                  <TD className="text-sm">{p.store?.name || '—'}</TD>
                  <TD className="text-sm">{p.description}</TD>
                  <TD><Badge variant={p.status === 'PAID' ? 'success' : 'warning'}>{p.status === 'PAID' ? t('Paid') : p.status}</Badge></TD>
                  <TD align="right" className="font-bold text-slate-800">
                    ${p.amountUsd}
                    {p.invoiceUrl && (
                      <a href={p.invoiceUrl} target="_blank" rel="noopener noreferrer" className="block text-[10px] font-semibold text-primary hover:underline">
                        {t('Invoice')}
                      </a>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      )}

      {/* Plans — inline comparison */}
      {subscription && !subscription.platformOwner && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-800">{t('Plans')}</h3>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
            {subscription.planManagedByPlatform && (
              <p className="md:col-span-2 text-xs text-slate-500" data-testid="billing-plan-managed-note">
                {t('To change your plan, contact your provider.')}
              </p>
            )}
            {(subscription?.plans || []).filter((plan: any) => !plan.complimentary).map((plan: any) => {
              const current = plan.key === subscription?.plan?.key;
              return (
                <div
                  key={plan.key}
                  data-testid={`billing-plan-option-${plan.key}`}
                  className={`rounded-lg border p-4 flex items-center justify-between gap-3 ${current ? 'border-primary bg-primary/5' : 'border-slate-200'}`}
                >
                  <div>
                    <p className="text-sm font-bold text-slate-800">{plan.name}</p>
                    <p className="text-xs text-slate-500">
                      {plan.maxWebsites === null && plan.maxTeamUsers === null
                        ? t('Custom websites & team members')
                        : `${plan.maxWebsites ?? '∞'} websites · ${plan.maxTeamUsers ?? '∞'} ${t('Team members').toLowerCase()}`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-slate-800">
                      {plan.priceUsd !== null ? `$${plan.priceUsd}/${t('month')}` : t('Custom pricing')}
                    </p>
                    {current ? (
                      <span className="text-[10px] font-semibold text-primary uppercase">{t('Your current plan')}</span>
                    ) : subscription.planManagedByPlatform ? null : plan.priceUsd !== null ? (
                      <Button size="sm" onClick={() => payWithCard(plan.key)}>{t('Pay by card')}</Button>
                    ) : (
                      <a className="text-xs font-semibold text-primary hover:underline" href={`mailto:contact.wegox@gmail.com?subject=${encodeURIComponent('Plan Corporativo — ' + (user?.company || ''))}`}>
                        {t('Request this plan')}
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Owner: recurring revenue. The platform's company-level total, each
          company counted once (#318) — never a sum over branch records, which
          carry no plan. */}
      {isOwner && (
        <div className="card p-5 flex items-center justify-between">
          <p className="text-sm font-bold text-slate-800">{t('Estimated monthly revenue')}</p>
          <p className="text-lg font-bold text-primary" data-testid="owner-recurring-revenue">
            {recurring ? `$${recurring.usd}` : '—'}
            <span className="text-xs text-slate-400 font-normal">
              {' '}
              / {t('month')}
              {recurring ? ` · ${recurring.companies} ${t('companies')}` : ''}
            </span>
          </p>
        </div>
      )}

      {/* Owner: record manual payment */}
      <Modal open={isRecordOpen} title={t('Record payment')} onClose={() => setIsRecordOpen(false)}>
        <div className="space-y-4">
          <Select label={t('Company')} value={rec.storeId} onChange={(e) => setRec({ ...rec, storeId: e.target.value })}>
            <option value="">—</option>
            {stores.filter((s) => !s.archivedAt).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Input label={t('Amount')} type="number" value={rec.amountUsd} onChange={(e) => setRec({ ...rec, amountUsd: e.target.value })} />
            <Input label={t('Date')} type="date" value={rec.paidAt} onChange={(e) => setRec({ ...rec, paidAt: e.target.value })} />
          </div>
          <Input label={t('Description')} placeholder="Plan Básico — julio 2026" value={rec.description} onChange={(e) => setRec({ ...rec, description: e.target.value })} />
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <Button variant="secondary" onClick={() => setIsRecordOpen(false)}>{t('Cancel')}</Button>
            <Button isLoading={saving} onClick={record}>{t('Save')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
