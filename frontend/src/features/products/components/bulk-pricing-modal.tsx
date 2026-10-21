'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Modal from '../../../components/ui/modal';
import Input from '../../../components/ui/input';
import Checkbox from '../../../components/ui/checkbox';
import Button from '../../../components/ui/button';

const bulkPricingSchema = z
  .object({
    price: z.preprocess(
      (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
      z.number().min(0, 'Price must be non-negative').optional(),
    ) as z.ZodType<number | undefined>,
    salePrice: z.preprocess(
      (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
      z.number().min(0, 'Sale price must be non-negative').optional(),
    ) as z.ZodType<number | undefined>,
    clearSalePrice: z.boolean().optional(),
    cost: z.preprocess(
      (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
      z.number().min(0, 'Cost must be non-negative').optional(),
    ) as z.ZodType<number | undefined>,
  })
  .refine(
    (data) => {
      if (!data.clearSalePrice && data.price !== undefined && data.salePrice !== undefined) {
        return data.salePrice <= data.price;
      }
      return true;
    },
    {
      message: 'Sale price cannot exceed the regular price',
      path: ['salePrice'],
    },
  );

type BulkPricingSchema = z.output<typeof bulkPricingSchema>;
type BulkPricingSchemaInput = z.input<typeof bulkPricingSchema>;

interface BulkPricingModalProps {
  onSubmit: (data: { price?: number; salePrice?: number | null; cost?: number | null }) => Promise<void>;
  onClose: () => void;
}

export default function BulkPricingModal({ onSubmit, onClose }: BulkPricingModalProps) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<BulkPricingSchemaInput, unknown, BulkPricingSchema>({
    resolver: zodResolver(bulkPricingSchema),
    defaultValues: {
      price: undefined,
      salePrice: undefined,
      clearSalePrice: false,
      cost: undefined,
    },
  });

  const clearSalePriceChecked = watch('clearSalePrice');

  const onFormSubmit = async (data: BulkPricingSchema) => {
    const payload: { price?: number; salePrice?: number | null; cost?: number | null } = {};
    if (data.price !== undefined) {
      payload.price = data.price;
    }
    if (data.clearSalePrice) {
      payload.salePrice = null;
    } else if (data.salePrice !== undefined) {
      payload.salePrice = data.salePrice;
    }
    if (data.cost !== undefined) {
      payload.cost = data.cost;
    }
    await onSubmit(payload);
  };

  return (
    <Modal open title="Update Pricing (Bulk)" onClose={onClose}>
      <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
        <p className="text-xs text-slate-500">
          Specify new regular prices, sale prices, or purchase costs. Omitted fields will not be
          changed.
        </p>
        <Input
          type="number"
          step="any"
          label="New Price ($)"
          placeholder="Keep current price"
          error={errors.price?.message}
          {...register('price')}
        />
        <div className="space-y-2">
          <Input
            type="number"
            step="any"
            label="New Sale Price ($)"
            disabled={clearSalePriceChecked}
            placeholder={clearSalePriceChecked ? 'Will clear sale price' : 'Keep current sale price'}
            error={errors.salePrice?.message}
            {...register('salePrice')}
          />
          <Checkbox label="Clear Sale Price (Remove Discount)" {...register('clearSalePrice')} />
        </div>
        <Input
          type="number"
          step="any"
          label="New Cost ($)"
          placeholder="Keep current cost"
          error={errors.cost?.message}
          {...register('cost')}
        />
        <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            Update Pricing
          </Button>
        </div>
      </form>
    </Modal>
  );
}
