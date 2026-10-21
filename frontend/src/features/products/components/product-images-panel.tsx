'use client';

import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { apiFetch } from '../../../lib/api-client';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import Button from '../../../components/ui/button';
import Input from '../../../components/ui/input';
import Checkbox from '../../../components/ui/checkbox';
import Badge from '../../../components/ui/badge';
import Modal from '../../../components/ui/modal';
import ConfirmModal from '../../../components/ui/confirm-modal';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import { cn } from '../../../lib/cn';
import ImageUploadZone from './image-upload-zone';
import { CardPreview, ModePicker } from './image-framing';
import { useAuth } from '../../../lib/auth';
import { useProductImages, type ProductImage } from '../product-detail-query';
import { tenantQueryIdentity } from '../../../lib/domain-queries';

interface Product {
  id: string;
  name: string;
}

interface ProductImagesPanelProps {
  product: Product;
  accessToken: string;
  canManage: boolean;
  onClose: () => void;
  onRefreshProducts: () => void;
}

const imageSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  altText: z.string().optional(),
  sortOrder: z.coerce.number().int().min(0, 'Sort order must be non-negative'),
  isPrimary: z.boolean(),
  displayMode: z.enum(['CONTAIN', 'COVER']),
});

type ImageSchema = z.output<typeof imageSchema>;
type ImageSchemaInput = z.input<typeof imageSchema>;

