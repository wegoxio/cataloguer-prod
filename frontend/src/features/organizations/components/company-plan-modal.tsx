'use client';

import React, { useEffect, useState } from 'react';
import { useT } from '../../../lib/i18n';
import { useToast } from '../../../components/ui/toast';
import { apiFetch } from '../../../lib/api-client';
import Modal from '../../../components/ui/modal';
import Select from '../../../components/ui/select';
import Button from '../../../components/ui/button';

/**
 * THE COMPANY'S PLAN, CHANGED WHERE IT LIVES (#318).
 *
 * A plan belongs to a company, never to a branch, so the platform owner
 * changes it here, on the company, through the company route. The current
 * value shown is the company's own, read from the company list, never
 * inferred from a branch. The page renders this only for the unscoped
 * platform owner, and the server refuses everyone else regardless.
 */
export interface PlanOption {
  key: string;
  name: string;
  priceUsd: number | null;
  maxWebsites?: number | null;
  maxTeamUsers?: number | null;
  complimentary?: boolean;
}

export interface PlanTarget {
  id: string;
  name: string;
  plan: string;
}

export function planLabel(plans: PlanOption[], key: string, t: (k: string) => string): string {
  const plan = plans.find((p) => p.key === key);
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

export default function CompanyPlanModal({ company, plans, accessToken, onClose, onSaved }: Props) {
  const t = useT();
  const toast = useToast();
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelected(company?.plan ?? '');
  }, [company]);

  if (!company) return null;
  const target = plans.find((p) => p.key === selected);
  const unchanged = !selected || selected === company.plan;

  const save = async () => {
    if (unchanged) return;
    setSaving(true);
    try {
      await apiFetch(`/organizations/${company.id}`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ plan: selected }),
      });
      toast.success(t('Plan updated'));
      onSaved(selected);
    } catch (err: any) {
      toast.error(err?.message || t('The plan could not be changed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title={`${t('Company plan')} — ${company.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          {t('A plan belongs to the whole company. Changing it here applies to every branch.')}
        </p>
        <p className="text-sm text-slate-700" data-testid="company-plan-current">
          {t('Current plan')}: <span className="font-semibold">{planLabel(plans, company.plan, t)}</span>
        </p>
        <Select id="company-plan-select" label={t('New plan')} value={selected} onChange={(e) => setSelected(e.target.value)}>
          {plans.map((plan) => (
            <option key={plan.key} value={plan.key}>
              {planLabel(plans, plan.key, t)}
            </option>
          ))}
        </Select>
        {target?.complimentary && (
          <ul
            className="list-disc pl-5 text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md p-3 space-y-1"
            data-testid="company-plan-gratis-notice"
          >
            <li>{t('Free')}</li>
            <li>{t('Same limits as Básico')}</li>
            <li>{t('No card subscription required')}</li>
            <li>{t('Applies to the entire company and all its branches')}</li>
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button isLoading={saving} disabled={unchanged} onClick={save} data-testid="company-plan-save">
            {t('Save plan')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
