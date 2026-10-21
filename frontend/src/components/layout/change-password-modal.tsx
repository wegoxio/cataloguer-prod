'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Modal from '../ui/modal';
import Input from '../ui/input';
import Button from '../ui/button';
import { useT } from '../../lib/i18n';
import { isStrongPassword, PASSWORD_POLICY_HINT } from '../../lib/password';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().refine(isStrongPassword, PASSWORD_POLICY_HINT),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type FormValues = z.infer<typeof schema>;

interface ChangePasswordModalProps {
  open: boolean;
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
  onClose: () => void;
}

export default function ChangePasswordModal({ open, onSubmit, onClose }: ChangePasswordModalProps) {
  const t = useT();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Modal open={open} title={t('Change Password')} onClose={handleClose}>
      <form
        onSubmit={handleSubmit(async (values) => {
          await onSubmit(values.currentPassword, values.newPassword);
          reset();
        })}
        className="space-y-4"
      >
        <Input
          type="password"
          label={t('Current Password')}
          error={errors.currentPassword?.message}
          {...register('currentPassword')}
        />
        <Input
          type="password"
          label={t('New Password')}
          placeholder={t(PASSWORD_POLICY_HINT)}
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />
        <Input
          type="password"
          label={t('Confirm New Password')}
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />
        <p className="text-xs text-slate-500">
          Any other device or browser where you are signed in will be logged out.
        </p>
        <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
          <Button type="button" variant="secondary" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            Change Password
          </Button>
        </div>
      </form>
    </Modal>
  );
}