export default function ProductImagesPanel({
  product,
  accessToken,
  canManage,
  onClose,
  onRefreshProducts,
}: ProductImagesPanelProps) {
  const toast = useToast();
  const t = useT();
  const { scope } = useAuth();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [editingImage, setEditingImage] = useState<ProductImage | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ProductImage | null>(null);
  // "Choose from bank": pick an already-uploaded Assets image for this item

  const identity = tenantQueryIdentity(scope?.organizationId, scope?.storeId);
  const imagesQuery = useProductImages(accessToken, scope?.organizationId, scope?.storeId, product.id, showArchived);
  const images = imagesQuery.data ?? [];
  const loading = imagesQuery.isPending;
  const error = imagesQuery.error instanceof Error ? imagesQuery.error.message : imagesQuery.isError ? 'Failed to retrieve images' : null;
  const refreshImages = () => queryClient.invalidateQueries({ queryKey: ['catalogue', identity, 'products', product.id, 'images'] });
  const activeImages = images.filter((img) => !img.archivedAt);
  const nextSortOrder = activeImages.reduce((max, img) => Math.max(max, img.sortOrder + 1), 0);
  const hasPrimary = activeImages.some((img) => img.isPrimary);

  // (Re)load the bank whenever the picker is open or the search changes

  const handleCreateOrUpdate = async (data: ImageSchema) => {
    const method = editingImage ? 'PATCH' : 'POST';
    const endpoint = editingImage
      ? `/products/${product.id}/images/${editingImage.id}`
      : `/products/${product.id}/images`;

    try {
      await apiFetch(endpoint, {
        method,
        token: accessToken,
        body: JSON.stringify(data),
      });
      toast.success(editingImage ? t('Image updated') : t('Image added'));
      setIsFormOpen(false);
      setEditingImage(null);
      await refreshImages();
      onRefreshProducts(); // Refresh thumbnail in list
    } catch (err: any) {
      toast.error(err.message || t('Operation failed'));
    }
  };

  /**
   * Move a photo one place up or down the gallery. Both rows are restated —
   * the paired write the documents panel established — so the gallery always
   * lands in exactly the order the operator just saw, never in a state where
   * two photos share a rank because one write survived and the other did not.
   */
  const handleMove = async (image: ProductImage, direction: -1 | 1) => {
    const ordered = activeImages;
    const index = ordered.findIndex((img) => img.id === image.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    try {
      await apiFetch(`/products/${product.id}/images/${ordered[index].id}`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ sortOrder: target }),
      });
      await apiFetch(`/products/${product.id}/images/${ordered[target].id}`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify({ sortOrder: index }),
      });
      await refreshImages();
      onRefreshProducts();
    } catch (err: any) {
      toast.error(err.message || t('Could not reorder the photos'));
    }
  };

  const handleMakePrimary = async (id: string) => {
    try {
      await apiFetch(`/products/${product.id}/images/${id}/make-primary`, {
        method: 'PATCH',
        token: accessToken,
      });
      toast.success(t('Primary image updated'));
      await refreshImages();
      onRefreshProducts();
    } catch (err: any) {
      toast.error(err.message || t('Failed to set primary image'));
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    try {
      await apiFetch(`/products/${product.id}/images/${archiveTarget.id}/archive`, {
        method: 'PATCH',
        token: accessToken,
      });
      toast.success(t('Image archived'));
      setArchiveTarget(null);
      await refreshImages();
      onRefreshProducts();
    } catch (err: any) {
      toast.error(err.message || t('Failed to archive image'));
      setArchiveTarget(null);
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await apiFetch(`/products/${product.id}/images/${id}/restore`, {
        method: 'PATCH',
        token: accessToken,
      });
      toast.success(t('Image restored'));
      await refreshImages();
      onRefreshProducts();
    } catch (err: any) {
      toast.error(err.message || t('Failed to restore image'));
    }
  };

  return (
    <Modal open title={`${t('Manage Images')}: ${product.name}`} onClose={onClose} className="max-w-3xl">
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-slate-500">
            {t('The photos this item shows on your websites. The primary one is the cover.')}
          </p>
          {canManage && (
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                variant="secondary"
                tooltip={t('Paste a link to an image hosted elsewhere')}
                onClick={() => {
                  setEditingImage(null);
                  setIsFormOpen(true);
                }}
              >
                {t('Add by URL')}
              </Button>
            </div>
          )}
        </div>

        {canManage && (
          <ImageUploadZone
            productId={product.id}
            accessToken={accessToken}
            nextSortOrder={nextSortOrder}
            hasPrimary={hasPrimary}
            onUploaded={() => {
              void refreshImages();
              onRefreshProducts();
            }}
          />
        )}

        {isFormOpen && canManage && (
          <ImageForm
            key={editingImage?.id ?? 'new'}
            initialValues={editingImage}
            onSubmit={handleCreateOrUpdate}
            onCancel={() => {
              setIsFormOpen(false);
              setEditingImage(null);
            }}
          />
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">{error}</div>
        )}

        <Checkbox
          label={t('Show Archived Images')}
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />

        {loading ? (
          <div className="text-slate-500 text-sm">{t('Loading…')}</div>
        ) : (
          <ImageTable
            images={images}
            canManage={canManage}
            onMakePrimary={handleMakePrimary}
            onMove={handleMove}
            onEdit={(img) => {
              setEditingImage(img);
              setIsFormOpen(true);
            }}
            onArchive={setArchiveTarget}
            onRestore={handleRestore}
          />
        )}

        <ConfirmModal
          open={archiveTarget !== null}
          title={t('Archive Image')}
          message={t('Archive this image? If it was primary, the next active image is promoted automatically.')}
          confirmLabel={t('Archive')}
          danger
          onConfirm={handleArchive}
          onCancel={() => setArchiveTarget(null)}
        />
      </div>
    </Modal>
  );
}

/* Sub-component: Image Form */
interface ImageFormProps {
  initialValues?: ProductImage | null;
  onSubmit: (data: ImageSchema) => Promise<void>;
  onCancel: () => void;
}

