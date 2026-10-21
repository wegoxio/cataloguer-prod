'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Store as StoreIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { apiFetch } from '../../../lib/api-client';
import type { StoreRecord } from '../../../lib/use-website-config';
import { useToast } from '../../../components/ui/toast';
import { useAuth } from '../../../lib/auth';
import { isUnscopedPlatformOwner } from '../../../lib/permissions';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Input from '../../../components/ui/input';
import Modal from '../../../components/ui/modal';
import ConfirmModal from '../../../components/ui/confirm-modal';
import NoActiveStores from './no-active-stores';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import { useT } from '../../../lib/i18n';

const storeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  websiteUrl: z
    .string()
    .max(300)
    .refine((v) => v === '' || /^https?:\/\//.test(v), 'Must start with http:// or https://')
    .optional(),
  websiteProductPath: z
    .string()
    .max(200)
    .refine((v) => v === '' || v.includes('{slug}'), 'Must contain {slug}')
    .optional(),
  websiteCategoryPath: z
    .string()
    .max(200)
    .refine((v) => v === '' || v.includes('{slug}'), 'Must contain {slug}')
    .optional(),
});

type StoreFormValues = z.infer<typeof storeSchema>;

interface StoresCardProps {
  stores: StoreRecord[];
  /** Adding a branch — an organization-level act, impossible from inside one. */
  canCreate: boolean;
  /** Per branch: renaming, archiving, restoring. A narrowed actor holds it for
   *  its selected branch only, so this is asked per row rather than once. */
  canManageStore: (storeId: string) => boolean;
  accessToken: string;
  onChanged: () => void;
}

