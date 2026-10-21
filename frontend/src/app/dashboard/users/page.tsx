'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../lib/auth';
import { canAssignUserStore, canManageTeam } from '../../../lib/permissions';
import AccessDenied from '../../../components/layout/access-denied';
import { apiFetch } from '../../../lib/api-client';
import { useDebouncedValue } from '../../../lib/use-debounced-value';
import { useToast } from '../../../components/ui/toast';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import Checkbox from '../../../components/ui/checkbox';
import Modal from '../../../components/ui/modal';
import ConfirmModal from '../../../components/ui/confirm-modal';
import UserTable, { ManagedUser, canManageTarget } from '../../../features/users/components/user-table';
import UserForm, { InviteUserFormValues } from '../../../features/users/components/user-form';
import ChangeRoleModal from '../../../features/users/components/change-role-modal';
import ResetPasswordModal from '../../../features/users/components/reset-password-modal';
import AssignStoreModal from '../../../features/users/components/assign-store-modal';
import { useStores } from '../../../lib/use-website-config';
import { useT } from '../../../lib/i18n';
import { tenantQueryIdentity, useTeamUsers } from '../../../lib/domain-queries';
import { queryKeys } from '../../../lib/query-client';

const ALL_ROLES = ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER'];

export default function UsersPage() {
  const { user, scope, accessToken, refreshScope } = useAuth();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<ManagedUser | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<ManagedUser | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<ManagedUser | null>(null);
  const [storeTarget, setStoreTarget] = useState<ManagedUser | null>(null);
  const { stores } = useStores();
  const activeStores = stores.filter((s) => !s.archivedAt);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [page, setPage] = useState(1);

  // P5-A2 family 6: staffing authority comes from the resolved scope. The role
  // guess excluded the ORGANIZATION_MANAGER that ADR 014 grants the whole
  // staffing surface of its own company.
  const isAdmin = canManageTeam(scope);
  const mayAssignStore = canAssignUserStore(scope);
  const assignableRoles = ALL_ROLES.filter((role) => canManageTarget(user?.role, role));

  const listFilters = useMemo(() => ({ search: debouncedSearch, includeDeactivated: showDeactivated, page, limit: 25 }), [debouncedSearch, showDeactivated, page]);
  const usersQuery = useTeamUsers(accessToken, scope?.organizationId, scope?.storeId, listFilters, isAdmin);
  const users = usersQuery.data?.items ?? [];
  const totalPages = usersQuery.data?.totalPages ?? 1;
  const loading = usersQuery.isPending;
  const error = usersQuery.error instanceof Error ? usersQuery.error.message : usersQuery.error ? 'Failed to retrieve users' : null;
  const identity = tenantQueryIdentity(scope?.organizationId, scope?.storeId);
  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: queryKeys.usersRoot(identity) });

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, showDeactivated]);

  const handleCreate = async (values: InviteUserFormValues) => {
    if (!accessToken) return;
    try {
      await apiFetch('/users', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          ...values,
          firstName: values.firstName || undefined,
          lastName: values.lastName || undefined,
          storeId: values.storeId || undefined,
        }),
      });
      toast.success(`Invitation sent to ${values.email}`);
      setIsCreateOpen(false);
      await refreshUsers();
    } catch (err: any) {
      toast.error(err.message || 'Failed to send invitation');
    }
  };

  const handleAssignStore = async (storeId: string | null) => {
    if (!accessToken || !storeTarget) return;
    try {
      await apiFetch(`/users/${storeTarget.id}/store`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ storeId }),
      });
      toast.success(t('Store access updated'));
      setStoreTarget(null);
      await refreshUsers();
      // The change is already effective server-side; re-ask /auth/me so the
      // panel this session renders agrees with it immediately.
      refreshScope();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update store access');
    }
  };

  const handleResendInvite = async (target: ManagedUser) => {
    if (!accessToken) return;
    try {
      await apiFetch(`/users/${target.id}/resend-invite`, { method: 'POST', token: accessToken });
      toast.success(`Invitation re-sent to ${target.email}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to resend invitation');
    }
  };

  const handleRoleChange = async (role: string) => {
    if (!accessToken || !roleTarget) return;
    try {
      await apiFetch(`/users/${roleTarget.id}/role`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ role }),
      });
      toast.success(`${roleTarget.email} is now ${role}`);
      setRoleTarget(null);
      await refreshUsers();
      refreshScope();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update role');
    }
  };

  const handlePasswordReset = async (password: string) => {
    if (!accessToken || !passwordTarget) return;
    try {
      await apiFetch(`/users/${passwordTarget.id}/password`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ password }),
      });
      toast.success(`Password updated for ${passwordTarget.email}. Share it through a secure channel.`);
      setPasswordTarget(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to reset password');
    }
  };

  const handleDeactivate = async () => {
    if (!accessToken || !deactivateTarget) return;
    try {
      await apiFetch(`/users/${deactivateTarget.id}/deactivate`, {
        method: 'PATCH',
        token: accessToken,
      });
      toast.success(`${deactivateTarget.email} deactivated`);
      setDeactivateTarget(null);
      await refreshUsers();
    } catch (err: any) {
      toast.error(err.message || 'Failed to deactivate user');
      setDeactivateTarget(null);
    }
  };

  /**
   * REMOVE, and then say what actually happened.
   *
   * The backend answers `changed: false` when the person was already removed —
   * a repeat, a double click, a retried request. Reporting that as a fresh
   * removal would tell the operator they did something they did not, so the two
   * outcomes get two different sentences.
   */

  const handleReactivate = async (target: ManagedUser) => {
    if (!accessToken) return;
    try {
      await apiFetch(`/users/${target.id}/reactivate`, { method: 'PATCH', token: accessToken });
      toast.success(`${target.email} reactivated`);
      await refreshUsers();
    } catch (err: any) {
      toast.error(err.message || 'Failed to reactivate user');
    }
  };

  if (!user) return null;
  // A stated refusal, not a silent bounce to the dashboard: the actor typed or
  // followed this address, and deserves to know what stands here and who can
  // open it — exactly the contract AccessDenied exists for.
  if (!isAdmin) {
    return (
      <AccessDenied
        title={t('Team management is not part of your access')}
        reason={t('Inviting people and changing roles or store access is reserved for company administrators.')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Users')}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {t('Manage who can access the platform and what they are allowed to do')}
          </p>
        </div>
        {mayAssignStore && (
          <Button tooltip={t('Send an email invitation to a new user')} onClick={() => setIsCreateOpen(true)}>{t('Invite User')}</Button>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">{error}</div>
      )}

      <div className="p-4 bg-slate-50 border border-slate-200 rounded-md flex flex-wrap gap-4 items-end">
        <Input
          label={t('Search Users')}
          placeholder={t('Search by email...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px]"
        />
        <div className="flex items-center h-[32px]">
          <Checkbox
            label={t('Show Deactivated')}
            checked={showDeactivated}
            onChange={(e) => setShowDeactivated(e.target.checked)}
          />
        </div>
      </div>

      {loading ? (
        <div className="text-slate-500 text-sm">{t('Fetching users...')}</div>
      ) : (
        <div className="space-y-4">
          <UserTable
            users={users}
            actorRole={user.role}
            actorId={user.id}
            onEditRole={setRoleTarget}
            onResetPassword={setPasswordTarget}
            onResendInvite={handleResendInvite}
            onAssignStore={setStoreTarget}
            onDeactivate={setDeactivateTarget}
            onReactivate={handleReactivate}
          />

          {totalPages > 1 && (
            <div className="flex justify-between items-center bg-slate-50 p-4 border border-slate-200 rounded-md">
              <div className="text-xs text-slate-500 font-semibold">
                {t('Page {page} of {totalPages}', { page, totalPages })}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  {t('Previous')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  {t('Next')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Modal open={isCreateOpen} title={t('Invite User')} onClose={() => setIsCreateOpen(false)}>
        <UserForm
          hideCompany={!!user?.store}
          assignableRoles={assignableRoles}
          stores={user.store ? [] : activeStores}
          onSubmit={handleCreate}
          onCancel={() => setIsCreateOpen(false)}
        />
      </Modal>

      <AssignStoreModal
        user={storeTarget}
        stores={activeStores}
        onSubmit={handleAssignStore}
        onClose={() => setStoreTarget(null)}
      />

      <ChangeRoleModal
        user={roleTarget}
        assignableRoles={assignableRoles}
        onSubmit={handleRoleChange}
        onClose={() => setRoleTarget(null)}
      />

      <ResetPasswordModal
        user={passwordTarget}
        onSubmit={handlePasswordReset}
        onClose={() => setPasswordTarget(null)}
      />


      <ConfirmModal
        open={deactivateTarget !== null}
        title={t('Deactivate User')}
        message={
          <>
            {t('Deactivate')} <span className="font-semibold">{deactivateTarget?.email}</span>? {t('They will be logged out immediately and unable to log in until reactivated.')}
          </>
        }
        confirmLabel={t('Deactivate')}
        danger
        onConfirm={handleDeactivate}
        onCancel={() => setDeactivateTarget(null)}
      />
    </div>
  );
}
