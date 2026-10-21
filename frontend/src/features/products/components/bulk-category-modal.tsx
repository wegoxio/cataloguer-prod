'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Modal from '../../../components/ui/modal';
import Select from '../../../components/ui/select';
import Button from '../../../components/ui/button';
import type { CategoryRef } from '../../categories/types/category.types';

const bulkCategorySchema = z.object({
  categoryId: z.string().nullable().optional(),
});

type BulkCategorySchema = z.infer<typeof bulkCategorySchema>;

interface BulkCategoryModalProps {
  categories: CategoryRef[];
  onSubmit: (data: { categoryId: string | null }) => Promise<void>;
  onClose: () => void;
}

export default function BulkCategoryModal({ categories, onSubmit, onClose }: BulkCategoryModalProps) {
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<BulkCategorySchema>({
    resolver: zodResolver(bulkCategorySchema),
    defaultValues: {
      categoryId: '',
    },
  });

  const activeCategories = categories.filter((c) => !c.archivedAt);

  const onFormSubmit = async (data: BulkCategorySchema) => {
    await onSubmit({ categoryId: data.categoryId || null });
  };

  return (
    <Modal open title="Assign Category (Bulk)" onClose={onClose}>
      <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
        <p className="text-xs text-slate-500">
          Select a category to assign to all selected products. Selecting &quot;None&quot; will clear
          the category relation.
        </p>
        <Select label="Category" {...register('categoryId')}>
          <option value="">None (Clear Category)</option>
          {activeCategories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </Select>
        <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            Assign Category
          </Button>
        </div>
      </form>
    </Modal>
  );
}
