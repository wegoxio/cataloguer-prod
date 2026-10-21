'use client';

import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Textarea from '../../../components/ui/textarea';
import Checkbox from '../../../components/ui/checkbox';
import Button from '../../../components/ui/button';
import type { Product } from '../types/product.types';
import { familyRoleOf } from '../family-role';
import type { CategoryRef } from '../../categories/types/category.types';
import type { StoreRecord } from '../../../lib/use-website-config';
import { useT } from '../../../lib/i18n';

const productSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional(),
    metaTitle: z.string().max(160, 'Max 160 characters').optional(),
    metaDescription: z.string().max(300, 'Max 300 characters').optional(),
    sku: z.string().optional(),
    manufacturerCode: z.string().max(255, 'Max 255 characters').optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']),
    price: z.coerce.number().min(0, 'Price must be non-negative'),
    salePrice: z.preprocess(
      (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
      z.number().min(0, 'Sale price must be non-negative').nullable().optional(),
    ) as z.ZodType<number | null | undefined>,
    cost: z.preprocess(
      (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
      z.number().min(0, 'Cost must be non-negative').nullable().optional(),
    ) as z.ZodType<number | null | undefined>,
    stockQuantity: z.coerce.number().int().min(0, 'Stock quantity must be non-negative'),
    trackInventory: z.boolean(),
  })
  .refine(
    (data) => {
      if (data.salePrice !== null && data.salePrice !== undefined) {
        return Number(data.salePrice) <= Number(data.price);
      }
      return true;
    },
    {
      message: 'Sale price cannot exceed the regular price',
      path: ['salePrice'],
    },
  );

type ProductSchema = z.output<typeof productSchema>;
type ProductSchemaInput = z.input<typeof productSchema>;

export interface ProductStorePrice {
  storeId: string;
  price: number;
  salePrice?: number;
}

/**
 * WHAT THIS FORM SUBMITS, and why membership is OPTIONAL in the type.
 *
 * `storeIds` replaces a product's whole company-wide membership, so only an
 * actor with company-wide authority may send it (#282). When that authority is
 * absent the fields are ABSENT — not empty arrays, not the current values
 * echoed back. The type says so, which is what stops a caller from assuming
 * they are always there.
 */
export type ProductFormSubmission = ProductSchema & {
  categoryIds: string[];
  storeIds?: string[];
  storePrices?: ProductStorePrice[];
};

interface ProductFormProps {
  initialValues?: Product | null;
  categories: CategoryRef[];
  stores: StoreRecord[];
  /**
   * May this actor set company-wide store membership and per-branch prices?
   *
   * Passed in EXPLICITLY rather than inferred here. The form must not work
   * authority out from how many stores it was handed: a branch-scoped actor in
   * a one-store company is still branch-scoped, and a rule that reads the store
   * count would silently change the day a second branch is created (#282).
   */
  canAssignStores: boolean;
  onSubmit: (data: ProductFormSubmission) => Promise<void>;
  onCancel: () => void;
}

