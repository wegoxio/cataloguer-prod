'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Textarea from '../../../components/ui/textarea';
import Button from '../../../components/ui/button';
import { ImagePlus, Trash2 } from 'lucide-react';
import { apiFetch } from '../../../lib/api-client';

import type { Category } from '../types/category.types';

const categorySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  metaTitle: z.string().max(160, 'Max 160 characters').optional(),
  metaDescription: z.string().max(300, 'Max 300 characters').optional(),
  parentCategoryId: z.string().optional().nullable(),
  // Phase 4 presentation metadata. `publicLabel` is the storefront heading;
  // empty means "use the name", so it is normalised away rather than sent as
  // a blank string the API would reject.
  kind: z.enum(['', 'PRODUCT_TYPE', 'BRAND', 'DESIGNER', 'COLLECTION', 'MERCHANDISING']).optional(),
  publicLabel: z.string().max(160, 'Max 160 characters').optional(),
  sortOrder: z.coerce.number().int('Whole numbers only').min(0, 'Cannot be negative').optional(),
  showInNavigation: z.boolean().optional(),
});

type CategorySchema = z.output<typeof categorySchema>;
type CategorySchemaInput = z.input<typeof categorySchema>;
export type CategoryFormSubmission = CategorySchema & {
  imageFile?: File | null;
  removeImage?: boolean;
  channelChanges?: Array<{ channelId: string; visible: boolean }>;
};

interface CategoryFormProps {
  initialValues?: Category | null;
  categories: Category[];
  onSubmit: (data: CategoryFormSubmission) => Promise<void>;
  onCancel: () => void;
  token?: string;
  storeId?: string;
}

