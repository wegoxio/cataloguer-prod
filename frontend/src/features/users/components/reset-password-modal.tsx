'use client';

import React, { useState } from 'react';
import Modal from '../../../components/ui/modal';
import Input from '../../../components/ui/input';
import { useT } from '../../../lib/i18n';
import { isStrongPassword, PASSWORD_POLICY_HINT } from '../../../lib/password';
import Button from '../../../components/ui/button';
import type { ManagedUser } from './user-table';

interface ResetPasswordModalProps {
  user: ManagedUser | null;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}

export default function ResetPasswordModal({ user, onSubmit, onClose }: ResetPasswordModalProps) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleClose = () => {
    setPassword('');
    setError(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!isStrongPassword(password)) {
      setError(t(PASSWORD_POLICY_HINT));
      return;
    }
    setBusy(true);
    try {
      await onSubmit(password);
      setPassword('');
      setError(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      title={t('Reset Password')}
      onClose={handleClose}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSubmit} isLoading={busy}>
            Set Password
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Set a new temporary password for <span className="font-semibold">{user?.email}</span>. All
          their active sessions will be logged out immediately.
        </p>
        <Input
          type="text"
          label={t('New Temporary Password')}
          placeholder={t(PASSWORD_POLICY_HINT)}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          error={error ?? undefined}
        />
      </div>
    </Modal>
  );
}
