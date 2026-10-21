'use client';

import React from 'react';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Input from '../../../components/ui/input';
import Textarea from '../../../components/ui/textarea';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import { apiFetch } from '../../../lib/api-client';
import { canArchiveCatalogueItem, type SessionScope } from '../../../lib/permissions';
import type { Product } from '../types/product.types';

/** The four fields the contract localizes, named once. */
export const LOCALIZED_FIELDS = ['name', 'description', 'metaTitle', 'metaDescription'] as const;
export type LocalizedField = (typeof LOCALIZED_FIELDS)[number];

/** One stored side row, exactly as `GET .../translations` returns it. */
export interface ProductTranslation {
  locale: string;
  name?: string | null;
  description?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
}

export type FieldSource = 'TRANSLATED' | 'SAME_LANGUAGE' | 'CANONICAL' | 'ABSENT';

export interface FieldResolution {
  field: LocalizedField;
  /** What a reader of this locale actually sees. */
  value: string;
  /** The canonical (Spanish) text, always shown beside the value. */
  canonical: string;
  source: FieldSource;
  /** The locale the value came from, when it did not come from this one. */
  from: string | null;
}

const FIELD_LABELS: Record<LocalizedField, string> = {
  name: 'Name',
  description: 'Description',
  metaTitle: 'SEO Title',
  metaDescription: 'SEO Description',
};

const language = (tag: string): string => tag.split('-')[0].toLowerCase();

const stored = (row: ProductTranslation | null | undefined, field: LocalizedField): string | null => {
  const value = row?.[field];
  return typeof value === 'string' && value !== '' ? value : null;
};

/**
 * The canonical copy of a product: its own base columns (ADR 016 §2).
 *
 * There is exactly ONE product record. These columns ARE the Spanish copy, so
 * they are never a "translation into Spanish" and never a second product.
 */
export function canonicalCopy(product: Product): Record<LocalizedField, string> {
  return {
    name: product.name ?? '',
    description: product.description ?? '',
    metaTitle: product.metaTitle ?? '',
    metaDescription: product.metaDescription ?? '',
  };
}

/**
 * What a reader of `locale` sees, FIELD BY FIELD.
 *
 * Mirrors the server's `resolveLocalizedText`: this locale's own text, else a
 * stored row in the same language (`pt-BR` accepts `pt`), else the canonical
 * copy, else absent for an optional field. Resolving per field is the whole
 * point — a row translating only the name is normal, and the panel has to say
 * which of the four the reader is getting in their language and which they are
 * getting in Spanish. Without that, an untranslated description looks
 * translated and nobody ever finishes the work.
 */
export function resolveLocale(
  locale: string,
  translations: ProductTranslation[],
  canonical: Record<LocalizedField, string>,
): FieldResolution[] {
  const exact = translations.find((row) => row.locale === locale) ?? null;
  const sibling =
    translations
      .filter((row) => row.locale !== locale && language(row.locale) === language(locale))
      .sort((a, b) => a.locale.localeCompare(b.locale))[0] ?? null;

  return LOCALIZED_FIELDS.map((field) => {
    const own = stored(exact, field);
    if (own !== null) return { field, value: own, canonical: canonical[field], source: 'TRANSLATED' as const, from: locale };
    const inherited = stored(sibling, field);
    if (inherited !== null) {
      return { field, value: inherited, canonical: canonical[field], source: 'SAME_LANGUAGE' as const, from: sibling!.locale };
    }
    return {
      field,
      value: canonical[field],
      canonical: canonical[field],
      // An optional field with no canonical text stays absent rather than
      // borrowing another language's words.
      source: canonical[field] === '' ? ('ABSENT' as const) : ('CANONICAL' as const),
      from: null,
    };
  });
}

/**
 * Roles the contract admits as READERS (`TRANSLATION_READ_ROLES` on
 * `ProductTranslationsController`). A VIEWER is not one of them, so the panel
 * does not render at all rather than fetching a 403 and reporting it as though
 * the company had no translations.
 */
const READ_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR'];

/**
 * WRITING is organization-wide authority, and `canArchiveCatalogueItem` already
 * IS that predicate — company in scope, not narrowed, SUPER_ADMIN or
 * ORGANIZATION_MANAGER — which is exactly what `TranslationsService.assertOrgWide`
 * plus `TRANSLATION_WRITE_ROLES` enforce. It is aliased rather than restated so
 * the two cannot drift apart: catalogue copy is shared by every branch, so a
 * narrowed actor rewriting it would change what its siblings publish.
 */
const canEditTranslations = canArchiveCatalogueItem;

type Draft = Record<LocalizedField, string>;

const draftFrom = (row: ProductTranslation | null): Draft => ({
  name: row?.name ?? '',
  description: row?.description ?? '',
  metaTitle: row?.metaTitle ?? '',
  metaDescription: row?.metaDescription ?? '',
});

