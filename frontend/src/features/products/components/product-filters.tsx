'use client';

import React, { useState } from 'react';
import { SlidersHorizontal, ChevronDown, ChevronUp } from 'lucide-react';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Checkbox from '../../../components/ui/checkbox';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import { useT } from '../../../lib/i18n';
import type { ProductFilterState } from '../types/product.types';
import type { CategoryRef } from '../../categories/types/category.types';

interface ProductFiltersProps {
  filters: ProductFilterState;
  categories: CategoryRef[];
  /** The company's branches, so the list can answer "what does Norte sell?". */
  stores?: { id: string; name: string; archivedAt?: string | null }[];
  onChange: (partial: Partial<ProductFilterState>) => void;
  onReset: () => void;
}

export default function ProductFilters({ filters, categories, stores = [], onChange, onReset }: ProductFiltersProps) {
  const t = useT();
  // Collapsed by default: only the search box + a "Filters" toggle show.
  const [open, setOpen] = useState(false);

  // Badge on the toggle so applied filters stay discoverable while collapsed
  const activeCount =
    [
      filters.status,
      filters.categoryId,
      filters.trackInventory,
      filters.hasChildren,
      filters.family,
      filters.storeId,
      filters.branchPublished,
      filters.minPrice,
      filters.maxPrice,
      filters.hasSalePrice,
      filters.hasImages,
      filters.hasCategory,
    ].filter(Boolean).length +
    (filters.showArchived ? 1 : 0) +
    (filters.sortBy !== 'createdAt' ? 1 : 0) +
    (filters.sortDirection !== 'desc' ? 1 : 0);

  return (
    <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-4 shadow-sm">
      <div className="flex gap-3 items-center">
        <Input
          placeholder={t('Search by name, slug, SKU or manufacturer code...')}
          aria-label={t('Search')}
          value={filters.search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="flex-1"
        />
        <Button
          variant="secondary"
          size="sm"
          tooltip={t('Show or hide the filters')}
          onClick={() => setOpen((o) => !o)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('Filters')}
          {activeCount > 0 && <Badge variant="info">{activeCount}</Badge>}
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {open && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 items-end">
            <Select label={t('Status')} value={filters.status} onChange={(e) => onChange({ status: e.target.value })}>
              <option value="">{t('All Statuses')}</option>
              <option value="DRAFT">{t('Draft')}</option>
              <option value="PUBLISHED">{t('Published')}</option>
            </Select>
            <Select
              label={t('Category')}
              value={filters.categoryId}
              onChange={(e) => onChange({ categoryId: e.target.value })}
            >
              <option value="">{t('All Categories')}</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </Select>
            <Select
              label={t('Inventory')}
              value={filters.trackInventory}
              onChange={(e) => onChange({ trackInventory: e.target.value })}
            >
              <option value="">{t('All Inventory')}</option>
              <option value="true">{t('Tracked')}</option>
              <option value="false">{t('Untracked')}</option>
              <option value="low">{t('Low stock (5 or fewer)')}</option>
            </Select>
            {/* Sellable NOW (the AVAILABLE ledger) — deliberately distinct
                from the owned figure the Inventory filter reads: units the
                company owns but cannot sell are exactly what this finds. */}
            <Select
              label={t('Availability')}
              value={filters.sellable}
              onChange={(e) => onChange({ sellable: e.target.value })}
            >
              <option value="">{t('Owned or not')}</option>
              <option value="true">{t('Sellable now')}</option>
              <option value="false">{t('Nothing sellable')}</option>
            </Select>
            <Select
              label={t('Completeness')}
              value={filters.complete}
              onChange={(e) => onChange({ complete: e.target.value })}
            >
              <option value="">{t('All completeness')}</option>
              <option value="false">{t('Missing required fields')}</option>
              <option value="true">{t('All required fields answered')}</option>
            </Select>
            <Select
              label={t('Parent and children')}
              value={filters.family}
              onChange={(e) => onChange({ family: e.target.value })}
            >
              <option value="">{t('All Items')}</option>
              <option value="parent">{t('Parent products')}</option>
              <option value="child">{t('Child products')}</option>
              <option value="standalone">{t('Standalone products')}</option>
            </Select>
            {stores.filter((store) => !store.archivedAt).length > 1 && (
              <Select
                label={t('Branch')}
                value={filters.storeId}
                // A publication state belongs to ONE branch; clearing the branch
                // clears it rather than leaving a filter that means nothing.
                onChange={(e) =>
                  onChange({ storeId: e.target.value, branchPublished: e.target.value ? filters.branchPublished : '' })
                }
              >
                <option value="">{t('Every branch')}</option>
                {stores
                  .filter((store) => !store.archivedAt)
                  .map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
              </Select>
            )}
            {filters.storeId && (
              /* Published or hidden ON that branch (ADR 029). Both answers mean
                 "a member of that branch": a product not on it matches neither,
                 so "select all matching" never reaches one a bulk publish would
                 have to add first. */
              <Select
                label={t('Branch publication')}
                value={filters.branchPublished}
                data-testid="filter-branch-published"
                onChange={(e) => onChange({ branchPublished: e.target.value })}
              >
                <option value="">{t('Published or hidden here')}</option>
                <option value="true">{t('Published here')}</option>
                <option value="false">{t('Hidden here')}</option>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 items-end">
            <Input
              type="number"
              step="0.01"
              label={t('Min Price')}
              placeholder="0.00"
              value={filters.minPrice}
              onChange={(e) => onChange({ minPrice: e.target.value })}
            />
            <Input
              type="number"
              step="0.01"
              label={t('Max Price')}
              placeholder="0.00"
              value={filters.maxPrice}
              onChange={(e) => onChange({ maxPrice: e.target.value })}
            />
            <Select
              label={t('Sale Price')}
              value={filters.hasSalePrice}
              onChange={(e) => onChange({ hasSalePrice: e.target.value })}
            >
              <option value="">{t('All Pricing')}</option>
              <option value="true">{t('On Sale')}</option>
              <option value="false">{t('Regular Price')}</option>
            </Select>
            <Select
              label={t('Images')}
              value={filters.hasImages}
              onChange={(e) => onChange({ hasImages: e.target.value })}
            >
              <option value="">{t('All Images')}</option>
              <option value="true">{t('Has Images')}</option>
              <option value="false">{t('No Images')}</option>
            </Select>
            <Select
              label={t('Category Presence')}
              value={filters.hasCategory}
              onChange={(e) => onChange({ hasCategory: e.target.value })}
            >
              <option value="">{t('All Items')}</option>
              <option value="true">{t('Has Category')}</option>
              <option value="false">{t('Unassigned')}</option>
            </Select>
            <Select label={t('Sort By')} value={filters.sortBy} onChange={(e) => onChange({ sortBy: e.target.value })}>
              <option value="createdAt">{t('Created At')}</option>
              <option value="name">{t('Name')}</option>
              <option value="price">{t('Price')}</option>
            </Select>
            <Select
              label={t('Sort Order')}
              value={filters.sortDirection}
              onChange={(e) => onChange({ sortDirection: e.target.value as 'asc' | 'desc' })}
            >
              <option value="desc">{t('Descending')}</option>
              <option value="asc">{t('Ascending')}</option>
            </Select>
          </div>

          <div className="flex justify-end gap-4 items-center pt-2 border-t border-slate-100">
            <Checkbox
              label={t('Show Archived')}
              checked={filters.showArchived}
              onChange={(e) => onChange({ showArchived: e.target.checked })}
            />
            <Button variant="secondary" size="sm" tooltip={t('Clear all filters and show everything')} onClick={onReset}>
              {t('Reset Filters')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
