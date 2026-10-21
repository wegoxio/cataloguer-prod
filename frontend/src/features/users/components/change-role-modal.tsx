'use client';

import React, { useState } from 'react';
import Modal from '../../../components/ui/modal';
import Select from '../../../components/ui/select';
import { useT } from '../../../lib/i18n';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import type { ManagedUser } from './user-table';
import { effectiveAccessPreview, roleNeedsStore } from '../effective-access';

interface ChangeRoleModalProps {
  user: ManagedUser | null;
  assignableRoles: string[];
  onSubmit: (role: string) => Promise<void>;
  onClose: () => void;
}

export default function ChangeRoleModal({ user, assignableRoles, onSubmit, onClose }: ChangeRoleModalProps) {
  const t = useT();
  const options = assignableRoles.filter((role) => role !== user?.role);
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);

  const effectiveRole = role || options[0] || '';

  const handleSubmit = async () => {
    if (!effectiveRole) return;
    setBusy(true);
    try {
      await onSubmit(effectiveRole);
    } finally {
      setBusy(false);
      setRole('');
    }
  };

  return (
    <Modal
      open={user !== null}
      title={t('Change Role')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSubmit} isLoading={busy}>
            {t('Save Role')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          <span className="font-semibold">{user?.email}</span> currently has role{' '}
          {user && <Badge variant="info">{user.role}</Badge>}
        </p>
        <Select label={t('New Role')} value={effectiveRole} onChange={(e) => setRole(e.target.value)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
        {/* The preview is computed by the same predicates every screen gates
            on, so what it promises is what the panel will actually do. */}
        {effectiveRole && (
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-2" data-testid="role-access-preview">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">{t('After this change')}</p>
            {roleNeedsStore(effectiveRole) && !user?.store && (
              <p className="text-[11px] text-amber-700" data-testid="role-needs-store">
                {t('This role works inside one store, and this user has none yet — assign a store first.')}
              </p>
            )}
            <ul className="space-y-0.5 text-[11px]">
              {effectiveAccessPreview(effectiveRole, user?.store?.id ?? null).map((line) => (
                <li
                  key={line.label}
                  data-testid={`role-preview-${line.allowed ? 'yes' : 'no'}`}
                  className={line.allowed ? 'text-emerald-700' : 'text-slate-400'}
                >
                  <span aria-hidden="true">{line.allowed ? '✓' : '—'}</span> {t(line.label)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
