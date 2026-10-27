'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Mail, ShieldCheck } from 'lucide-react';
import { useT } from '../../../lib/i18n';
import { useToast } from '../../../components/ui/toast';
import { apiFetch } from '../../../lib/api-client';
import Modal from '../../../components/ui/modal';
import Select from '../../../components/ui/select';
import Input from '../../../components/ui/input';
import Button from '../../../components/ui/button';

export interface PlanOption {
  key: string;
  name: string;
  priceUsd: number | null;
  maxWebsites?: number | null;
  maxTeamUsers?: number | null;
  complimentary?: boolean;
}
export interface PlanTarget { id: string; name: string; plan: string }

export function planLabel(plans: PlanOption[], key: string, t: (key: string) => string): string {
  const plan = plans.find((item) => item.key === key);
  if (!plan) return key;
  if (plan.complimentary) return `${plan.name} — ${t('Free')}`;
  return plan.priceUsd === null ? `${plan.name} — ${t('Custom pricing')}` : `${plan.name} — $${plan.priceUsd}/${t('month')}`;
}

interface Props {
  company: PlanTarget | null;
  plans: PlanOption[];
  accessToken: string;
  onClose: () => void;
  onSaved: (plan: string) => void;
}
type Step = 'select' | 'confirm' | 'verify';

export default function CompanyPlanModal({ company, plans, accessToken, onClose, onSaved }: Props) {
  const t = useT();
  const toast = useToast();
  const [selected, setSelected] = useState('');
  const [step, setStep] = useState<Step>('select');
  const [challenge, setChallenge] = useState<{ id: string; email: string; expiresAt: string } | null>(null);
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelected(company?.plan ?? '');
    setStep('select');
    setChallenge(null);
    setCode('');
  }, [company]);

  if (!company) return null;
  const target = plans.find((item) => item.key === selected);
  const unchanged = !selected || selected === company.plan;

  const requestCode = async () => {
    setSaving(true);
    try {
      const response = await apiFetch(`/organizations/${company.id}/plan-change/challenges`, {
        method: 'POST', token: accessToken, body: JSON.stringify({ plan: selected }),
      });
      setChallenge({ id: response.data.challengeId, email: response.data.email, expiresAt: response.data.expiresAt });
      setStep('verify');
      toast.success(t('Verification code sent'));
    } catch (error: any) {
      toast.error(error?.message || t('The verification code could not be sent.'));
    } finally { setSaving(false); }
  };

  const confirmChange = async () => {
    if (!challenge || !/^\d{6}$/.test(code)) return;
    setSaving(true);
    try {
      await apiFetch(`/organizations/${company.id}/plan-change/confirm`, {
        method: 'POST', token: accessToken, body: JSON.stringify({ challengeId: challenge.id, code }),
      });
      toast.success(t('Plan updated'));
      onSaved(selected);
    } catch (error: any) {
      toast.error(error?.message || t('The plan could not be changed.'));
    } finally { setSaving(false); }
  };

  return <Modal open title={`${t('Company plan')} — ${company.name}`} onClose={onClose}>
    <div className="space-y-5">
      {step === 'select' && <>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-950">
          <p className="font-semibold">{t('A plan applies to the entire company')}</p>
          <p className="mt-1 text-xs text-blue-800">{t('Its limits and capabilities affect every branch and administrator.')}</p>
        </div>
        <p className="text-sm text-slate-700" data-testid="company-plan-current">
          {t('Current plan')}: <span className="font-semibold">{planLabel(plans, company.plan, t)}</span>
        </p>
        <Select id="company-plan-select" label={t('New plan')} value={selected} onChange={(event) => setSelected(event.target.value)}>
          {plans.map((plan) => <option key={plan.key} value={plan.key}>{planLabel(plans, plan.key, t)}</option>)}
        </Select>
        {target && <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
          <div><span className="block text-slate-400">{t('Websites')}</span><strong>{target.maxWebsites ?? '∞'}</strong></div>
          <div><span className="block text-slate-400">{t('Team users')}</span><strong>{target.maxTeamUsers ?? '∞'}</strong></div>
        </div>}
        {target?.complimentary && <ul data-testid="company-plan-gratis-notice" className="list-disc space-y-1 rounded-xl border border-emerald-200 bg-emerald-50 p-4 pl-8 text-xs text-emerald-900">
          <li>{t('Free')}</li><li>{t('Same limits as Básico')}</li><li>{t('No card subscription required')}</li><li>{t('Applies to the entire company and all its branches')}</li>
        </ul>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
          <Button disabled={unchanged} onClick={() => setStep('confirm')} data-testid="company-plan-save">{t('Continue')}</Button>
        </div>
      </>}

      {step === 'confirm' && <>
        <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-950">
            <p className="font-semibold">{t('Confirm this sensitive change')}</p>
            <p className="mt-1 text-xs">{company.name}: {planLabel(plans, company.plan, t)} → {planLabel(plans, selected, t)}</p>
            <p className="mt-2 text-xs">{t('We will send a single-use 6-digit code to your administrator email. It expires in 10 minutes.')}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="secondary" onClick={() => setStep('select')}>{t('Back')}</Button>
          <Button isLoading={saving} onClick={requestCode} data-testid="company-plan-send-code"><Mail className="h-4 w-4" /> {t('Send verification code')}</Button>
        </div>
      </>}

      {step === 'verify' && challenge && <>
        <div className="flex gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" />
          <div className="text-sm text-emerald-950">
            <p className="font-semibold">{t('Check your email')}</p>
            <p className="mt-1 text-xs">{t('The code was sent to')} {challenge.email}. {t('It expires at')} {new Date(challenge.expiresAt).toLocaleTimeString()}.</p>
          </div>
        </div>
        <Input id="plan-change-code" label={t('6-digit verification code')} value={code} inputMode="numeric"
          autoComplete="one-time-code" maxLength={6} placeholder="000000"
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} />
        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
          <Button isLoading={saving} disabled={!/^\d{6}$/.test(code)} onClick={confirmChange} data-testid="company-plan-confirm">
            <CheckCircle2 className="h-4 w-4" /> {t('Confirm plan change')}
          </Button>
        </div>
      </>}
    </div>
  </Modal>;
}
