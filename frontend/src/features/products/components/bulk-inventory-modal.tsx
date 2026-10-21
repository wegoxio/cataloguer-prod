'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Modal from '../../../components/ui/modal';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Button from '../../../components/ui/button';

const bulkInventorySchema = z.object({
  stockQuantity: z.coerce.number().int().min(0, 'Stock quantity must be non-negative'),
  trackInventoryMode: z.enum(['keep', 'track', 'no-track']),
});

type BulkInventorySchema = z.output<typeof bulkInventorySchema>;
type BulkInventorySchemaInput = z.input<typeof bulkInventorySchema>;

interface BulkInventoryModalProps {
  onSubmit: (data: { stockQuantity: number; trackInventory?: boolean }) => Promise<void>;
  onClose: () => void;
}

export default function BulkInventoryModal({ onSubmit, onClose }: BulkInventoryModalProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<BulkInventorySchemaInput, unknown, BulkInventorySchema>({
    resolver: zodResolver(bulkInventorySchema),
    defaultValues: {
      stockQuantity: 0,
      trackInventoryMode: 'keep',
    },
  });

  const onFormSubmit = async (data: BulkInventorySchema) => {
    const payload: { stockQuantity: number; trackInventory?: boolean } = {
      stockQuantity: data.stockQuantity,
    };
    if (data.trackInventoryMode === 'track') {
      payload.trackInventory = true;
    } else if (data.trackInventoryMode === 'no-track') {
      payload.trackInventory = false;
    }
    await onSubmit(payload);
  };

  return (
    <Modal open title="Update Inventory (Bulk)" onClose={onClose}>
      <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
        <p className="text-xs text-slate-500">
          Specify new stock levels and select whether to toggle inventory tracking for all selected
          products.
        </p>
        <Input
          type="number"
          label="New Stock Quantity"
          placeholder="e.g. 50"
          error={errors.stockQuantity?.message}
          {...register('stockQuantity')}
        />
        <Select label="Track Inventory Status" {...register('trackInventoryMode')}>
          <option value="keep">Keep Current Product Tracking Status</option>
          <option value="track">Track Inventory (Yes)</option>
          <option value="no-track">Do Not Track Inventory (No)</option>
        </Select>
        <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            Update Inventory
          </Button>
        </div>
      </form>
    </Modal>
  );
}
