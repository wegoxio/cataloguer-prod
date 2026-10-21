'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../../../lib/auth';
import { useT } from '../../../../lib/i18n';

/**
 * The suggestions route, kept working and no longer a second workflow.
 *
 * It used to own its own grouping: its own list, its own one-click "Group
 * them" straight to the create endpoint, no preflight and no preview — while
 * Items had all of those. Two implementations of one act drift, and they did.
 *
 * Suggestions are DISCOVERY (ADR 018), and discovery belongs where the items
 * are. So this route redirects into the Items suggestion-review state rather
 * than rendering a second copy: the link keeps working, and there is exactly
 * one place where a suggestion is reviewed.
 */
export default function FamilySuggestionsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const t = useT();

  React.useEffect(() => {
    router.replace('/dashboard/products?suggestions=open');
  }, [router]);

  if (!user) return null;

  // Shown only for the instant before the replace lands, and if a browser ever
  // refuses it this is a working page rather than a blank one.
  return (
    <div className="space-y-6" data-testid="groups-redirect">
      <Link
        href="/dashboard/products?suggestions=open"
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> {t('Back to items')}
      </Link>
      <p className="text-sm text-slate-500">{t('Possible parent products now live with your items. Taking you there…')}</p>
    </div>
  );
}