export default function StoresCard({
  stores,
  canCreate,
  canManageStore,
  accessToken,
  onChanged,
}: StoresCardProps) {
  const t = useT();
  const { scope } = useAuth();
  const isPlatformOwner = isUnscopedPlatformOwner(scope);
  // Any row actionable at all decides whether the Actions column is drawn.
  const canManageAnyStore = stores.some((store) => canManageStore(store.id));
  const toast = useToast();
  const [editing, setEditing] = useState<StoreRecord | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<StoreRecord | null>(null);

  /**
   * REMOVAL (#293), through the same conversation items and categories use.
   *
   * Not a second confirmation dialog with its own wording: the shape is
   * identical — fetch the advisory preview, show what removal would do, show
   * every reason it cannot when there is one, and replace those with the
   * server's own reasons if it refuses a removal the preview allowed.
   */

  /**
   * WHO SEES "REMOVE", and why it is a stricter question than "Archive".
   *
   * `canManageStore` admits an unscoped platform owner and a narrowed actor for
   * its own branch, which is right for archiving. Removal is a tenant act and
   * the server refuses both — see `canRemoveStore` in `lib/permissions`, which
   * mirrors `StoreRemovalService.assertMayRemove` line for line. Offering a
   * button that always 403s would be worse than not offering it.
   */

  /**
   * A refusal is already inside the dialog — the hook put the server's blockers
   * there — so only the two OTHER outcomes need a toast: success, and a failure
   * that was not a refusal at all. The same split the Items and Categories
   * pages make.
   */

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<StoreFormValues>({ resolver: zodResolver(storeSchema) });

  const openCreate = () => {
    setEditing(null);
    reset({ name: '', websiteUrl: '', websiteProductPath: '/products/{slug}', websiteCategoryPath: '/categories/{slug}' });
    setIsFormOpen(true);
  };

  const openEdit = (store: StoreRecord) => {
    setEditing(store);
    reset({
      name: store.name,
      websiteUrl: store.websiteUrl || '',
      websiteProductPath: store.websiteProductPath || '/products/{slug}',
      websiteCategoryPath: store.websiteCategoryPath || '/categories/{slug}',
    });
    setIsFormOpen(true);
  };

  const onSubmit = async (values: StoreFormValues) => {
    // P5-W5: a NEW store must NAME its company. `StoresService.create` refuses
    // a body without one — "A store must belong to an organization" (P0-01) —
    // and this form omitted it entirely, so adding a website answered 400 for
    // every actor. The company comes from the RESOLVED scope, never from the
    // form: a body-supplied id is exactly what the server's organization wall
    // exists to refuse.
    const organizationId = scope?.organizationId ?? null;
    if (!editing && !organizationId) {
      toast.error(t('Choose a company first: a website belongs to one.'));
      return;
    }
    try {
      await apiFetch(editing ? `/stores/${editing.id}` : '/stores', {
        method: editing ? 'PATCH' : 'POST',
        token: accessToken,
        body: JSON.stringify({
          name: values.name,
          websiteUrl: values.websiteUrl || null,
          websiteProductPath: values.websiteProductPath || null,
          websiteCategoryPath: values.websiteCategoryPath || null,
          ...(editing ? {} : { organizationId }),
        }),
      });
      toast.success(editing ? 'Store updated' : 'Store created');
      setIsFormOpen(false);
      setEditing(null);
      onChanged();
    } catch (err: any) {
      toast.error(err.message || 'Operation failed');
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    try {
      const archived = archiveTarget;
      await apiFetch(`/stores/${archived.id}/archive`, { method: 'PATCH', token: accessToken });
      toast.undo(`"${archived.name}" archived`, t('Undo'), () => handleRestore(archived));
      setArchiveTarget(null);
      onChanged();
    } catch (err: any) {
      toast.error(err.message || 'Failed to archive store');
      setArchiveTarget(null);
    }
  };

  const handleRestore = async (store: StoreRecord) => {
    try {
      await apiFetch(`/stores/${store.id}/restore`, { method: 'PATCH', token: accessToken });
      toast.success(`"${store.name}" restored`);
      onChanged();
    } catch (err: any) {
      toast.error(err.message || 'Failed to restore store');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-800">{t('Websites')}</h3>
          <Badge variant="info">{t('sales channels')}</Badge>
        </div>
        {canCreate && (
          <Button size="sm" tooltip={t('Connect another website or sales channel')} onClick={openCreate}>
            <StoreIcon className="h-3.5 w-3.5" /> {t('New Website')}
          </Button>
        )}
      </div>
      <p className="text-xs text-slate-500">
        {t('Each website is a sales channel with its own connection and API key. Which products each website shows is configured per product.')}
      </p>

      {/* NO VISIBLE BRANCH IS ACTIVE — and that includes an EMPTY list.
          Ordinary store reads hide REMOVED branches, so a company that removed
          its last branch arrives here with `stores.length === 0`, exactly like
          a company that never had one. An earlier version drew the guidance
          only when every RETURNED branch was archived and showed the empty list
          a bare "No websites yet." — which is not distinguishable from
          "never created", and silently dropped the recovery routes #293
          promises. The list cannot tell the two apart (removed records are
          deliberately absent from it, and a tenant-visible lookup to tell
          them apart would expose what removal hides), so the truthful generic
          state is shown for BOTH: create a branch, reactivate an archived one
          if there is one, or ask the platform owner to restore a removed one.
          `every` on an empty array is true, which is the point. */}
      {stores.every((store) => store.archivedAt) && (
        <NoActiveStores what={t('Selling, invoicing and the public catalogue')} />
      )}

      {stores.length === 0 ? (
        <EmptyState message={t('No websites yet.')} />
      ) : (
        <Table>
          <THead>
            <TH>{t('Name')}</TH>
            <TH>{t('Website')}</TH>
            <TH>{t('Status')}</TH>
            {canManageAnyStore && <TH align="right">{t('Actions')}</TH>}
          </THead>
          <TBody>
            {stores.map((store) => (
              <TR key={store.id} className={store.archivedAt ? 'bg-slate-50 text-slate-400' : ''}>
                <TD className="font-medium">
                  <Link href={`/dashboard/website/${store.id}`} className="text-primary hover:underline">
                    {store.name}
                  </Link>
                  <div className="text-xs text-slate-400 font-mono">{store.slug}</div>
                </TD>
                <TD>
                  {store.websiteUrl ? (
                    <a
                      href={store.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1 text-xs"
                    >
                      {store.websiteUrl} <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400 italic">not connected</span>
                  )}
                </TD>
                <TD>
                  {store.archivedAt ? (
                    <Badge variant="danger">{t('Archived')}</Badge>
                  ) : (
                    <Badge variant="success">{t('Active')}</Badge>
                  )}
                </TD>
                {/* The cell is drawn whenever the column exists, so rows this
                    actor may not manage stay aligned but offer nothing. */}
                {canManageAnyStore && (
                  <TD align="right" className="whitespace-nowrap space-x-1">
                    {!canManageStore(store.id) ? null : store.archivedAt ? (
                      <>
                        <Button size="sm" variant="secondary" tooltip={t('Reactivate this website')} onClick={() => handleRestore(store)}>
                          {t('Restore')}
                        </Button>
                        {/* An archived branch can still be removed, and comes
                            back archived if it ever is restored. */}
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="secondary" tooltip={t('Edit website name and connection')} onClick={() => openEdit(store)}>
                          {t('Edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          data-testid={`archive-store-${store.id}`}
                          onClick={() => setArchiveTarget(store)}
                        >
                          {t('Archive')}
                        </Button>
                      </>
                    )}
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Modal
        open={isFormOpen}
        title={editing ? `${t('Edit Website')}: ${editing.name}` : t('New Website')}
        onClose={() => setIsFormOpen(false)}
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label={t('Name')} placeholder={t('e.g. Downtown Store')} error={errors.name?.message} {...register('name')} />
          </div>
          <Input
            label={t('Website URL')}
            placeholder="https://www.store-website.com"
            error={errors.websiteUrl?.message}
            {...register('websiteUrl')}
          />
          {isPlatformOwner && (
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('Product URL pattern')}
                placeholder="/products/{slug}"
                error={errors.websiteProductPath?.message}
                {...register('websiteProductPath')}
              />
              <Input
                label={t('Category URL pattern')}
                placeholder="/categories/{slug}"
                error={errors.websiteCategoryPath?.message}
                {...register('websiteCategoryPath')}
              />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
            <Button type="button" variant="secondary" onClick={() => setIsFormOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" isLoading={isSubmitting}>
              {editing ? 'Save Store' : 'Create Store'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={archiveTarget !== null}
        title={t('Archive Website')}
        message={
          // #293: the sentence "The last active store cannot be archived" was
          // removed, not softened. The rule behind it is gone — a company may
          // hold zero active branches — and a confirmation that describes a
          // refusal the server no longer makes teaches an operator to expect a
          // safety net that is not there. It also now goes through `t()`: the
          // previous copy was raw JSX and never translated at all.
          t(
            'Archive {name}? Its website connection and API keys stop working until it is reactivated. Nothing is deleted, and you can turn it back on yourself at any time.',
            { name: archiveTarget?.name ?? '' },
          )
        }
        confirmLabel="Archive"
        danger
        onConfirm={handleArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  );
}
