import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, type, flush, cleanupAll } from '../../../test/render';
import ProductTranslationsPanel, {
  canonicalCopy,
  resolveLocale,
  type ProductTranslation,
} from './product-translations-panel';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { Product } from '../types/product.types';

const fetchMock = vi.fn();
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

const ORG = 'org-1';
const scopeFor = (overrides: Partial<SessionScope>): SessionScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: ['store-a'],
  ...overrides,
});

const MANAGER = scopeFor({});
const BRANCH_ADMIN = scopeFor({ role: 'ADMIN', storeId: 'store-a' });
const NARROWED_MANAGER = scopeFor({ storeId: 'store-a' });

/** The canonical copy: the product's own columns, in Spanish (ADR 016 §2). */
const PRODUCT: Product = {
  id: 'p-1',
  name: 'Silla de roble',
  slug: 'silla-de-roble',
  status: 'PUBLISHED',
  description: 'Hecha a mano en roble macizo',
  metaTitle: 'Silla de roble | Tienda',
  metaDescription: 'Una silla de roble macizo',
};

// Only the name is translated: a partial row is the normal case, and the
// remaining three fields must read as the Spanish copy rather than as English.
const TRANSLATIONS: ProductTranslation[] = [
  { locale: 'en', name: 'Oak chair', description: null, metaTitle: null, metaDescription: null },
];

const listPayload = (translations: ProductTranslation[] = TRANSLATIONS) => ({
  data: { canonicalLocale: 'es', translations },
});

const panel = (props: Partial<React.ComponentProps<typeof ProductTranslationsPanel>> = {}) => (
  <I18nProvider>
    <ToastProvider>
      <ProductTranslationsPanel product={PRODUCT} accessToken="token" scope={MANAGER} {...props} />
    </ToastProvider>
  </I18nProvider>
);

const mounted = async (props: Partial<React.ComponentProps<typeof ProductTranslationsPanel>> = {}) => {
  const view = await renderComponent(panel(props));
  await flush();
  return view;
};

const callsWithMethod = (method: string) =>
  fetchMock.mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === method);

describe('per-field fallback resolution (ADR 016 §2)', () => {
  const canonical = canonicalCopy(PRODUCT);

  it('takes the translated field and leaves the other three canonical', () => {
    const rows = resolveLocale('en', TRANSLATIONS, canonical);
    expect(rows.map((row) => [row.field, row.source, row.value])).toEqual([
      ['name', 'TRANSLATED', 'Oak chair'],
      ['description', 'CANONICAL', 'Hecha a mano en roble macizo'],
      ['metaTitle', 'CANONICAL', 'Silla de roble | Tienda'],
      ['metaDescription', 'CANONICAL', 'Una silla de roble macizo'],
    ]);
  });

  it('accepts a stored row in the same language before falling back to Spanish', () => {
    const rows = resolveLocale('pt-BR', [{ locale: 'pt', name: 'Cadeira de carvalho' }], canonical);
    expect(rows[0]).toMatchObject({ source: 'SAME_LANGUAGE', from: 'pt', value: 'Cadeira de carvalho' });
    expect(rows[1]).toMatchObject({ source: 'CANONICAL' });
  });

  it('leaves an optional field absent when the canonical copy has none either', () => {
    const bare = canonicalCopy({ ...PRODUCT, description: undefined, metaTitle: null, metaDescription: null });
    const rows = resolveLocale('en', TRANSLATIONS, bare);
    expect(rows.filter((row) => row.source === 'ABSENT').map((row) => row.field)).toEqual([
      'description',
      'metaTitle',
      'metaDescription',
    ]);
  });
});

describe('product translations panel (Phase 8 WS-2)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(listPayload());
  });
  afterEach(() => cleanupAll());

  it('reads the stored translations of THIS product, once', async () => {
    await mounted();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/products/p-1/translations');
  });

  it('shows the canonical text for a field nobody translated, and says where it came from', async () => {
    const view = await mounted();
    expect(view.get('translation-value-en-description').textContent).toBe('Hecha a mano en roble macizo');
    expect(view.find('translation-inherited-en-description')).not.toBeNull();
    expect(view.find('translation-mark-en-description')).toBeNull();
    // The original sits beside the field, so the fallback is legible without
    // opening the product itself.
    expect(view.get('translation-canonical-en-description').textContent).toMatch(/Hecha a mano en roble macizo/);
  });

  it('marks a field that IS translated as translated', async () => {
    const view = await mounted();
    expect(view.get('translation-value-en-name').textContent).toBe('Oak chair');
    expect(view.find('translation-mark-en-name')).not.toBeNull();
    expect(view.find('translation-inherited-en-name')).toBeNull();
  });

  it('gives a branch admin the copy but no way to change it', async () => {
    const view = await mounted({ scope: BRANCH_ADMIN });
    expect(view.get('translation-value-en-name').textContent).toBe('Oak chair');
    expect(view.find('translations-readonly')).not.toBeNull();
    expect(view.find('translation-edit-en')).toBeNull();
    expect(view.find('translation-remove-en')).toBeNull();
    expect(view.find('translations-add')).toBeNull();
  });

  it('takes the editing controls away from a NARROWED manager too', async () => {
    // Narrowing binds: inside one branch the manager is acting as that branch,
    // and catalogue copy is shared by all of them.
    const view = await mounted({ scope: NARROWED_MANAGER });
    expect(view.find('translation-edit-en')).toBeNull();
    expect(view.find('translations-add')).toBeNull();
  });

  it('saves one locale with a PUT that names only that locale', async () => {
    const view = await mounted();
    await click(view.get('translation-edit-en'));
    await type(view.get('translation-input-en-name'), 'Solid oak chair');
    await click(view.get('translation-save-en'));

    const puts = callsWithMethod('PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/products/p-1/translations/en');
    expect(JSON.parse((puts[0][1] as { body: string }).body)).toEqual({
      name: 'Solid oak chair',
      description: '',
      metaTitle: '',
      metaDescription: '',
    });
  });

  it('never writes the canonical locale: it offers the product itself instead', async () => {
    const view = await mounted();
    await type(view.get('translations-new').querySelector('input'), 'es');
    await click(view.get('translations-add'));
    expect(view.find('translation-editor-es')).toBeNull();
    expect(callsWithMethod('PUT')).toHaveLength(0);
  });

  it('refuses a write triggered after the scope loses authority', async () => {
    const view = await mounted();
    await click(view.get('translation-edit-en'));
    const save = view.get('translation-save-en');
    await view.rerender(panel({ scope: BRANCH_ADMIN }));
    fetchMock.mockClear();
    await click(save);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
