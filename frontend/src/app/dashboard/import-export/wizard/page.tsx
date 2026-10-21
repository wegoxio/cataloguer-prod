'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import PageHeader from '../../../../components/layout/page-header';
import { decodeWizardLocation } from '../../../../features/import-export/wizard/mapping/wizard-location';
import { useAuth } from '../../../../lib/auth';
import { useManagedTenant } from '../../../../lib/managed-tenant';
import { canRunCatalogueImport } from '../../../../lib/permissions';
import { useT } from '../../../../lib/i18n';

const Phase9ImportWizard = dynamic(
  () => import('../../../../features/import-export/wizard/phase9/import-wizard').then((module) => module.Phase9ImportWizard),
  { loading: () => <div className="text-sm text-slate-500">Loading importer…</div> },
);

/**
 * The wizard's route.
 *
 * It carries the page chrome, decodes the link, and decides what the caller is
 * shown. Everything else belongs to the wizard.
 *
 * The permission branch reuses `canRunCatalogueImport`, the same predicate the
 * import page and the history list use, so there is one answer to "may this
 * actor import" rather than three that can drift. It decides what to RENDER;
 * the backend refuses regardless and remains the only thing that decides what
 * is permitted.
 *
 * This route previously rendered the Phase 8 rehearsal, which drew every number
 * from a fixture in the bundle and issued no request. It now renders the real
 * wizard.
 */
export default function ImportWizardPage() {
  const t = useT();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { accessToken, scope } = useAuth();
  // The branch in context, and the names to show it by. The store id comes
  // from the RESOLVED scope — the server's answer — while storage supplies
  // only the labels.
  const managed = useManagedTenant();

  const location = decodeWizardLocation(searchParams?.toString() ?? '');
  const mayImport = canRunCatalogueImport(scope);

  return (
    <>
      <PageHeader
        title={t('Import')}
        description={t('Map a spreadsheet to your catalogue. Nothing is changed until you approve a plan.')}
        crumbs={[{ label: t('Import and export'), href: '/dashboard/import-export' }, { label: t('Import') }]}
      />
      <Phase9ImportWizard
        availability={mayImport ? 'ALLOWED' : 'FORBIDDEN'}
        token={accessToken ?? ''}
        location={location}
        // Until a source has been registered there is nothing to open, and the
        // wizard invites a fresh start rather than showing an empty editor.
        sourceStatus={location.sourceId ? 'AVAILABLE' : 'NONE'}
        storeId={scope?.storeId ?? undefined}
        organizationName={managed?.organizationName ?? null}
        storeName={scope?.storeId ? managed?.storeName ?? null : null}
        navigate={(href) => router.push(href)}
      />
    </>
  );
}