export default function CategoryForm({
  initialValues,
  categories,
  onSubmit,
  onCancel,
  token,
  storeId,
}: CategoryFormProps) {
  const [imageFile, setImageFile] = React.useState<File | null>(null);
  const [removeImage, setRemoveImage] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(initialValues?.imageUrl ?? null);
  const [channels, setChannels] = React.useState<Array<{ id: string; name: string; key: string }>>([]);
  const [initialChannelIds, setInitialChannelIds] = React.useState<Set<string>>(new Set());
  const [channelIds, setChannelIds] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!token || !storeId) return;
    let active = true;
    apiFetch(`/stores/${storeId}/catalogue-navigation`, { token }).then((response) => {
      if (!active) return;
      const snapshot = response.data as {
        channels?: Array<{ id: string; name: string; key: string }>;
        publications?: Array<{ channel: string | { id: string }; category: string | { id: string }; visible: boolean }>;
      };
      setChannels(snapshot.channels ?? []);
      const selected = new Set(
        (snapshot.publications ?? [])
          .filter((publication) => {
            const categoryId = typeof publication.category === 'string' ? publication.category : publication.category.id;
            return publication.visible && categoryId === initialValues?.id;
          })
          .map((publication) => typeof publication.channel === 'string' ? publication.channel : publication.channel.id),
      );
      setInitialChannelIds(selected);
      setChannelIds(new Set(selected));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [initialValues?.id, storeId, token]);

  React.useEffect(() => () => {
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CategorySchemaInput, unknown, CategorySchema>({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: initialValues?.name || '',
      description: initialValues?.description || '',
      metaTitle: initialValues?.metaTitle || '',
      metaDescription: initialValues?.metaDescription || '',
      parentCategoryId: initialValues?.parentCategory?.id || '',
      kind: initialValues?.kind ?? '',
      publicLabel: initialValues?.publicLabel || '',
      sortOrder: initialValues?.sortOrder ?? 0,
      showInNavigation: initialValues?.showInNavigation ?? true,
    },
  });

  // Filter out the category itself to prevent parenting loop (self-parent check)
  const availableParents = categories.filter((c) => !initialValues || c.id !== initialValues.id);

  return (
    <form onSubmit={handleSubmit((data) => onSubmit({
      ...data,
      imageFile,
      removeImage,
      channelChanges: channels
        .filter((channel) => initialChannelIds.has(channel.id) !== channelIds.has(channel.id))
        .map((channel) => ({ channelId: channel.id, visible: channelIds.has(channel.id) })),
    }))} className="space-y-4">
      <Input label="Name" placeholder="e.g. Shirts" error={errors.name?.message} {...register('name')} />
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold text-slate-700">Category image</p>
        <p className="mt-1 text-[11px] text-slate-500">
          This image represents the category in every storefront channel. It is optimized before upload.
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-slate-300 bg-white sm:w-40">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Category preview" className="h-full w-full object-contain" />
            ) : (
              <ImagePlus className="h-7 w-7 text-slate-300" aria-hidden="true" />
            )}
          </div>
          <div className="space-y-2">
            <label className="inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              {previewUrl ? 'Replace image' : 'Choose image'}
              <input
                className="sr-only"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  if (!file) return;
                  setImageFile(file);
                  setRemoveImage(false);
                  setPreviewUrl(URL.createObjectURL(file));
                }}
              />
            </label>
            {previewUrl && (
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700"
                onClick={() => {
                  setImageFile(null);
                  setRemoveImage(Boolean(initialValues?.imageUrl));
                  setPreviewUrl(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove image
              </button>
            )}
            <p className="text-[10px] text-slate-400">JPG, PNG, WebP or AVIF. Maximum source size: 25 MB.</p>
          </div>
        </div>
      </div>

      {channels.length > 0 && (
        <fieldset className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <legend className="px-1 text-xs font-semibold text-slate-700">Publish in storefront channels</legend>
          <p className="mb-3 text-[11px] text-slate-500">
            Select Mobiliario, Mobiliario H1, or any future channel where this category should be visible.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {channels.map((channel) => (
              <label key={channel.id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${channelIds.has(channel.id) ? 'border-primary/30 bg-primary/10 text-primary' : 'border-slate-200 bg-white text-slate-700'}`}>
                <input
                  type="checkbox"
                  checked={channelIds.has(channel.id)}
                  onChange={(event) => setChannelIds((current) => {
                    const next = new Set(current);
                    event.target.checked ? next.add(channel.id) : next.delete(channel.id);
                    return next;
                  })}
                />
                <span className="font-semibold">{channel.name}</span>
                <span className="text-slate-400">({channel.key})</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Textarea
        label="Description"
        placeholder="e.g. Men's and women's shirts"
        rows={3}
        error={errors.description?.message}
        {...register('description')}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 bg-slate-50 rounded-md border border-slate-100">
        <Input
          label="SEO Title (max 160)"
          placeholder="Defaults to the category name"
          maxLength={160}
          error={errors.metaTitle?.message}
          {...register('metaTitle')}
        />
        <Input
          label="SEO Description (max 300)"
          placeholder="Defaults to the description"
          maxLength={300}
          error={errors.metaDescription?.message}
          {...register('metaDescription')}
        />
      </div>

      <Select label="Parent Category" error={errors.parentCategoryId?.message} {...register('parentCategoryId')}>
        <option value="">None (Root Category)</option>
        {availableParents.map((parent) => (
          <option key={parent.id} value={parent.id}>
            {parent.name}
          </option>
        ))}
      </Select>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select label="Type of grouping" error={errors.kind?.message} {...register('kind')}>
          <option value="">Unclassified</option>
          <option value="PRODUCT_TYPE">Product type</option>
          <option value="BRAND">Brand</option>
          <option value="DESIGNER">Designer</option>
          <option value="COLLECTION">Collection</option>
          <option value="MERCHANDISING">Merchandising group</option>
        </Select>
        <Input
          label="Storefront heading (optional)"
          placeholder="Leave blank to use the name"
          error={errors.publicLabel?.message}
          {...register('publicLabel')}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          type="number"
          min={0}
          label="Position among siblings"
          error={errors.sortOrder?.message}
          {...register('sortOrder')}
        />
        <label className="flex items-center gap-2 text-sm text-slate-700 pt-6">
          <input type="checkbox" className="rounded border-slate-300" {...register('showInNavigation')} />
          Show in storefront navigation
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          Save Category
        </Button>
      </div>
    </form>
  );
}
