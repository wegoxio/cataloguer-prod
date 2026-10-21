'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  BadgeCheck,
  Building2,
  Languages,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { apiFetch } from '../../../lib/api-client';
import { canViewSubscription } from '../../../lib/permissions';
import { useBillingStatus } from '../../../lib/billing-status';
import { notifyStoresUpdated, useStores } from '../../../lib/use-website-config';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useToast } from '../../../components/ui/toast';
import Input from '../../../components/ui/input';
import Textarea from '../../../components/ui/textarea';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Modal from '../../../components/ui/modal';
import ChangePasswordModal from '../../../components/layout/change-password-modal';
import { useI18n } from '../../../lib/i18n';
import { useSessions, useSettings } from '../../../lib/domain-queries';
import { queryKeys } from '../../../lib/query-client';

const settingsSchema = z.object({
  companyName: z.string().optional(),
  companyEmail: z.string().email('Invalid email address').or(z.literal('')).optional(),
  companyPhone: z.string().optional(),
  companyAddress: z.string().optional(),
  currency: z.string().max(10, 'Currency code must be 10 characters or less').optional(),
  timezone: z.string().max(100, 'Timezone must be 100 characters or less').optional(),
  announcementTitle: z.string().max(150).optional(),
  announcementBody: z.string().max(2000).optional(),
  announcementUrl: z.string().max(500).optional(),
});

type SettingsFormValues = z.infer<typeof settingsSchema>;

// Standard modules a company may hide (labels reuse the sidebar's keys);
// must stay in sync with HIDEABLE_MODULES in the backend stores service
const HIDEABLE_MODULES: Array<{ key: string; label: string }> = [
  { key: 'IMPORT_EXPORT', label: 'Import / Export' },
  { key: 'AUDIT_LOG', label: 'Audit Log' },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 pt-2">{children}</h3>
  );
}

