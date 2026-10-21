'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '../../../lib/auth';
import { canArchiveCatalogueItem, canManageCatalogue } from '../../../lib/permissions';
import { useT } from '../../../lib/i18n';
import { NoOrganizationContext } from '../../../components/layout/access-denied';
import { apiFetch } from '../../../lib/api-client';
import { useDebouncedValue } from '../../../lib/use-debounced-value';
import { useToast } from '../../../components/ui/toast';
import { useWebsiteConfig, buildWebsiteUrl } from '../../../lib/use-website-config';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Checkbox from '../../../components/ui/checkbox';
import Modal from '../../../components/ui/modal';
import ConfirmModal from '../../../components/ui/confirm-modal';
import CategoryTable from '../../../features/categories/components/category-table';
import CategoryForm, { type CategoryFormSubmission } from '../../../features/categories/components/category-form';
import { CatalogueNavigationManager } from '../../../features/categories/components/catalogue-navigation-manager';
import { categoryQueryIdentity, useCategoryList } from '../../../features/categories/category-queries';
import { queryClient, queryKeys } from '../../../lib/query-client';

import type { Category } from '../../../features/categories/types/category.types';
import { optimizeImage } from '../../../lib/image-optimizer';

export default function CategoriesPage() {
  const t = useT();
  const { scope, accessToken } = useAuth();
  const toast = useToast();
  const websiteConfig = useWebsiteConfig();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Category | null>(null);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const listFilters = useMemo(() => ({
    search: debouncedSearch,
    includeArchived: showArchived,
    page,
    limit: 25,
    sortBy,
    sortDirection,
  }), [debouncedSearch, showArchived, page, sortBy, sortDirection]);
  const categoriesQuery = useCategoryList(accessToken, scope?.organizationId, scope?.storeId, listFilters);
  const categories = categoriesQuery.data?.items ?? [];
  const totalPages = categoriesQuery.data?.totalPages ?? 1;
  const loading = categoriesQuery.isPending;
  const error = categoriesQuery.error instanceof Error
    ? categoriesQuery.error.message
    : categoriesQuery.error
      ? 'Failed to retrieve categories'
      : null;

  const identity = scope?.organizationId
    ? categoryQueryIdentity(scope.organizationId, scope.storeId)
    : 'no-organization';
  const invalidateCatalogue = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.categoriesRoot(identity) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.productsRoot(identity) }),
    ]);
  };
  const saveMutation = useMutation({
    mutationFn: async ({ endpoint, method, body }: { endpoint: string; method: string; body: object }) => {
      if (!accessToken) throw new Error('No active session');
      return apiFetch(endpoint, { method, token: accessToken, body: JSON.stringify(body) });
    },
  });
  const categoryStateMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'archive' | 'restore' }) => {
      if (!accessToken) throw new Error('No active session');
      return apiFetch(`/categories/${id}/${action}`, { method: 'PATCH', token: accessToken });
    },
  });

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, showArchived, sortBy, sortDirection]);

  // P5-A2 family 4: catalogue authority comes from the resolved scope. The
  // role guess excluded the ORGANIZATION_MANAGER that the categories routes
  // have admitted since phase 4.
  const canManage = canManageCatalogue(scope);
  // The categories controller has always required an organization
  // administrator for archive/restore/delete; the panel now agrees with it.
  const canArchive = canArchiveCatalogueItem(scope);

  const handleCreateOrUpdate = async (data: CategoryFormSubmission) => {
    if (!accessToken) return;
    const method = editingCategory ? 'PATCH' : 'POST';
    const endpoint = editingCategory ? `/categories/${editingCategory.id}` : '/categories';

    try {
      const response = await saveMutation.mutateAsync({
        endpoint,
        method,
        body: {
          name: data.name,
          description: data.description || null,
          metaTitle: data.metaTitle || null,
          metaDescription: data.metaDescription || null,
          parentCategoryId: data.parentCategoryId || null,
          // Phase 4. The empty select and an empty heading both mean "not set",
          // and the API refuses a blank string — so they are normalised to null
          // rather than sent as '' and rejected by the validation pipe.
          kind: data.kind || null,
          publicLabel: data.publicLabel?.trim() || null,
          sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
          showInNavigation: data.showInNavigation !== false,
        },
      });

      const savedCategory = response.data as Category;
      if (data.imageFile) {
        const optimized = await optimizeImage(data.imageFile);
        const ticketResponse = await apiFetch(`/categories/${savedCategory.id}/image/upload-url`, {
          method: 'POST',
          token: accessToken,
          body: JSON.stringify({ extension: 'webp', size: optimized.blob.size }),
        });
        const ticket = ticketResponse.data as { path: string; url: string };
        // Content-Length is signed by the backend but is a forbidden browser
        // header; fetch derives it from the Blob exactly as product uploads do.
        const upload = await fetch(ticket.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/webp' },
          body: optimized.blob,
        });
        if (!upload.ok) throw new Error(`Category image upload failed (${upload.status})`);
        await apiFetch(`/categories/${savedCategory.id}/image`, {
          method: 'PATCH',
          token: accessToken,
          body: JSON.stringify({ objectKey: ticket.path }),
        });
      } else if (data.removeImage && editingCategory?.imageUrl) {
        await apiFetch(`/categories/${savedCategory.id}/image`, { method: 'DELETE', token: accessToken });
      }

      if (scope?.storeId) {
        await Promise.all((data.channelChanges ?? []).map(({ channelId, visible }) =>
          apiFetch(`/stores/${scope.storeId}/catalogue-navigation/channels/${channelId}/categories/${savedCategory.id}`, {
            method: 'PUT',
            token: accessToken,
            body: JSON.stringify({ visible, ...(visible ? { placements: ['HOME', 'CATALOG', 'NAVIGATION'] } : {}) }),
          }),
        ));
      }

      toast.success(editingCategory ? 'Category updated' : 'Category created');
      setIsFormOpen(false);
      setEditingCategory(null);
      await invalidateCatalogue();
    } catch (err: any) {
      toast.error(err.message || 'Operation failed');
    }
  };

  const handleArchive = async () => {
    if (!accessToken || !archiveTarget || !canArchive) return;
    try {
      const archived = archiveTarget;
      await categoryStateMutation.mutateAsync({ id: archived.id, action: 'archive' });
      toast.undo(`"${archived.name}" archived`, t('Undo'), () => handleRestore(archived));
      setArchiveTarget(null);
      await invalidateCatalogue();
    } catch (err: any) {
      toast.error(err.message || 'Failed to archive category');
      setArchiveTarget(null);
    }
  };

  const handleRestore = async (category: Category) => {
    if (!accessToken || !canArchive) return;
    try {
      await categoryStateMutation.mutateAsync({ id: category.id, action: 'restore' });
      toast.success(`"${category.name}" restored`);
      await invalidateCatalogue();
    } catch (err: any) {
      toast.error(err.message || 'Failed to restore category');
    }
  };

  /** #292: recoverable removal. See the Items page for the reasoning. */

  // A session that names no company is told so — the same wiring the
  // catalogue list has, for the same reason.
  if (scope && !scope.organizationId) {
    return <NoOrganizationContext what={t('The category tree')} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Categories')}</h2>
          <p className="text-xs text-slate-500 mt-1">{t('Manage catalogue categories and structures')}</p>
        </div>
        {canManage && (
          <Button
            tooltip={t('Create a new category to organize products')}
            onClick={() => {
              setEditingCategory(null);
              setIsFormOpen(true);
            }}
          >
            {t('Add Category')}
          </Button>
        )}
      </div>

      {canManage && accessToken && scope?.storeId && (
        <CatalogueNavigationManager token={accessToken} storeId={scope.storeId} />
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">{error}</div>
      )}

      {/* Filters */}
      <div className="p-4 bg-slate-50 border border-slate-200 rounded-md flex flex-wrap gap-4 items-end">
        <Input
          label={t('Search Categories')}
          placeholder={t('Search by name or slug...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px]"
        />
        <Select
          label={t('Sort By')}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="w-36"
        >
          <option value="createdAt">{t('Created At')}</option>
          <option value="name">{t('Name')}</option>
        </Select>
        <Select
          label={t('Sort Order')}
          value={sortDirection}
          onChange={(e) => setSortDirection(e.target.value as 'asc' | 'desc')}
          className="w-36"
        >
          <option value="desc">{t('Descending')}</option>
          <option value="asc">{t('Ascending')}</option>
        </Select>
        <div className="flex items-center h-[32px]">
          <Checkbox
            label={t('Show Archived')}
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          tooltip={t('Clear search and filters')}
          onClick={() => {
            setSearch('');
            setShowArchived(false);
            setSortBy('createdAt');
            setSortDirection('desc');
          }}
        >
          Clear
        </Button>
      </div>

      {loading ? (
        <div className="text-slate-500 text-sm">{t('Fetching category directory...')}</div>
      ) : (
        <div className="space-y-4">
          <CategoryTable
            categories={categories}
            canManage={canManage}
            canArchive={canArchive}
            onEdit={(category) => {
              setEditingCategory(category);
              setIsFormOpen(true);
            }}
            onArchive={setArchiveTarget}
            websiteUrlFor={(slug) => buildWebsiteUrl(websiteConfig, 'category', slug)}
            onRestore={handleRestore}
          />

          {totalPages > 1 && (
            <div className="flex justify-between items-center bg-slate-50 p-4 border border-slate-200 rounded-md">
              <div className="text-xs text-slate-500 font-semibold">
                Page {page} of {totalPages}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Modal
        open={isFormOpen && canManage}
        title={editingCategory ? `Edit Category: ${editingCategory.name}` : 'New Category'}
        onClose={() => {
          setIsFormOpen(false);
          setEditingCategory(null);
        }}
      >
        <CategoryForm
          key={editingCategory?.id ?? 'new'}
          initialValues={editingCategory}
          categories={categories}
          onSubmit={handleCreateOrUpdate}
          token={accessToken ?? undefined}
          storeId={scope?.storeId ?? undefined}
          onCancel={() => {
            setIsFormOpen(false);
            setEditingCategory(null);
          }}
        />
      </Modal>

      <ConfirmModal
        open={archiveTarget !== null}
        title={t('Archive Category')}
        message={
          <>
            Archive <span className="font-semibold">{archiveTarget?.name}</span>? It will disappear
            from the public catalogue but can be restored at any time.
          </>
        }
        confirmLabel="Archive"
        danger
        onConfirm={handleArchive}
        onCancel={() => setArchiveTarget(null)}
      />
</div>
  );
}
