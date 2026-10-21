'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Button from '../../../components/ui/button';
import { useT } from '../../../lib/i18n';
import NoActiveStores from '../../website/components/no-active-stores';

const inviteUserSchema = z.object({
  email: z.string().email('Must be a valid email'),
  company: z.string().max(120).optional(),
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
  role: z.string().min(1, 'Role is required'),
  storeId: z.string().optional(),
});

export type InviteUserFormValues = z.infer<typeof inviteUserSchema>;

interface UserFormProps {
  assignableRoles: string[];
  stores: { id: string; name: string }[];
  onSubmit: (values: InviteUserFormValues) => Promise<void> | void;
  onCancel: () => void;
  /** Store-bound admins invite into their own company — the field is implicit */
  hideCompany?: boolean;
}

export default function UserForm({ assignableRoles, stores, onSubmit, onCancel, hideCompany }: UserFormProps) {
  const t = useT();
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<InviteUserFormValues>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: {
      email: '',
      company: '',
      firstName: '',
      lastName: '',
      role: assignableRoles[assignableRoles.length - 1] || '',
      storeId: '',
    },
  });

  // Drives whether "All stores (unscoped)" is offered (P0-04)
  const selectedRole = watch('role');

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        type="email"
        label={t('Email')}
        placeholder="user@company.com"
        error={errors.email?.message}
        {...register('email')}
      />
      {!hideCompany && (
        <Input
          type="text"
          label={t('Company')}
          placeholder={t('Company or client name')}
          error={errors.company?.message}
          {...register('company')}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        <Input
          type="text"
          label={t('First Name (optional)')}
          error={errors.firstName?.message}
          {...register('firstName')}
        />
        <Input
          type="text"
          label={t('Last Name (optional)')}
          error={errors.lastName?.message}
          {...register('lastName')}
        />
      </div>
      {stores.length > 0 && (
      <Select
        label={selectedRole === 'SUPER_ADMIN' ? t('Store (optional)') : t('Store')}
        error={errors.storeId?.message}
        {...register('storeId')}
      >
        {/* P0-04: a tenant user with no store behaved as if global */}
        {selectedRole === 'SUPER_ADMIN' ? (
          <option value="">{t('All stores (unscoped)')}</option>
        ) : (
          <option value="" disabled>
            {t('Choose a store…')}
          </option>
        )}
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      )}
      {stores.length > 0 && (
      <p className="text-xs text-slate-500 -mt-2">
        {t('A user bound to a store only sees and manages that store’s catalog.')}
      </p>
      )}
      {/* #293: a company may hold zero active branches. The selector used to
          simply vanish, which reads as "this does not apply" — and then the
          server refused the submission with "ADMIN must belong to a store", a
          rule the form had never mentioned. Every branch-level role needs a
          branch, so the state is named here instead. */}
      {stores.length === 0 && <NoActiveStores what={t('Placing someone in a branch')} />}
      <Select label={t('Role')} error={errors.role?.message} {...register('role')}>
        {assignableRoles.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </Select>
      <p className="text-xs text-slate-500">
        {t("They'll receive an invitation email with a link to choose their own password. The link expires in 7 days — you can resend it from the user list if needed.")}
      </p>
      <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {t('Send Invitation')}
        </Button>
      </div>
    </form>
  );
}