function Card({
  icon: Icon,
  title,
  badge,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
        {badge}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { user, scope, accessToken, login, refreshIdentity } = useAuth();
  const { lang, setLang, t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { stores } = useStores();

  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [profile, setProfile] = useState({ firstName: '', lastName: '' });
  const [profileSaving, setProfileSaving] = useState(false);

  // Change login email: confirmed via a link sent to the new address
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailForm, setEmailForm] = useState({ newEmail: '', currentPassword: '' });
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  // Company card (scoped admins): their own store's identity + contact
  const [company, setCompany] = useState({
    name: '',
    contactEmail: '',
    contactPhone: '',
    contactAddress: '',
  });
  const [companySaving, setCompanySaving] = useState(false);
  // Customization card: standard modules hidden from the sidebar
  const [hiddenModules, setHiddenModules] = useState<string[] | null>(null);
  const [modulesSaving, setModulesSaving] = useState(false);
  // Shared with the dashboard banner (#185): one read per tenant, refreshed
  // on real billing events instead of on every navigation.
  const { status: billingStatus, plan, isLoading: billingLoading } = useBillingStatus();
  /**
   * P5-A2 family 3 (D-5). `/billing/status` carries two different things, and
   * the server separates them by authority: the OPERATIONAL state reaches
   * every role, while `plan` — price and contractual limits — reaches only
   * organization authority. This predicate is the SUBSCRIPTION card's own
   * gate, independent of `canEditCompany`: seeing what the company pays is
   * not permission to edit the company.
   */
  const showsCommercialTerms = canViewSubscription(scope);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      companyName: '',
      companyEmail: '',
      companyPhone: '',
      companyAddress: '',
      currency: 'USD',
      timezone: 'UTC',
      announcementTitle: '',
      announcementBody: '',
      announcementUrl: '',
    },
  });

  // Everyone gets the Security section; global company settings stay admin-only
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  // Deployment-wide settings belong to the platform owner, not store-bound clients
  const canEditGlobal = isAdmin && !user?.store;
  const canEditCompany = isAdmin && !!user?.store;

  const applySettings = useCallback(
    (data: any) => {
      reset({
        companyName: data.companyName || '',
        companyEmail: data.companyEmail || '',
        companyPhone: data.companyPhone || '',
        companyAddress: data.companyAddress || '',
        currency: data.currency || 'USD',
        timezone: data.timezone || 'UTC',
        announcementTitle: data.announcementTitle || '',
        announcementBody: data.announcementBody || '',
        announcementUrl: data.announcementUrl || '',
      });
    },
    [reset],
  );

  const settingsQuery = useSettings(accessToken, scope?.organizationId, Boolean(isAdmin && !user?.store));
  const loading = settingsQuery.isPending;
  const error = settingsQuery.isError ? 'Unable to load settings.' : null;

  useEffect(() => {
    if (settingsQuery.data) applySettings(settingsQuery.data);
  }, [settingsQuery.data, applySettings]);

  // Scoped clients: load their company details and plan
  useEffect(() => {
    if (!user?.store) return;
    const own = stores.find((store) => store.id === user.store!.id) ?? stores[0];
    if (!own) return;
    setCompany({
      name: own.name || '',
      contactEmail: own.contactEmail || '',
      contactPhone: own.contactPhone || '',
      contactAddress: own.contactAddress || '',
    });
    setHiddenModules(own.hiddenModules ?? []);
  }, [stores, user?.store]);

  const toggleModule = async (moduleKey: string) => {
    if (!accessToken || !user?.store || hiddenModules === null) return;
    const next = hiddenModules.includes(moduleKey)
      ? hiddenModules.filter((key) => key !== moduleKey)
      : [...hiddenModules, moduleKey];
    setModulesSaving(true);
    try {
      await apiFetch(`/stores/${user.store.id}`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ hiddenModules: next }),
      });
      setHiddenModules(next);
      notifyStoresUpdated(); // the sidebar re-reads its modules instantly
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setModulesSaving(false);
    }
  };

  const saveCompany = async () => {
    if (!accessToken || !user?.store) return;
    setCompanySaving(true);
    try {
      await apiFetch(`/stores/${user.store.id}`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({
          name: company.name,
          contactEmail: company.contactEmail,
          contactPhone: company.contactPhone,
          contactAddress: company.contactAddress,
        }),
      });
      toast.success(t('Company details saved'));
      notifyStoresUpdated(); // renames reach the sidebar and website lists at once
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setCompanySaving(false);
    }
  };

  const onSubmit = async (values: SettingsFormValues) => {
    if (!accessToken) return;
    try {
      const response = await apiFetch('/settings', {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({
          companyName: values.companyName || null,
          companyEmail: values.companyEmail || null,
          companyPhone: values.companyPhone || null,
          companyAddress: values.companyAddress || null,
          currency: values.currency || 'USD',
          timezone: values.timezone || 'UTC',
          announcementTitle: values.announcementTitle ?? '',
          announcementBody: values.announcementBody ?? '',
          announcementUrl: values.announcementUrl ?? '',
        }),
      });
      if (response?.data) {
        toast.success('Settings updated');
        applySettings(response.data);
      }
    } catch (err: any) {
      toast.error(err.message || 'Unable to save settings');
    }
  };

  useEffect(() => {
    if (user) setProfile({ firstName: user.firstName || '', lastName: user.lastName || '' });
  }, [user]);

  const saveProfile = async () => {
    if (!accessToken) return;
    setProfileSaving(true);
    try {
      await apiFetch('/auth/profile', {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify(profile),
      });
      toast.success(t('Profile updated'));
      await refreshIdentity();
      setProfileSaving(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed');
      setProfileSaving(false);
    }
  };

  // Two-factor authentication enrollment
  const [mfaOpen, setMfaOpen] = useState(false);
  const [mfaStep, setMfaStep] = useState<'password' | 'scan' | 'codes'>('password');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaQr, setMfaQr] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [mfaRecovery, setMfaRecovery] = useState<string[]>([]);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaDisableOpen, setMfaDisableOpen] = useState(false);
  const [mfaEnabledLocal, setMfaEnabledLocal] = useState<boolean | null>(null);
  const mfaEnabled = mfaEnabledLocal ?? Boolean(user?.mfaEnabled);

  const startMfaSetup = async () => {
    if (!accessToken) return;
    setMfaBusy(true);
    try {
      const r = await apiFetch('/auth/mfa/setup', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ currentPassword: mfaPassword }),
      });
      setMfaSecret(r?.data?.secret ?? '');
      // QR generation is needed only during MFA enrolment; keep the library
      // out of the ordinary Settings route chunk.
      const QRCode = await import('qrcode');
      setMfaQr(await QRCode.default.toDataURL(r?.data?.otpauthUrl ?? '', { margin: 1, width: 200 }));
      setMfaStep('scan');
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setMfaBusy(false);
    }
  };

  const confirmMfaEnable = async () => {
    if (!accessToken) return;
    setMfaBusy(true);
    try {
      const r = await apiFetch('/auth/mfa/enable', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ code: mfaCode }),
      });
      setMfaRecovery(r?.data?.recoveryCodes ?? []);
      setMfaEnabledLocal(true);
      setMfaStep('codes');
      toast.success(t('Two-factor authentication enabled'));
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setMfaBusy(false);
    }
  };

  const disableMfa = async () => {
    if (!accessToken) return;
    setMfaBusy(true);
    try {
      await apiFetch('/auth/mfa/disable', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ currentPassword: mfaPassword, code: mfaCode }),
      });
      setMfaEnabledLocal(false);
      setMfaDisableOpen(false);
      setMfaPassword('');
      setMfaCode('');
      toast.success(t('Two-factor authentication disabled'));
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setMfaBusy(false);
    }
  };

  // Active sessions (Security card)
  const sessionsQuery = useSessions(accessToken);
  const sessions = sessionsQuery.data ?? [];
  const refreshSessions = () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions });

  const revokeSession = async (id: string) => {
    try {
      await apiFetch(`/auth/sessions/${id}`, { method: 'DELETE', token: accessToken || '' });
      toast.success(t('Session closed'));
      await refreshSessions();
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    }
  };

  const requestEmailChange = async () => {
    if (!accessToken) return;
    setEmailSending(true);
    try {
      await apiFetch('/auth/request-email-change', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify(emailForm),
      });
      setEmailSent(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setEmailSending(false);
    }
  };

  const handleChangePassword = async (currentPassword: string, newPassword: string) => {
    if (!user || !accessToken) return;
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      // Sessions were revoked server-side; re-login silently with the new password
      await login(user.email, newPassword);
      toast.success('Password changed');
      setIsPasswordOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to change password');
    }
  };

  if (!user) {
    return null;
  }

  const roleLabel =
    user.role === 'ADMIN' || user.role === 'SUPER_ADMIN'
      ? t('Administrator')
      : user.role === 'EDITOR'
        ? t('Editor')
        : t('Viewer');

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t('Settings')}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {t('Your account, your company and your plan — all in one place.')}
        </p>
      </div>

      <SectionTitle>{t('Your account')}</SectionTitle>
      <div className="space-y-5">
        <Card icon={UserRound} title={t('Profile')}>
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="text-xs text-slate-500">
                <p className="font-medium text-slate-700">{user.email}</p>
                <p>
                  {t('Signed in as')} {roleLabel}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                tooltip={t('Move your account to a different email address')}
                onClick={() => {
                  setEmailForm({ newEmail: '', currentPassword: '' });
                  setEmailSent(false);
                  setEmailModalOpen(true);
                }}
              >
                {t('Change email')}
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Input
                label={t('First Name (optional)')}
                className="flex-1 min-w-[130px]"
                value={profile.firstName}
                onChange={(e) => setProfile({ ...profile, firstName: e.target.value })}
              />
              <Input
                label={t('Last Name (optional)')}
                className="flex-1 min-w-[130px]"
                value={profile.lastName}
                onChange={(e) => setProfile({ ...profile, lastName: e.target.value })}
              />
              <Button size="sm" isLoading={profileSaving} onClick={saveProfile}>
                {t('Save')}
              </Button>
            </div>
          </div>
        </Card>

        <Card icon={Languages} title={t('Language')}>
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-slate-500">{t('Applies to this browser only — every user picks their own.')}</p>
              <div className="flex rounded-md border border-slate-200 overflow-hidden shrink-0">
                <button
                  onClick={() => setLang('en')}
                  className={`px-4 py-1.5 text-xs font-semibold transition-colors ${lang === 'en' ? 'bg-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                >
                  English
                </button>
                <button
                  onClick={() => setLang('es')}
                  className={`px-4 py-1.5 text-xs font-semibold transition-colors ${lang === 'es' ? 'bg-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                >
                  Español
                </button>
              </div>
            </div>
          </Card>

          <Card icon={ShieldCheck} title={t('Security')}>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-slate-500">{t('Changing your password signs you out everywhere else.')}</p>
                <Button size="sm" variant="secondary" tooltip={t('Choose a new password for your account')} onClick={() => setIsPasswordOpen(true)}>
                  {t('Change Password')}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-4 pt-3 border-t border-slate-100">
                <div>
                  <p className="text-xs font-semibold text-slate-700">{t('Two-factor authentication')}</p>
                  <p className="text-xs text-slate-500">
                    {mfaEnabled
                      ? t('Active — your account asks for a code on every sign-in.')
                      : t('Add a 6-digit code from your phone to every sign-in.')}
                  </p>
                </div>
                {mfaEnabled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() => {
                      setMfaPassword('');
                      setMfaCode('');
                      setMfaDisableOpen(true);
                    }}
                  >
                    {t('Disable')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setMfaStep('password');
                      setMfaPassword('');
                      setMfaCode('');
                      setMfaOpen(true);
                    }}
                  >
                    {t('Enable')}
                  </Button>
                )}
              </div>
              {sessions.length > 0 && (
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    {t('Active sessions')} ({sessions.length})
                  </p>
                  <ul className="space-y-1.5">
                    {sessions.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <p className="text-slate-600 truncate" title={s.userAgent || ''}>
                            {(s.userAgent || t('Unknown device')).slice(0, 60)}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            {s.ip || '—'} · {new Date(s.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <Button size="sm" variant="ghost" className="text-danger shrink-0" onClick={() => revokeSession(s.id)}>
                          {t('Close')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>
      </div>

      {canEditCompany && (
        <>
          <SectionTitle>{t('Your company')}</SectionTitle>
          <div className="space-y-5">
            <Card icon={Building2} title={t('Company details')}>
              <div className="space-y-3">
                <Input
                  label={t('Company Name')}
                  value={company.name}
                  onChange={(e) => setCompany({ ...company, name: e.target.value })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label={t('Contact email')}
                    placeholder="ventas@tuempresa.com"
                    value={company.contactEmail}
                    onChange={(e) => setCompany({ ...company, contactEmail: e.target.value })}
                  />
                  <Input
                    label={t('Contact phone')}
                    placeholder="+58 412 1234567"
                    value={company.contactPhone}
                    onChange={(e) => setCompany({ ...company, contactPhone: e.target.value })}
                  />
                </div>
                <Textarea
                  label={t('Address')}
                  rows={2}
                  value={company.contactAddress}
                  onChange={(e) => setCompany({ ...company, contactAddress: e.target.value })}
                />
                <div className="flex justify-end">
                  <Button size="sm" isLoading={companySaving} onClick={saveCompany}>
                    {t('Save')}
                  </Button>
                </div>
              </div>
            </Card>

            <Card icon={SlidersHorizontal} title={t('Customization')}>
              <div className="space-y-3">
                <p className="text-xs text-slate-500">
                  {t('Hide the modules your business does not use — the sidebar gets simpler and nothing is deleted. Turn them back on any time.')}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {HIDEABLE_MODULES.map((mod) => {
                    const visible = hiddenModules !== null && !hiddenModules.includes(mod.key);
                    return (
                      <label
                        key={mod.key}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium cursor-pointer transition-colors ${
                          visible ? 'border-slate-200 text-slate-700' : 'border-slate-100 bg-slate-50 text-slate-400'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={visible}
                          disabled={hiddenModules === null || modulesSaving}
                          onChange={() => toggleModule(mod.key)}
                          className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
                        />
                        {t(mod.label)}
                      </label>
                    );
                  })}
                </div>
              </div>
            </Card>

          </div>
        </>
      )}

      {/*
        SUBSCRIPTION — a COMMERCIAL surface, and therefore gated on its own
        (P5-A2 family 3, D-5).

        It used to live inside the company block, whose predicate is
        `isAdmin && !!user.store`: an ORGANIZATION_MANAGER, which has no store
        binding, never saw its own company's plan even though the server sends
        it. Company details and Customization keep that editing predicate
        untouched — visibility of the plan is not authority to edit anything —
        while the plan card follows `canViewSubscription`, the same matrix the
        Billing page and the sidebar use:
        OM and managed SUPER_ADMIN yes, ADMIN / EDITOR / VIEWER / unscoped
        SUPER_ADMIN no.
      */}
      {showsCommercialTerms && (
        <div className="space-y-5">
          <Card
            icon={BadgeCheck}
            title={t('Your plan')}
            badge={
              // null while loading: stay on "Active" so the card never
              // flashes a payment warning the company doesn't have
              !billingStatus || billingStatus === 'ACTIVE' ? (
                <Badge variant="success">{t('Active')}</Badge>
              ) : (
                <Badge variant="warning">{t('Payment pending')}</Badge>
              )
            }
          >
            {plan ? (
              <div className="space-y-3">
                <p className="text-lg font-bold text-slate-800">
                  {plan.name}
                  {plan.complimentary ? (
                    <span className="text-sm font-normal text-slate-400"> — {t('Free')}</span>
                  ) : (
                    plan.priceUsd !== null && (
                      <span className="text-sm font-normal text-slate-400"> — ${plan.priceUsd}/{t('month')}</span>
                    )
                  )}
                </p>
                <ul className="text-xs text-slate-500 space-y-1">
                  <li>
                    • {plan.maxWebsites === null ? t('Unlimited websites') : `${plan.maxWebsites} ${plan.maxWebsites === 1 ? t('website') : t('websites')}`}
                  </li>
                  <li>
                    • {plan.maxTeamUsers === null ? t('Unlimited team users') : `${plan.maxTeamUsers} ${t('team users')}`}
                  </li>
                </ul>
                <Link href="/dashboard/billing" className="inline-block text-xs font-semibold text-primary hover:underline">
                  {t('Payments, invoices and plan changes')} →
                </Link>
              </div>
            ) : billingLoading ? (
              <p className="text-xs text-slate-400">{t('Loading...')}</p>
            ) : (
              /*
               * FAIL CLOSED. Only this card's own audience reaches here, so a
               * null plan is not "withheld from you" — the read finished
               * without one, which on this provider means it failed (it fails
               * open to `status: ACTIVE, plan: null` so a network error cannot
               * trap a paying customer behind a read-only banner). Say that
               * plainly rather than spinning on "Loading…" forever: no
               * commercial terms, no invented plan, no action offered.
               */
              <p className="text-xs text-slate-400">{t('Plan information is currently unavailable.')}</p>
            )}
          </Card>
        </div>
      )}

      {canEditGlobal && (
        <>
          <SectionTitle>{t('Platform')}</SectionTitle>
          <Card icon={Building2} title={t('Global Settings')}>
            {error && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">{error}</div>
            )}
            {loading ? (
              <div className="text-slate-500 text-sm">{t('Loading settings...')}</div>
            ) : (
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input label={t('Company Name')} error={errors.companyName?.message} {...register('companyName')} />
                  <Input label={t('Company Email')} error={errors.companyEmail?.message} {...register('companyEmail')} />
                  <Input label={t('Company Phone')} error={errors.companyPhone?.message} {...register('companyPhone')} />
                  <div className="grid grid-cols-2 gap-4">
                    <Input label={t('Currency')} error={errors.currency?.message} {...register('currency')} />
                    <Input label={t('Timezone')} error={errors.timezone?.message} {...register('timezone')} />
                  </div>
                </div>
                <Textarea
                  label={t('Company Address')}
                  rows={2}
                  error={errors.companyAddress?.message}
                  {...register('companyAddress')}
                />
                <div className="pt-3 border-t border-slate-100 space-y-3">
                  <p className="text-xs font-bold text-slate-600">{t('Announcement for all clients')}</p>
                  <p className="text-[11px] text-slate-400 -mt-2">
                    {t('Shown at the top of every company dashboard. Leave the title and text empty to hide it.')}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Input label={t('Announcement title')} error={errors.announcementTitle?.message} {...register('announcementTitle')} />
                    <Input label={t('Announcement link (optional)')} placeholder="https://..." error={errors.announcementUrl?.message} {...register('announcementUrl')} />
                  </div>
                  <Textarea label={t('Announcement text')} rows={2} error={errors.announcementBody?.message} {...register('announcementBody')} />
                </div>
                <div className="flex justify-end pt-3 border-t border-slate-100">
                  <Button type="submit" isLoading={isSubmitting}>
                    {t('Save')}
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </>
      )}

      <ChangePasswordModal
        open={isPasswordOpen}
        onSubmit={handleChangePassword}
        onClose={() => setIsPasswordOpen(false)}
      />

      <Modal open={mfaOpen} title={t('Two-factor authentication')} onClose={() => setMfaOpen(false)}>
        {mfaStep === 'password' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              {t('Confirm your password to start. You will need an authenticator app (Google Authenticator, Authy...).')}
            </p>
            <Input
              label={t('Current password')}
              type="password"
              value={mfaPassword}
              onChange={(e) => setMfaPassword(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="secondary" onClick={() => setMfaOpen(false)}>{t('Cancel')}</Button>
              <Button isLoading={mfaBusy} disabled={!mfaPassword} onClick={startMfaSetup}>
                {t('Continue')}
              </Button>
            </div>
          </div>
        )}
        {mfaStep === 'scan' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              {t('Scan this QR with your authenticator app, then enter the 6-digit code it shows.')}
            </p>
            {mfaQr && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={mfaQr} alt="QR" className="rounded-lg border border-line" />
              </div>
            )}
            <p className="text-center text-[10px] text-slate-400 font-mono break-all">
              {t('Manual key')}: {mfaSecret}
            </p>
            <Input
              label={t('Verification code')}
              placeholder="123456"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="secondary" onClick={() => setMfaOpen(false)}>{t('Cancel')}</Button>
              <Button isLoading={mfaBusy} disabled={mfaCode.length < 6} onClick={confirmMfaEnable}>
                {t('Activate')}
              </Button>
            </div>
          </div>
        )}
        {mfaStep === 'codes' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-600 font-semibold">
              {t('Save these recovery codes somewhere safe — each works once if you lose your phone. They will not be shown again.')}
            </p>
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 border border-line p-4 font-mono text-xs text-slate-700">
              {mfaRecovery.map((code) => (
                <span key={code}>{code}</span>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button
                variant="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(mfaRecovery.join('\n'));
                  toast.success(t('Link copied'));
                }}
              >
                {t('Copy codes')}
              </Button>
              <Button onClick={() => setMfaOpen(false)}>{t('Done')}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={mfaDisableOpen} title={t('Disable two-factor authentication')} onClose={() => setMfaDisableOpen(false)}>
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            {t('Confirm your password and a current code (or a recovery code).')}
          </p>
          <Input
            label={t('Current password')}
            type="password"
            value={mfaPassword}
            onChange={(e) => setMfaPassword(e.target.value)}
          />
          <Input
            label={t('Verification code')}
            placeholder="123456"
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="secondary" onClick={() => setMfaDisableOpen(false)}>{t('Cancel')}</Button>
            <Button
              isLoading={mfaBusy}
              disabled={!mfaPassword || !mfaCode}
              className="bg-danger hover:opacity-90"
              onClick={disableMfa}
            >
              {t('Disable')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={emailModalOpen} title={t('Change email')} onClose={() => setEmailModalOpen(false)}>
        {emailSent ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t('We sent a confirmation link to')}{' '}
              <span className="font-semibold">{emailForm.newEmail}</span>.{' '}
              {t('Your email only changes when you click it — until then, keep signing in as usual.')}
            </p>
            <div className="flex justify-end">
              <Button onClick={() => setEmailModalOpen(false)}>{t('Got it')}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              {t('We will send a confirmation link to the new address. Nothing changes until you click it, and we will notify your current email.')}
            </p>
            <Input
              label={t('New email')}
              type="email"
              placeholder="nuevo@correo.com"
              value={emailForm.newEmail}
              onChange={(e) => setEmailForm({ ...emailForm, newEmail: e.target.value })}
            />
            <Input
              label={t('Current password')}
              type="password"
              value={emailForm.currentPassword}
              onChange={(e) => setEmailForm({ ...emailForm, currentPassword: e.target.value })}
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="secondary" onClick={() => setEmailModalOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button
                isLoading={emailSending}
                disabled={!emailForm.newEmail || !emailForm.currentPassword}
                onClick={requestEmailChange}
              >
                {t('Send confirmation link')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
