'use client';

import React from 'react';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import Badge from '../../../components/ui/badge';
import Button from '../../../components/ui/button';
import { useT } from '../../../lib/i18n';

export interface ManagedUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  role: string;
  pendingInvite: boolean;
  store: { id: string; name: string } | null;
  createdAt: string;
  deactivatedAt: string | null;
}

// Roles the actor is allowed to manage (strictly below their own level).
// MUST mirror the server's ROLE_LEVEL in users.service.ts: this table once
// omitted ORGANIZATION_MANAGER, which left the very role ADR 014 grants the
// staffing surface with no button to use it — every row read as unmanageable
// while the server would have said yes.
const ROLE_LEVEL: Record<string, number> = {
  SUPER_ADMIN: 5,
  ORGANIZATION_MANAGER: 4,
  ADMIN: 3,
  STORE_ADMIN: 3,
  EDITOR: 2,
  VIEWER: 1,
};

export function canManageTarget(actorRole: string | undefined, targetRole: string): boolean {
  return (ROLE_LEVEL[actorRole || ''] ?? 0) > (ROLE_LEVEL[targetRole] ?? 0);
}

/**
 * #275: ORGANIZATION_MANAGER and STORE_ADMIN were missing, so a row carrying
 * either fell through to the default and rendered as if it held the lowest
 * authority on the platform. A manager is the one role that spans a whole
 * company; showing it as a neutral chip understated exactly the thing an
 * operator is scanning for.
 *
 * STORE_ADMIN shares ADMIN's colour because it shares ADMIN's authority level.
 * Giving it a badge is not endorsing it — it stays unassignable (#278) — it is
 * refusing to render an existing row as something it is not.
 */
const ROLE_BADGE: Record<string, 'purple' | 'info' | 'success' | 'neutral' | 'warning'> = {
  SUPER_ADMIN: 'purple',
  ORGANIZATION_MANAGER: 'warning',
  ADMIN: 'info',
  STORE_ADMIN: 'info',
  EDITOR: 'success',
  VIEWER: 'neutral',
};

function displayName(user: ManagedUser): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || null;
}

interface UserTableProps {
  users: ManagedUser[];
  actorRole?: string;
  actorId?: string;
  onEditRole: (user: ManagedUser) => void;
  onResetPassword: (user: ManagedUser) => void;
  onResendInvite: (user: ManagedUser) => void;
  onAssignStore: (user: ManagedUser) => void;
  onDeactivate: (user: ManagedUser) => void;
  onReactivate: (user: ManagedUser) => void;
  /** #291. Absent for an actor without removal authority, so no button renders. */
}

export default function UserTable({
  users,
  actorRole,
  actorId,
  onEditRole,
  onResetPassword,
  onResendInvite,
  onAssignStore,
  onDeactivate,
  onReactivate,
}: UserTableProps) {
  const t = useT();
  if (users.length === 0) {
    return <EmptyState message={t('No users found.')} />;
  }

  const isManager = actorRole === 'SUPER_ADMIN' || actorRole === 'ORGANIZATION_MANAGER' || actorRole === 'ADMIN';

  return (
    <Table>
      <THead>
        <TH>{t('User')}</TH>
        <TH>{t('Company')}</TH>
        <TH>{t('Role')}</TH>
        <TH>{t('Status')}</TH>
        <TH>{t('Created')}</TH>
        <TH align="right">{t('Actions')}</TH>
      </THead>
      <TBody>
        {users.map((user) => {
          const isSelf = user.id === actorId;
          const manageable = !isSelf && canManageTarget(actorRole, user.role);
          const name = displayName(user);
          return (
            <TR key={user.id} className={user.deactivatedAt ? 'bg-slate-50 text-slate-400' : ''}>
              <TD>
                <div className="font-medium">
                  {name || user.email}
                  {isSelf && (
                    <span className="ml-2 text-[10px] text-slate-400 font-semibold uppercase">{t('(you)')}</span>
                  )}
                </div>
                {name && <div className="text-xs text-slate-400">{user.email}</div>}
              </TD>
              <TD className="text-sm text-slate-600">
                {user.company || '—'}
                {user.store && <div className="text-[10px] text-primary font-semibold">{user.store.name}</div>}
              </TD>
              <TD>
                <Badge variant={ROLE_BADGE[user.role] || 'neutral'}>{user.role}</Badge>
              </TD>
              <TD>
                {user.deactivatedAt ? (
                  <Badge variant="danger">{t('Deactivated')}</Badge>
                ) : user.pendingInvite ? (
                  <Badge variant="warning">{t('Invite pending')}</Badge>
                ) : (
                  <Badge variant="success">{t('Active')}</Badge>
                )}
              </TD>
              <TD className="text-xs text-slate-500">{new Date(user.createdAt).toLocaleDateString()}</TD>
              <TD align="right" className="whitespace-nowrap space-x-1">
                {manageable && !user.deactivatedAt && (
                  <>
                    <Button size="sm" variant="ghost" tooltip={t('Limit this user to one store, or open all')} onClick={() => onAssignStore(user)}>
                      {t('Store')}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-primary" tooltip={t('Change what this user is allowed to do')} onClick={() => onEditRole(user)}>
                      {t('Change Role')}
                    </Button>
                    {user.pendingInvite ? (
                      isManager && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-amber-600"
                          tooltip={t('Send the invitation email again with a fresh link')}
                          onClick={() => onResendInvite(user)}
                        >
                          {t('Resend Invite')}
                        </Button>
                      )
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-amber-600"
                        tooltip={t('Set a temporary password for this user')}
                        onClick={() => onResetPassword(user)}
                      >
                        {t('Reset Password')}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="text-danger" tooltip={t('Block access immediately (reversible)')} onClick={() => onDeactivate(user)}>
                      {t('Deactivate')}
                    </Button>
                  </>
                )}
                {/*
                  Removal sits beside Deactivate rather than replacing it: they
                  are different decisions. Deactivating blocks access and the
                  company can undo it; removing takes the person out of the
                  company entirely and only the platform owner can undo that.
                */}
                {manageable && user.deactivatedAt && (
                  <Button size="sm" variant="secondary" tooltip={t("Restore this user's access")} onClick={() => onReactivate(user)}>
                    {t('Reactivate')}
                  </Button>
                )}
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