export default function ProductForm({
  initialValues,
  categories,
  stores,
  canAssignStores,
  onSubmit,
  onCancel,
}: ProductFormProps) {
  const t = useT();
  const activeStores = stores.filter((store) => !store.archivedAt);
  /*
   * EDITING A PARENT CARD.
   *
   * A card is never sold, so most of this form is meaningless for one: it
   * holds no stock, is never charged, is never ordered from a supplier, and
   * its shops are worked out from its children.
   *
   * What stays editable is what the card actually owns. Its status is a
   * family-level switch — Draft hides the whole family — and its categories
   * were COPIED from its children at creation and are never re-derived, so
   * they belong to the card afterwards. Its price stays too, under its real
   * name: a SORTING price, which places the family in listings and price
   * filters and is never what anyone pays.
   *
   * The hidden fields are not merely hidden. Every one of them is refused at
   * the endpoint, for every client, because an interface is where a person is
   * told and not where a rule is kept.
   */
  const isCard = !!initialValues && familyRoleOf(initialValues) === 'PARENT';
  const [categoryIds, setCategoryIds] = React.useState<string[]>(
    initialValues?.categories?.map((c) => c.id) ?? [],
  );
  const toggleCategory = (id: string) =>
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  // P0-11: a new product starts published NOWHERE. Defaulting to every
  // store meant one click could put an item on every client's website.
  const [storeIds, setStoreIds] = React.useState<string[]>(
    initialValues ? (initialValues.stores || []).map((store) => store.id) : [],
  );
  const toggleStore = (id: string) =>
    setStoreIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  // Per-store price overrides (P7.3): empty = store uses the base price
  const [storePriceMap, setStorePriceMap] = React.useState<Record<string, { price: string; salePrice: string }>>(
    () => {
      const map: Record<string, { price: string; salePrice: string }> = {};
      // P0-06: overrides now arrive as branchLinks; a null price means the
      // base price applies and stays out of the override map
      (initialValues?.storePrices ?? (initialValues?.branchLinks || []).filter((l) => l.price != null)).forEach((entry) => {
        const id = typeof entry.store === 'string' ? entry.store : entry.store.id;
        map[id] = {
          price: String(entry.price),
          salePrice: entry.salePrice !== null && entry.salePrice !== undefined ? String(entry.salePrice) : '',
        };
      });
      return map;
    },
  );
  const setOverride = (id: string, field: 'price' | 'salePrice', value: string) =>
    setStorePriceMap((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { price: '', salePrice: '' }), [field]: value },
    }));

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProductSchemaInput, unknown, ProductSchema>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: initialValues?.name || '',
      description: initialValues?.description || '',
      metaTitle: initialValues?.metaTitle || '',
      metaDescription: initialValues?.metaDescription || '',
      sku: initialValues?.sku || '',
      manufacturerCode: initialValues?.manufacturerCode || '',
      status: (initialValues?.status === 'ARCHIVED' ? 'DRAFT' : initialValues?.status) || 'DRAFT',
      price: initialValues?.price !== undefined ? Number(initialValues.price) : 0,
      salePrice:
        initialValues?.salePrice !== undefined && initialValues?.salePrice !== null
          ? Number(initialValues.salePrice)
          : ('' as any),
      cost:
        initialValues?.cost !== undefined && initialValues?.cost !== null
          ? Number(initialValues.cost)
          : ('' as any),
      stockQuantity: initialValues?.stockQuantity !== undefined ? initialValues.stockQuantity : 0,
      trackInventory: !!initialValues?.trackInventory,
    },
  });

  // Show active categories, plus any archived one the item already sits in
  const availableCategories = categories.filter((c) => !c.archivedAt || categoryIds.includes(c.id));

  return (
    <form
      onSubmit={handleSubmit((data) => {
        // A card SENDS only what it owns. The hidden inputs still carry their
        // defaults, and sending `salePrice: null` or `stockQuantity: 0` for a
        // card is refused at the endpoint — correctly, because those fields
        // mean nothing for something that is never sold. Omitting them is what
        // "this form does not edit that" looks like on the wire.
        const { salePrice, cost, stockQuantity, trackInventory, sku, manufacturerCode, ...owned } = data as any;
        if (isCard) {
          return onSubmit({ ...owned, categoryIds } as ProductFormSubmission);
        }
        // #282: WITHOUT company-wide authority the membership fields are not
        // sent at all. Echoing the product's CURRENT stores back was the
        // defect: the endpoint refuses on the presence of `storeIds`, by
        // design and by test, so restating unchanged membership turned every
        // ordinary edit — a status change on the way to grouping items — into
        // "Replacing store membership is a company-wide operation".
        if (!canAssignStores) {
          return onSubmit({ ...data, categoryIds } as ProductFormSubmission);
        }
        return onSubmit({
          ...data,
          categoryIds,
          storeIds,
          storePrices: storeIds
            .filter((id) => storePriceMap[id]?.price !== undefined && storePriceMap[id].price !== '')
            .map((id) => ({
              storeId: id,
              price: Number(storePriceMap[id].price),
              salePrice: storePriceMap[id].salePrice !== '' ? Number(storePriceMap[id].salePrice) : undefined,
            })),
        } as ProductFormSubmission);
      })}
      className="space-y-4"
    >
      {/*
        P5-W4 capability 4: the two halves of a product are LABELLED, because
        they were previously mixed and nothing said which was which.
        Everything under this heading belongs to the COMPANY and is identical
        in every branch; everything under "Set by each branch" below belongs to
        one branch and is never shared.
      */}
      <div className="pb-1 border-b border-slate-100" data-testid="form-company-section">
        <p className="text-[10px] font-semibold text-slate-500 uppercase">{t('Owned by the company')}</p>
        <p className="text-[11px] text-slate-400">
          {t('The same in every branch: identity, copy, categories and the base price.')}
        </p>
      </div>
      <Input
        label="Name"
        placeholder="e.g. Vintage Leather Boots"
        error={errors.name?.message}
        {...register('name')}
      />
      <Textarea
        label="Description"
        placeholder="e.g. Handcrafted boots made from premium full-grain leather"
        rows={3}
        error={errors.description?.message}
        {...register('description')}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 bg-slate-50 rounded-md border border-slate-100">
        <Input
          label="SEO Title (max 160)"
          placeholder="Defaults to the product name"
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
        <p className="text-[11px] text-slate-400 md:col-span-2 -mt-2">
          {t('How this product looks on Google: the title is the blue link, the description the grey text under it. Left empty, Google uses the name and description.')}
        </p>
      </div>

      {!isCard && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Input
            label="SKU"
            placeholder="e.g. BOOT-LTH-VNTG-42"
            error={errors.sku?.message}
            {...register('sku')}
          />
          <p className="text-[11px] text-slate-400 mt-1">
            {t('Your internal product code — customers never see it. Imports and supplier orders use it to update the right product instead of creating a duplicate.')}
          </p>
        </div>
        <div>
          <Input
            label="Manufacturer code"
            placeholder="e.g. KARE-71234"
            maxLength={255}
            error={errors.manufacturerCode?.message}
            {...register('manufacturerCode')}
          />
          <p className="text-[11px] text-slate-400 mt-1">
            {t("The supplier's own reference for this item. It is NOT your SKU and does not have to be unique: several products may share one, and an import that finds more than one match reports the collision instead of choosing.")}
          </p>
        </div>
      </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select label="Status" error={errors.status?.message} {...register('status')}>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
        </Select>
      </div>

      <div className="space-y-2 p-3 bg-slate-50 rounded-md border border-slate-100">
        <p className="text-[10px] font-semibold text-slate-500 uppercase">
          Categories {categoryIds.length === 0 && '— none selected: this item is unassigned'}
        </p>
        <p className="text-[11px] text-slate-500">
          The same item can be in several categories at once — it is still one item.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {availableCategories.map((cat) => (
            <label
              key={cat.id}
              className="inline-flex items-center gap-2 cursor-pointer select-none text-xs font-medium text-slate-700"
            >
              <input
                type="checkbox"
                checked={categoryIds.includes(cat.id)}
                onChange={() => toggleCategory(cat.id)}
                className="rounded text-primary focus:ring-primary"
              />
              {cat.archivedAt ? `[Archived] ${cat.name}` : cat.name}
            </label>
          ))}
        </div>
      </div>

      {isCard ? (
        <div className="space-y-1" data-testid="form-card-price">
          <Input
            type="number"
            step="0.01"
            label="Sorting price ($)"
            placeholder="0.00"
            error={errors.price?.message}
            {...register('price')}
          />
          <p className="text-[11px] text-slate-500">
            {t(
              'Used to place this card in listings and price filters. It is NEVER charged: each child product is sold at its own price.',
            )}
          </p>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-slate-400 -mb-2">
            {t('The company base price. A branch may charge something else — see "Set by each branch" below.')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              type="number"
              step="0.01"
              label="Regular Price ($)"
              placeholder="0.00"
              error={errors.price?.message}
              {...register('price')}
            />
            <Input
              type="number"
              step="0.01"
              label="Sale Price ($)"
              placeholder="No sale"
              error={errors.salePrice?.message}
              {...register('salePrice')}
            />
            <Input
              type="number"
              step="0.01"
              label="Cost ($) — internal"
              placeholder="Internal cost"
              error={errors.cost?.message}
              {...register('cost')}
            />
          </div>
        </>
      )}

      {!isCard && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
        <Input
          type="number"
          label="Opening stock"
          placeholder="0"
          error={errors.stockQuantity?.message}
          {...register('stockQuantity')}
        />
        <div className="flex items-center pt-4">
          <Checkbox label="Track Inventory" {...register('trackInventory')} />
        </div>
      </div>
      )}
      {!isCard && (
      <p className="text-[11px] text-slate-400 -mt-2" data-testid="form-stock-note">
        {t(
          'Stock is held by a BRANCH, never by the company as a whole. This is the opening figure; afterwards each branch holds its own units and what is sellable right now is worked out from the ledger.',
        )}
      </p>
      )}

      {/* What a card does NOT have, said rather than silently missing. */}
      {isCard && (
        <div className="p-3 bg-slate-50 rounded-md border border-slate-100 space-y-1" data-testid="form-card-note">
          <p className="text-[10px] font-semibold text-slate-500 uppercase">{t('This is a parent card')}</p>
          <p className="text-[11px] text-slate-500">
            {t(
              'A card is never sold, so it has no sale price, no cost, no stock and no inventory tracking, and it is never ordered from a supplier.',
            )}
          </p>
          <p className="text-[11px] text-slate-500">
            {t('Its shops are worked out from its child products, so they are not set here.')}
          </p>
        </div>
      )}

      {/*
        #282: a branch-scoped actor is shown the rule instead of a control it
        may not use. The controls are not merely disabled — `storeIds` is a
        WHOLE-COMPANY replacement, and offering a checkbox for something the
        endpoint will refuse is an interface that lies about who decides.

        The note claims nothing about which branches carry the item: a narrowed
        actor cannot see its siblings, so listing "the" branches here would be
        a half-truth. It states the one thing that is certainly true and is the
        operator's actual question — saving this form changes none of it.
      */}
      {!isCard && !canAssignStores && (
        <div
          className="space-y-1 p-3 bg-slate-50 rounded-md border border-slate-100"
          data-testid="form-branch-readonly"
        >
          <p className="text-[10px] font-semibold text-slate-500 uppercase">{t('Set by each branch')}</p>
          <p className="text-[11px] text-slate-500">
            {t(
              'Which branches carry this item, and the price each one charges, are set for the whole company and are not edited here.',
            )}
          </p>
          <p className="text-[11px] text-slate-500">
            {t('Saving this form leaves them exactly as they are.')}
          </p>
        </div>
      )}

      {!isCard && canAssignStores && (
      <div
        className="space-y-2 p-3 bg-slate-50 rounded-md border border-slate-100"
        data-testid="form-branch-section"
      >
        <p className="text-[10px] font-semibold text-slate-500 uppercase">{t('Set by each branch')}</p>
        <p className="text-[11px] text-slate-500">
          {t(
            'Which branches carry this item, and the price each one charges. Units held, publication, inventory tracking and lead time are also per branch and are edited on the item page, where the ledger figures are visible.',
          )}
        </p>
        <p className="text-[10px] font-semibold text-slate-500 uppercase pt-1">
          Visible in stores {storeIds.length === 0 && '— none selected: this product will appear on NO website'}
        </p>
        <div className="space-y-2">
          {activeStores.map((store) => (
            <div key={store.id} className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none text-xs font-medium text-slate-700 w-40">
                <input
                  type="checkbox"
                  checked={storeIds.includes(store.id)}
                  onChange={() => toggleStore(store.id)}
                  className="rounded text-primary focus:ring-primary"
                />
                {store.name}
              </label>
              {storeIds.includes(store.id) && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Price (base)"
                    title="Override price for this store — empty uses the base price"
                    value={storePriceMap[store.id]?.price ?? ''}
                    onChange={(e) => setOverride(store.id, 'price', e.target.value)}
                    className="w-28 px-2 py-1 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:border-primary"
                  />
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Sale (base)"
                    title="Override sale price for this store"
                    value={storePriceMap[store.id]?.salePrice ?? ''}
                    onChange={(e) => setOverride(store.id, 'salePrice', e.target.value)}
                    className="w-28 px-2 py-1 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:border-primary"
                  />
                </div>
              )}
            </div>
          ))}
          <p className="text-[10px] text-slate-400">
            Optional per-store price override — leave empty to use the product&apos;s base price. Variant prices are global.
          </p>
        </div>
      </div>
      )}

      <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          Save Product
        </Button>
      </div>
    </form>
  );
}