function ImageForm({ initialValues, onSubmit, onCancel }: ImageFormProps) {
  const t = useT();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ImageSchemaInput, unknown, ImageSchema>({
    resolver: zodResolver(imageSchema),
    defaultValues: {
      url: initialValues?.url || '',
      altText: initialValues?.altText || '',
      sortOrder: initialValues?.sortOrder !== undefined ? initialValues.sortOrder : 0,
      isPrimary: !!initialValues?.isPrimary,
      displayMode: initialValues?.displayMode === 'COVER' ? 'COVER' : 'CONTAIN',
    },
  });
  const watchedUrl = watch('url');
  const watchedMode = watch('displayMode');

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="p-4 bg-slate-50 rounded-md border border-slate-200 space-y-4"
    >
      <h4 className="text-sm font-bold text-slate-800">
        {initialValues ? t('Edit image details') : t('Add image by URL')}
      </h4>

      <Input
        label={t('Image URL')}
        placeholder="https://…/image.png"
        disabled={!!initialValues}
        error={errors.url?.message}
        {...register('url')}
      />
      {initialValues && (
        // The server's update contract has no `url` on purpose: an image IS
        // its file. Say so, instead of a silently dead field.
        <p className="text-[11px] text-slate-500" data-testid="image-replace-note">
          {t('A photo cannot change its file. To replace it, archive this one and add the replacement — the gallery keeps the old photo restorable.')}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label={t('Alt Text')}
          placeholder={t('e.g. Side view')}
          error={errors.altText?.message}
          {...register('altText')}
        />
        <Input
          type="number"
          label={t('Sort Order')}
          placeholder="0"
          error={errors.sortOrder?.message}
          {...register('sortOrder')}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-600">{t('How it shows on the website')}</p>
        <ModePicker mode={watchedMode} onChange={(mode) => setValue('displayMode', mode)} t={t} />
        {watchedUrl && !errors.url && (
          <CardPreview url={watchedUrl} mode={watchedMode} name={t('Preview')} t={t} />
        )}
      </div>

      {!initialValues && <Checkbox label={t('Set as Primary Image')} {...register('isPrimary')} />}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="submit" size="sm" isLoading={isSubmitting}>
          {t('Save')}
        </Button>
      </div>
    </form>
  );
}

/* Sub-component: Image Table */
interface ImageTableProps {
  images: ProductImage[];
  canManage: boolean;
  onMakePrimary: (id: string) => void;
  onMove: (img: ProductImage, direction: -1 | 1) => void;
  onEdit: (img: ProductImage) => void;
  onArchive: (img: ProductImage) => void;
  onRestore: (id: string) => void;
}

function ImageTable({ images, canManage, onMakePrimary, onMove, onEdit, onArchive, onRestore }: ImageTableProps) {
  const t = useT();
  if (images.length === 0) {
    return <EmptyState message={t('No images added to this product.')} />;
  }

  return (
    <Table>
      <THead>
        <TH className="w-16">{t('Preview')}</TH>
        <TH>{t('Alt Text')}</TH>
        <TH>{t('Sort Order')}</TH>
        <TH>{t('Primary?')}</TH>
        {canManage && <TH align="right">{t('Actions')}</TH>}
      </THead>
      <TBody>
        {images.map((img) => (
          <TR
            key={img.id}
            className={cn('hover:bg-slate-50 transition-colors', img.archivedAt && 'bg-red-50/50 opacity-80')}
          >
            <TD>
              {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external URLs; P3 replaces this with uploaded thumbnails */}
              <img
                src={img.url}
                alt={img.altText || 'Product image'}
                className="w-12 h-12 object-cover rounded border border-slate-200"
              />
            </TD>
            <TD className="font-medium">
              {img.altText || '-'}
              {img.archivedAt && (
                <Badge variant="danger" className="ml-2">
                  {t('Archived')}
                </Badge>
              )}
            </TD>
            <TD className="font-mono text-xs">{img.sortOrder}</TD>
            <TD>
              {img.isPrimary ? (
                <Badge variant="info">{t('Primary')}</Badge>
              ) : (
                canManage &&
                !img.archivedAt && (
                  <Button size="sm" variant="ghost" className="text-primary" tooltip={t('Use as the main photo shown first')} onClick={() => onMakePrimary(img.id)}>
                    {t('Make Primary')}
                  </Button>
                )
              )}
            </TD>
            {canManage && (
              <TD align="right" className="whitespace-nowrap space-x-1">
                {img.archivedAt ? (
                  <Button size="sm" variant="secondary" tooltip={t('Bring this photo back')} onClick={() => onRestore(img.id)}>
                    {t('Restore')}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" tooltip={t('Show this photo earlier')} onClick={() => onMove(img, -1)}>
                      ↑
                    </Button>
                    <Button size="sm" variant="ghost" tooltip={t('Show this photo later')} onClick={() => onMove(img, 1)}>
                      ↓
                    </Button>
                    <Button size="sm" variant="secondary" tooltip={t('Edit the photo description (alt text)')} onClick={() => onEdit(img)}>
                      {t('Edit')}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-danger" tooltip={t('Remove this photo from the product (restorable)')} onClick={() => onArchive(img)}>
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
  );
}
