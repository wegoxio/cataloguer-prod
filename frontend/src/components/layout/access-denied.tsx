'use client';

import React from 'react';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { useT } from '../../lib/i18n';

/**
 * The single answer to "you may not see this".
 *
 * Three different things used to happen instead: some screens blocked with a
 * banner, some redirected to the dashboard, and some simply rendered their
 * controls away — leaving an EMPTY CATALOGUE that reads as "this company has no
 * products" when it actually means "you cannot read them". That is the worst of
 * the three, because it is indistinguishable from real data.
 *
 * This states the fact plainly and says who can change it, without naming what
 * is behind the wall (that would leak the very thing the guard withholds).
 */
export default function AccessDenied({
  title,
  reason,
  contact = true,
}: {
  title?: string;
  /** What is not available, in the user's terms. Never the missing role name. */
  reason?: string;
  contact?: boolean;
}) {
  const t = useT();
  return (
    <div
      role="status"
      data-testid="access-denied"
      className="max-w-lg mx-auto my-10 p-6 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 space-y-3"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
        <h2 className="text-sm font-bold">{title ?? t('You do not have access to this section')}</h2>
      </div>
      <p className="text-xs leading-relaxed">
        {reason ?? t('Your account does not include this area. Nothing is missing from your company — it is simply not part of what you can open.')}
      </p>
      {contact && (
        <p className="text-xs leading-relaxed">
          {t('If you need it, ask an administrator of your company to review your access.')}
        </p>
      )}
      <Link href="/dashboard" className="inline-block text-xs font-semibold text-amber-900 underline hover:no-underline">
        {t('Back to the dashboard')}
      </Link>
    </div>
  );
}

/**
 * The other empty-looking state: an actor whose session names no company.
 *
 * A platform owner outside "manage company" mode has no organization, so a
 * catalogue query answers with nothing. Rendering that as an empty list says
 * "this company has no products" about a company that was never chosen — the
 * same lie as hiding a permission failure behind an empty table.
 */
export function NoOrganizationContext({ what }: { what?: string }) {
  const t = useT();
  return (
    <div
      role="status"
      data-testid="no-organization-context"
      className="max-w-lg mx-auto my-10 p-6 rounded-xl border border-slate-200 bg-slate-50 text-slate-700 space-y-3"
    >
      <h2 className="text-sm font-bold">{t('Choose a company first')}</h2>
      <p className="text-xs leading-relaxed">
        {what
          ? t('{what} belongs to a company, and this session is not inside one yet.', { what })
          : t('This section belongs to a company, and this session is not inside one yet.')}{' '}
        {t('Open a client from the Clients page to work inside it.')}
      </p>
      <Link
        href="/dashboard/clients"
        className="inline-block text-xs font-semibold text-primary underline hover:no-underline"
      >
        {t('Go to Clients')}
      </Link>
    </div>
  );
}
