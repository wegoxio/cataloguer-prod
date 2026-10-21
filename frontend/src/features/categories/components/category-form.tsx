'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Textarea from '../../../components/ui/textarea';
import Button from '../../../components/ui/button';

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

interface CategoryFormProps {
  initialValues?: Category | null;
  categories: Category[];
  onSubmit: (data: CategorySchema) => Promise<void>;
  onCancel: () => void;
}

export default function CategoryForm({
  initialValues,
  categories,
  onSubmit,
  onCancel,
}: CategoryFormProps) {
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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input label="Name" placeholder="e.g. Shirts" error={errors.name?.message} {...register('name')} />
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
