'use client';

import React from 'react';
import { ExternalLink } from 'lucide-react';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import Badge from '../../../components/ui/badge';
import Button from '../../../components/ui/button';
import { useT } from '../../../lib/i18n';

import type { Category } from '../types/category.types';

interface CategoryTableProps {
  categories: Category[];
  /** Ordinary category editing — SUPER_ADMIN, ORGANIZATION_MANAGER or ADMIN. */
  canManage: boolean;
  /**
   * Archive, restore and permanent delete.
   *
   * The categories controller has gated these with `isOrganizationAdministrator`
   * since Phase 4 — a category is shared by every store in the company — but
   * the panel offered them on `canManage`, so a branch admin saw three buttons
   * the API answers with 403. REQUIRED, never defaulted to `canManage`.
   */
  canArchive: boolean;
  onEdit: (category: Category) => void;
  onArchive: (category: Category) => void;
  onRestore: (category: Category) => void;
  /** #292: recoverable removal replaced the permanent delete. */
  /** Returns the public website URL for an active category, or null when unavailable */
  websiteUrlFor?: (slug: string) => string | null;
}

export default function CategoryTable({
  categories,
  canManage,
  canArchive,
  onEdit,
  onArchive,
  onRestore,
  websiteUrlFor,
}: CategoryTableProps) {
  const t = useT();
  if (categories.length === 0) {
    return (
      <EmptyState
        message="No categories found."
        hint="Create your first category to start organizing the catalogue."
      />
    );
  }

  return (
    <Table>
      <THead>
        <TH>{t('Name')}</TH>
        <TH>{t('Slug')}</TH>
        <TH>{t('Description')}</TH>
        <TH>{t('Parent Category')}</TH>
        <TH>{t('Order')}</TH>
        <TH>{t('Type')}</TH>
        {(canManage || canArchive) && <TH align="right">{t('Actions')}</TH>}
      </THead>
      <TBody>
        {categories.map((category) => (
          <TR key={category.id} className="hover:bg-slate-50 transition-colors">
            <TD className="font-medium text-slate-900">
              <span className="inline-flex items-center gap-1.5">
                {category.name}
                {!category.archivedAt && websiteUrlFor?.(category.slug) && (
                  <a
                    href={websiteUrlFor(category.slug)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('View on website')}
                    className="text-slate-300 hover:text-primary transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </span>
              {category.archivedAt && (
                <Badge variant="danger" className="ml-2">
                  Archived
                </Badge>
              )}
            </TD>
            <TD>
              <code className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                {category.slug}
              </code>
            </TD>
            <TD className="truncate max-w-xs text-slate-600">{category.description || '-'}</TD>
            <TD className="text-slate-600">
              {category.parentCategory ? (
                category.parentCategory.archivedAt ? (
                  <span className="text-slate-400 italic">[Archived] {category.parentCategory.name}</span>
                ) : (
                  category.parentCategory.name
                )
              ) : (
                <span className="text-slate-400 italic">{t('None')}</span>
              )}
            </TD>
            {/* Phase 4: how the storefront presents this category. Absence is
                shown as absence — no invented label, order or classification. */}
            <TD className="text-slate-600 whitespace-nowrap">
              <span className="tabular-nums">{category.sortOrder ?? 0}</span>
              {category.showInNavigation === false && (
                <span className="ml-2 text-xs text-slate-400 italic">{t('Hidden from navigation')}</span>
              )}
            </TD>
            <TD className="text-slate-600">
              {category.kind ? (
                <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{category.kind}</span>
              ) : (
                <span className="text-slate-400 italic">-</span>
              )}
            </TD>
            {(canManage || canArchive) && (
              <TD align="right" className="whitespace-nowrap space-x-2">
                {!category.archivedAt && canManage && (
                  <Button size="sm" variant="secondary" tooltip={t('Edit name, description and SEO')} onClick={() => onEdit(category)}>
                    Edit
                  </Button>
                )}
                {!category.archivedAt && canArchive && (
                  <Button size="sm" variant="ghost" className="text-danger" tooltip={t('Hide category from the catalog (restorable)')} onClick={() => onArchive(category)}>
                    Archive
                  </Button>
                )}
                {category.archivedAt && canArchive && (
                  <Button size="sm" variant="secondary" tooltip={t('Bring category back to the catalog')} onClick={() => onRestore(category)}>
                    Restore
                  </Button>
                )}
                {/*
                  NOT gated on `archivedAt`: archiving was the permanent
                  delete's precondition, and removal is a different act.
                */}
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