export interface ProductTranslationsPanelProps {
  product: Product;
  accessToken: string | null;
  /** The RESOLVED scope. Authority is derived from it and from nothing else. */
  scope: SessionScope | null | undefined;
  onChanged?: () => void;
}

/**
 * The product's copy in other languages (Phase 8 WS-2).
 *
 * SPANISH-FIRST, ONE PRODUCT. The base columns are the canonical copy and a
 * translation is a narrow side row per locale — never a second product. The
 * server refuses an all-null row, a blank string, and a row for the company's
 * own canonical locale, so this panel offers none of the three.
 *
 * The canonical text sits beside every field on purpose. Fallback is per field,
 * so the honest reading of "the German description" is usually "the Spanish
 * description", and a panel that hid that would make partial translations look
 * complete.
 */
export default function ProductTranslationsPanel({
  product,
  accessToken,
  scope,
  onChanged,
}: ProductTranslationsPanelProps) {
  const t = useT();
  const toast = useToast();
  const canEdit = canEditTranslations(scope);
  const mayRead = !!scope && READ_ROLES.includes(scope.role) && !!scope.organizationId;

  const [translations, setTranslations] = React.useState<ProductTranslation[]>([]);
  const [canonicalLocale, setCanonicalLocale] = React.useState('es');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<{ locale: string; draft: Draft } | null>(null);
  const [newLocale, setNewLocale] = React.useState('');

  const canonical = React.useMemo(() => canonicalCopy(product), [product]);

  const load = React.useCallback(async () => {
    if (!accessToken || !mayRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await apiFetch(`/products/${product.id}/translations`, { token: accessToken });
      const payload = response?.data ?? {};
      setTranslations(Array.isArray(payload.translations) ? payload.translations : []);
      if (typeof payload.canonicalLocale === 'string' && payload.canonicalLocale) {
        setCanonicalLocale(payload.canonicalLocale);
      }
      setError(null);
    } catch (err: any) {
      setError(err?.message || t('Could not load the translations'));
    } finally {
      setLoading(false);
    }
  }, [accessToken, mayRead, product.id, t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const locales = React.useMemo(
    () => [...translations].map((row) => row.locale).sort((a, b) => a.localeCompare(b)),
    [translations],
  );

  const guard = (): boolean => {
    // The handler asks the same question the control did: a hidden control is
    // not a closed door.
    if (!canEdit || !accessToken) {
      toast.error(t('You do not have permission to do this.'));
      return false;
    }
    return true;
  };

  const startEditing = (locale: string) =>
    setEditing({ locale, draft: draftFrom(translations.find((row) => row.locale === locale) ?? null) });

  const addLocale = () => {
    if (!guard()) return;
    const wanted = newLocale.trim();
    if (!wanted) return;
    if (wanted.toLowerCase() === canonicalLocale.toLowerCase()) {
      toast.error(
        t('That is this company canonical language: edit the product itself rather than translating it into its own language.'),
      );
      return;
    }
    setNewLocale('');
    setEditing({ locale: wanted, draft: draftFrom(translations.find((row) => row.locale === wanted) ?? null) });
  };

  const save = async () => {
    if (!editing || !guard()) return;
    setBusy(true);
    try {
      // ONE locale per request: the path names it, and the body carries only
      // the four fields of that locale. Nothing else in the catalogue moves.
      await apiFetch(`/products/${product.id}/translations/${encodeURIComponent(editing.locale)}`, {
        token: accessToken as string,
        method: 'PUT',
        body: JSON.stringify(editing.draft),
      });
      toast.success(t('Translation saved'));
      setEditing(null);
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not save the translation'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (locale: string) => {
    if (!guard()) return;
    setBusy(true);
    try {
      await apiFetch(`/products/${product.id}/translations/${encodeURIComponent(locale)}`, {
        token: accessToken as string,
        method: 'DELETE',
      });
      toast.success(t('Translation removed; readers of that language see the Spanish copy again'));
      if (editing?.locale === locale) setEditing(null);
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not remove the translation'));
    } finally {
      setBusy(false);
    }
  };

  if (!mayRead) return null;

  const editor = editing ? (
    <div className="space-y-3" data-testid={`translation-editor-${editing.locale}`}>
      {resolveLocale(editing.locale, translations, canonical).map((row) => {
        const shared = {
          label: t(FIELD_LABELS[row.field]),
          'aria-label': t(FIELD_LABELS[row.field]),
          'data-testid': `translation-input-${editing.locale}-${row.field}`,
          value: editing.draft[row.field],
          onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setEditing({ ...editing, draft: { ...editing.draft, [row.field]: e.target.value } }),
        };
        return (
          <div key={row.field}>
            {row.field === 'description' || row.field === 'metaDescription' ? (
              <Textarea rows={3} {...shared} />
            ) : (
              <Input {...shared} />
            )}
            <p className="text-[11px] text-slate-400 mt-1">
              {t('Original')}: {row.canonical || '—'}
              {editing.draft[row.field].trim() === '' && ` — ${t('left empty, readers see the original')}`}
            </p>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Button size="sm" isLoading={busy} data-testid={`translation-save-${editing.locale}`} onClick={save}>
          {t('Save')}
        </Button>
        <Button size="sm" variant="ghost" data-testid="translation-cancel" onClick={() => setEditing(null)}>
          {t('Cancel')}
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <div className="card p-6" data-testid="translations-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h3 className="text-sm font-bold text-slate-800">{t('Other languages')}</h3>
        <Badge variant="info">{t('Written in {locale}', { locale: canonicalLocale })}</Badge>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        {t(
          'This is ONE product. What you typed on the product itself is the original copy; a translation only replaces the fields you fill in here. Anything you leave empty keeps showing the original, field by field.',
        )}
      </p>

      {!canEdit && (
        <p className="text-[11px] text-slate-400 mb-3" data-testid="translations-readonly">
          {t(
            'Catalogue copy belongs to the whole company, so it is read-only from inside a single branch. Leave branch context to change it.',
          )}
        </p>
      )}

      {error && (
        <p className="text-xs text-danger mb-3" data-testid="translations-error">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-xs text-slate-400" data-testid="translations-loading">
          {t('Loading...')}
        </p>
      ) : (
        <div className="space-y-4">
          {locales.length === 0 && !editing && (
            <p className="text-xs text-slate-400" data-testid="translations-empty">
              {t('This product is only in the original language.')}
            </p>
          )}

          {locales.map((locale) => (
            <div key={locale} className="border border-slate-100 rounded-md" data-testid={`translation-${locale}`}>
              <div className="px-3 py-2 flex items-center gap-3 flex-wrap bg-slate-50 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-700">{locale}</span>
                {canEdit && editing?.locale !== locale && (
                  <span className="flex items-center gap-1 ml-auto">
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid={`translation-edit-${locale}`}
                      onClick={() => startEditing(locale)}
                    >
                      {t('Edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      disabled={busy}
                      data-testid={`translation-remove-${locale}`}
                      onClick={() => remove(locale)}
                    >
                      {t('Remove')}
                    </Button>
                  </span>
                )}
              </div>
              {editing?.locale !== locale && (
                <ul className="divide-y divide-slate-100">
                  {resolveLocale(locale, translations, canonical).map((row) => (
                    <li
                      key={row.field}
                      className="px-3 py-2 flex items-start gap-3 flex-wrap"
                      data-testid={`translation-field-${locale}-${row.field}`}
                    >
                      <span className="text-[10px] font-semibold text-slate-500 uppercase w-32 shrink-0 pt-0.5">
                        {t(FIELD_LABELS[row.field])}
                      </span>
                      <span className="text-xs text-slate-800 flex-1 min-w-[8rem]" data-testid={`translation-value-${locale}-${row.field}`}>
                        {row.value || '—'}
                      </span>
                      {row.source === 'TRANSLATED' ? (
                        <span data-testid={`translation-mark-${locale}-${row.field}`}>
                          <Badge variant="success">{t('Translated')}</Badge>
                        </span>
                      ) : row.source === 'SAME_LANGUAGE' ? (
                        <span data-testid={`translation-sibling-${locale}-${row.field}`}>
                          <Badge variant="info">{t('From {locale}', { locale: row.from ?? '' })}</Badge>
                        </span>
                      ) : (
                        <span data-testid={`translation-inherited-${locale}-${row.field}`}>
                          <Badge variant="neutral">{t('Original copy')}</Badge>
                        </span>
                      )}
                      <span
                        className="text-[11px] text-slate-400 w-full pl-32"
                        data-testid={`translation-canonical-${locale}-${row.field}`}
                      >
                        {t('Original')}: {row.canonical || '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {editing?.locale === locale && <div className="p-3">{editor}</div>}
            </div>
          ))}

          {editing && !locales.includes(editing.locale) && (
            <div className="border border-slate-100 rounded-md" data-testid={`translation-${editing.locale}`}>
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-700">{editing.locale}</span>
              </div>
              <div className="p-3">{editor}</div>
            </div>
          )}

          {canEdit && !editing && (
            <div className="flex items-end gap-2" data-testid="translations-new">
              <Input
                label={t('Add a language')}
                aria-label={t('Add a language')}
                placeholder="en, pt-BR"
                value={newLocale}
                onChange={(e) => setNewLocale(e.target.value)}
              />
              <Button size="sm" data-testid="translations-add" onClick={addLocale}>
                {t('Add')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
