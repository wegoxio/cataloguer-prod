'use client';

import React from 'react';
import Link from 'next/link';
import { Download, Wand2 } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { DraftImports } from '../../../features/import-export/draft-imports';
import { canExportCatalogue, canRunCatalogueImport } from '../../../lib/permissions';
import { apiDownload, saveBlob } from '../../../lib/api-client';
import { useT } from '../../../lib/i18n';
import { useToast } from '../../../components/ui/toast';
import Button from '../../../components/ui/button';
import { IMPORT_WIZARD_PATH } from '../../../features/import-export/wizard-route';

/**
 * Import / Export.
 *
 * Importing lives entirely in the wizard now, and this screen's job is to send
 * people there. It used to carry a second, complete importer of its own — file
 * → column mapping → "Confirm import" → `POST /import/commit`, which wrote to
 * the catalogue directly. That was a mutation path around planning and
 * approval: no durable plan, no single-use approval proof, no execution record
 * and no per-row report. It was also the only visible import action, so the
 * safe flow was unreachable without typing its URL.
 *
 * Both halves are gone. The route is retired server-side (410), and the only
 * import action here opens the wizard.
 *
 * Export stays: it is read-only, so a branch ADMIN keeps it even though
 * importing is organization-level authority.
 */
export default function ImportExportPage() {
  const t = useT();
  const { user, scope, accessToken } = useAuth();
  const toast = useToast();

  /**
   * P5-A2 family 4 (D-4.3). Two DIFFERENT authorities share this screen:
   *
   *   mayImport . the import workflow — SUPER_ADMIN and the ORGANIZATION_MANAGER
   *   mayExport . read-only download — ADMIN keeps it, the manager gains it
   *
   * EDITOR and VIEWER hold neither, and the screen refuses them outright.
   */
  const mayImport = canRunCatalogueImport(scope);
  const mayExport = canExportCatalogue(scope);
  const mayUseScreen = mayImport || mayExport;

  if (!user) return null;

  const handleExport = async (exportType: 'categories' | 'products') => {
    if (!accessToken || !mayExport) return;
    try {
      // #201: the download shares the authenticated path — bearer token,
      // tenant headers, one refresh on 401 and the same readable errors.
      const blob = await apiDownload(`/export/${exportType}`, { token: accessToken });
      saveBlob(blob, `${exportType}.csv`);
    } catch (err: any) {
      toast.error(err.message || 'Export failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Import / Export')}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {t('Bring any CSV into your catalog — you approve what was read before it imports')}
          </p>
        </div>
        {/*
          The history link is gone, not repointed.

          It led to a separate page promising "every import that ran". That page
          is now a redirect back to here, so a link from this page to itself
          would be a loop dressed as navigation. Import activity below IS the
          history: every import, and what each run did.
        */}
      </div>

      {!mayUseScreen && (
        <div className="p-4 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-md">
          <strong>{t('Access Restricted:')}</strong>{' '}
          {t('You do not have permissions to import or export catalog data. Only administrators can perform these operations.')}
        </div>
      )}

        {/* Where `Save and exit` comes back to. Above the start button,
            because somebody returning to finish a file should not have to read
            past an invitation to upload it again. */}
        {mayImport && accessToken ? <DraftImports token={accessToken} /> : null}

      {/* Smart import is ALWAYS shown, and disabled when the reader's role
          cannot use it. Hiding it made "your role cannot do this" look
          identical to "this feature is gone", which is the confusion this
          screen caused. The authorization boundary is UNCHANGED: the button is
          inert, direct navigation to the wizard is still refused, and the
          backend still refuses the request. */}
      {/* Gated on access to the SCREEN, not on `mayImport`: a role refused the
          screen outright (VIEWER) still sees nothing, while a role that belongs
          here but cannot import sees the feature and why it is unavailable. */}
      {mayUseScreen && (
      <div className="card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Wand2 className={mayImport ? 'h-4 w-4 text-primary' : 'h-4 w-4 text-slate-400'} />
          <h3 className="text-sm font-bold text-slate-800">{t('Smart import')}</h3>
        </div>
        <p className="text-xs text-slate-500">
          {t('Upload your file, check what we read, and approve it before anything is written.')}
        </p>
        {mayImport ? (
          /* A plain link, not a router push: it deep-links, middle-clicks and
             opens in a new tab like any other navigation, and the branch in
             context is held outside the URL so it survives the move. */
          <Link href={IMPORT_WIZARD_PATH} className="inline-block">
            <Button data-testid="start-import">{t('Start an import')}</Button>
          </Link>
        ) : (
          <>
            {/* No link at all — a disabled anchor is still focusable and still
                navigable by keyboard. The explanation is bound with
                `aria-describedby`, so it reaches a screen reader rather than
                living only in a tooltip a pointer must hover. */}
            <Button
              data-testid="start-import"
              disabled
              aria-describedby="smart-import-denied"
              tooltip={t('Only a company manager can run an import.')}
            >
              {t('Start an import')}
            </Button>
            <p id="smart-import-denied" className="text-xs text-slate-500" data-testid="smart-import-denied">
              {t('Only a company manager can run an import. Ask one to run it, or to change your role.')}
            </p>
          </>
        )}
      </div>
      )}

      {/* Export lives OUTSIDE the import workflow: it is read-only, so a branch
          admin keeps it even though importing is organization-only. */}
      {mayExport && (
        <div className="card p-5 space-y-3">
          <h3 className="text-sm font-bold text-slate-800">{t('Export Tools')}</h3>
          <div className="flex gap-3">
            <Button
              variant="secondary"
              tooltip={t('Download all categories as a CSV file')}
              onClick={() => handleExport('categories')}
            >
              <Download className="h-3.5 w-3.5" /> {t('Categories')}
            </Button>
            <Button
              variant="secondary"
              tooltip={t('Download all products as a CSV file')}
              onClick={() => handleExport('products')}
            >
              <Download className="h-3.5 w-3.5" /> {t('Products')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
