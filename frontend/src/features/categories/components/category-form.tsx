'use client';

import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Input from '../../../components/ui/input';
import Textarea from '../../../components/ui/textarea';
import Button from '../../../components/ui/button';
import { SearchableSelect } from '../../../components/ui/searchable-select';
import { ImagePlus, Trash2 } from 'lucide-react';
import { apiFetch } from '../../../lib/api-client';

import type { Category } from '../types/category.types';
import { availableCategoryParents, categoryPath } from '../category-parent-options';

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
  categoriesLoading?: boolean;
  categoriesError?: string | null;
  onSubmit: (data: CategoryFormSubmission) => Promise<void>;
  onCancel: () => void;
  token?: string;
  storeId?: string;
}

export default function CategoryForm({
  initialValues,
  categories,
  categoriesLoading = false,
  categoriesError = null,
  onSubmit,
  onCancel,
  token,
  storeId,
}: CategoryFormProps) {
  const [imageFile, setImageFile] = React.useState<File | null>(null);
  const [removeImage, setRemoveImage] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(initialValues?.imageUrl ?? null);
  const [channels, setChannels] = React.useState<Array<{ id: string; name: string; key: string }>>([]);
  const [channelsLoading, setChannelsLoading] = React.useState(Boolean(token && storeId));
  const [channelsError, setChannelsError] = React.useState<string | null>(null);
  const [initialChannelIds, setInitialChannelIds] = React.useState<Set<string>>(new Set());
  const [channelIds, setChannelIds] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!token || !storeId) return;
    let active = true;
    setChannelsLoading(true);
    setChannelsError(null);
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
    }).catch((error: unknown) => {
      if (!active) return;
      setChannelsError(error instanceof Error ? error.message : 'Channels could not be loaded');
    }).finally(() => {
      if (active) setChannelsLoading(false);
    });
    return () => { active = false; };
  }, [initialValues?.id, storeId, token]);

  React.useEffect(() => () => {
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  const {
    register,
    control,
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

  const availableParents = availableCategoryParents(categories, initialValues?.id);
  const parentOptions = [
    { value: '', label: 'None (Root Category)', searchText: 'root none' },
    ...availableParents.map((category) => ({
      value: category.id,
      label: categoryPath(category, categories),
      searchText: `${category.name} ${category.slug}`,
    })),
  ];

  return (
    <form onSubmit={handleSubmit((data) => onSubmit({
      ...data,
      imageFile,
      removeImage,
      channelChanges: channels
        .filter((channel) => initialChannelIds.has(channel.id) !== channelIds.has(channel.id))
        .map((channel) => ({ channelId: channel.id, visible: channelIds.has(channel.id) })),
    }))} className="space-y-5">
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-800">Basic information</h4>
          <p className="mt-1 text-xs text-slate-500">The name is required. All other descriptive fields are optional.</p>
        </div>
        <Input label="Name *" placeholder="e.g. Shirts" error={errors.name?.message} {...register('name')} />
      </section>
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

      {channelsLoading && <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-500" role="status">Loading publication channelsâ€¦</p>}
      {channelsError && (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
          {channelsError}. Saving is disabled so the existing channel configuration is not overwritten.
        </p>
      )}
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
      {/* Keep previously stored metadata when another field is edited. */}
      <input type="hidden" {...register('metaTitle')} />
      <input type="hidden" {...register('metaDescription')} />

      <div className="space-y-1.5 rounded-xl border border-slate-200 bg-white p-4">
        <h4 className="text-sm font-semibold text-slate-800">Hierarchy</h4>
        <Controller
          name="parentCategoryId"
          control={control}
          render={({ field }) => (
            <SearchableSelect
              label="Parent Category"
              value={field.value ?? ''}
              options={parentOptions}
              placeholder={categoriesLoading ? 'Loading all categories…' : categoriesError ? 'Categories unavailable' : 'None (Root Category)'}
              searchPlaceholder="Search category by name, path or slug…"
              emptyMessage="No matching category"
              disabled={categoriesLoading || Boolean(categoriesError)}
              error={errors.parentCategoryId?.message || categoriesError || undefined}
              onChange={field.onChange}
            />
          )}
        />
        <p className="text-[11px] leading-4 text-slate-500">
          This only defines the category hierarchy. Storefront visibility is controlled by the channel and navigation-group configuration.
        </p>
        {initialValues && <p className="text-[11px] leading-4 text-slate-500">This category and its descendants are omitted from the choices to prevent a circular hierarchy.</p>}
      </div>

      {/*
        Presentation metadata stays in the contract for existing API clients,
        but it is not part of this operational form. The channel navigation
        screen is the single place where staff set the public label, visibility
        and order. Hidden controls preserve existing values during unrelated
        edits instead of silently resetting them.
      */}
      <input type="hidden" {...register('kind')} />
      <input type="hidden" {...register('publicLabel')} />
      <input type="hidden" {...register('sortOrder')} />
      <input type="checkbox" className="hidden" aria-hidden="true" tabIndex={-1} {...register('showInNavigation')} />

      <div className="sticky bottom-0 z-10 -mx-1 flex justify-end gap-2 border-t border-slate-200 bg-white/95 px-1 pb-1 pt-4 backdrop-blur">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={categoriesLoading || Boolean(categoriesError) || channelsLoading || Boolean(channelsError)} isLoading={isSubmitting}>
          Save Category
        </Button>
      </div>
    </form>
  );
}
