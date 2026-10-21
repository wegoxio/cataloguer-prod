import { apiFetch } from '../../lib/api-client';
import type { Product, ProductFilterState } from './types/product.types';

export interface ProductListRequest {
  filters: ProductFilterState;
  page: number;
  limit?: number;
}

export interface ProductListResult {
  items: Product[];
  total: number;
  totalPages: number;
}

/** The canonical wire representation of the Items screen's filters. */
export function productListSearch({ filters: f, page, limit = 25 }: ProductListRequest): string {
  const params = new URLSearchParams();
  if (f.search) params.append('search', f.search);
  if (f.status) params.append('status', f.status);
  if (f.categoryId) params.append('categoryId', f.categoryId);
  if (f.trackInventory === 'low') params.append('lowStock', 'true');
  else if (f.trackInventory) params.append('trackInventory', f.trackInventory);
  if (f.hasChildren) params.append('hasChildren', f.hasChildren);
  if (f.family) params.append('family', f.family);
  if (f.storeId) params.append('storeId', f.storeId);
  if (f.storeId && f.branchPublished) params.append('branchPublished', f.branchPublished);
  if (f.showArchived) params.append('includeArchived', 'true');
  if (f.minPrice) params.append('minPrice', f.minPrice);
  if (f.maxPrice) params.append('maxPrice', f.maxPrice);
  if (f.hasSalePrice) params.append('hasSalePrice', f.hasSalePrice);
  if (f.hasImages) params.append('hasImages', f.hasImages);
  if (f.hasCategory) params.append('hasCategory', f.hasCategory);
  if (f.sellable) params.append('sellable', f.sellable);
  if (f.complete) params.append('complete', f.complete);
  params.append('sortBy', f.sortBy);
  params.append('sortDirection', f.sortDirection);
  params.append('page', String(page));
  params.append('limit', String(limit));
  return params.toString();
}

export async function fetchProductList(token: string, request: ProductListRequest): Promise<ProductListResult> {
  const response = await apiFetch(`/products?${productListSearch(request)}`, {
    method: 'GET',
    token,
  });
  return {
    items: response?.items ?? [],
    total: Number(response?.total) || 0,
    totalPages: Math.max(1, Number(response?.totalPages) || 1),
  };
}
