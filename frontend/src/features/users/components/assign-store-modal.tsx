'use client';

import React, { useEffect, useState } from 'react';
import type { ManagedUser } from './user-table';
import { useT } from '../../../lib/i18n';
import Modal from '../../../components/ui/modal';
import Select from '../../../components/ui/select';
import Button from '../../../components/ui/button';
import { useAuth } from '../../../lib/auth';
import { canActOnAllowedStore, canAssignUserStore } from '../../../lib/permissions';

interface AssignStoreModalProps {
  user: ManagedUser | null;
  stores: { id: string; name: string }[];
  onSubmit: (storeId: string | null) => Promise<void> | void;
  onClose: () => void;
}

/** Bind a user to one store (scoped admin view) or open them to all. */
export default function AssignStoreModal({ user, stores, onSubmit, onClose }: AssignStoreModalProps) {
  // Platform owners are the only users allowed to belong to no store. This
  // reads the TARGET's role — a domain rule about the person being assigned,
  // not an authority check on the actor.
  const canBeUnscoped = user?.role === 'SUPER_ADMIN';
  /**
   * P5-A2 family 6 (D-6.2): the ACTOR's authority decides which branches may be
   * offered. Assignment is organization authority, and a narrowed actor may
   * assign only into the branch it selected — so the list is the scope's, not
   * whatever the parent happened to load.
   */
  const { scope } = useAuth();
  const mayAssign = canAssignUserStore(scope);
  const assignableStores = stores.filter((s) => canActOnAllowedStore(scope, s.id));
  const t = useT();
  const [storeId, setStoreId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStoreId(user?.store?.id || '');
  }, [user]);

  const submit = async () => {
    // Authority again in the handler: neither the capability nor the branch may
    // be assumed from the control having been rendered.
    if (!mayAssign) return;
    if (storeId && !canActOnAllowedStore(scope, storeId)) return;
    setBusy(true);
    try {
      await onSubmit(storeId || null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={user !== null} title={t('Store access')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          {t('A user bound to a store only sees and manages that store’s catalog.')}
        </p>
        {/* One binding, deliberately: a store role holds exactly one branch
            (multi-store administration is a Phase 9 decision, not implied here). */}
        <Select label={t('Store')} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
          {/* P0-04: only the platform owner may be unbound. For a tenant user
              "no store" used to read as "sees everything". */}
          {canBeUnscoped ? (
            <option value="">{t('All stores (unscoped)')}</option>
          ) : (
            <option value="" disabled>
              {t('Choose a store…')}
            </option>
          )}
          {assignableStores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <p className="text-[11px] text-slate-500" data-testid="store-access-preview">
          {storeId
            ? t('After this change: {email} works inside {store}, and only there.', {
                email: user?.email ?? '',
                store: assignableStores.find((s) => s.id === storeId)?.name ?? '',
              })
            : canBeUnscoped
              ? t('After this change: bound to no store — the platform owner answers to every company.')
              : t('Choose the one store this user will work inside.')}
        </p>
        <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button isLoading={busy} onClick={submit}>
            {t('Save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
