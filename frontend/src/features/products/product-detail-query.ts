'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-client';
import { queryKeys } from '../../lib/query-client';
import { categoryQueryIdentity } from '../categories/category-queries';
import type { Product } from './types/product.types';
import type { FamilyView } from './components/product-family-panel';
import {
  catalogueDetailService,
  type EffectiveFieldValue,
  type FieldDefinition,
  type RelatedProduct,
} from './services/catalogue-detail.service';

export interface ProductImage {
  id: string;
  url: string;
  altText?: string;
  isPrimary: boolean;
  archivedAt?: string | null;
  sortOrder: number;
  displayMode?: string;
}

export function useProductImages(
  token: string,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  productId: string,
  includeArchived: boolean,
) {
  const identity = organizationId ? categoryQueryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: queryKeys.productImages(identity, productId, includeArchived),
    enabled: Boolean(token && organizationId && productId),
    queryFn: async (): Promise<ProductImage[]> => {
      const suffix = includeArchived ? '?includeArchived=true' : '';
      return (await apiFetch(`/products/${productId}/images${suffix}`, { method: 'GET', token }))?.data ?? [];
    },
  });
}

export interface ProductAuditEntry {
  id: string;
  actorEmail?: string | null;
  action: string;
  description?: string | null;
  createdAt: string;
}

export type FullProduct = Product & {
  images?: ProductImage[];
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  parent?: { id: string; name: string } | string | null;
  children?: Product[];
};

interface ProductDetailData {
  product: FullProduct;
  history: ProductAuditEntry[] | null;
  family: FamilyView | null;
  definitions: FieldDefinition[];
  effective: EffectiveFieldValue[];
  relations: RelatedProduct[];
}

async function familyFor(token: string, product: FullProduct): Promise<FamilyView | null> {
  if (product.children?.length) {
    return { parentId: product.id, parentName: product.name, members: product.children };
  }
  const parentId = typeof product.parent === 'string' ? product.parent : product.parent?.id;
  if (!parentId) return null;
  try {
    const response = await apiFetch(`/products/${parentId}`, { method: 'GET', token });
    const parent = response?.data;
    return parent
      ? { parentId: parent.id, parentName: parent.name, members: parent.children ?? [] }
      : null;
  } catch {
    return null;
  }
}

async function fetchProductDetail(token: string, id: string): Promise<ProductDetailData> {
  const [productResponse, auditResponse] = await Promise.all([
    apiFetch(`/products/${id}`, { method: 'GET', token }),
    apiFetch(`/audit-logs?entityType=PRODUCT&entityId=${id}&limit=30&sortBy=createdAt&sortDirection=desc`, {
      method: 'GET',
      token,
    }).catch(() => null),
  ]);
  const product = productResponse?.data as FullProduct | undefined;
  if (!product) throw new Error('ITEM_NOT_FOUND');

  const [family, definitions, effective, relations] = await Promise.all([
    familyFor(token, product),
    catalogueDetailService.listFieldDefinitions(token).catch(() => []),
    catalogueDetailService.listEffectiveValues(token, id).catch(() => []),
    catalogueDetailService.listRelations(token, id).catch(() => []),
  ]);
  return {
    product,
    history: auditResponse?.data ?? null,
    family,
    definitions,
    effective,
    relations,
  };
}

export function useProductDetail(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  productId: string | undefined,
) {
  const identity = organizationId ? categoryQueryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: queryKeys.productDetail(identity, productId ?? ''),
    enabled: Boolean(token && organizationId && productId),
    queryFn: () => fetchProductDetail(token as string, productId as string),
  });
}
