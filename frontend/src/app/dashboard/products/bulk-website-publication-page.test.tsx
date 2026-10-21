import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, select, flush } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';

/**
 * THE PAGE AROUND A COMPLETED WEBSITE PUBLICATION (ADR 029, review finding 8).
 *
 * The writes are done the moment the server answers. Reloading the list
 * afterwards is a separate act, and when it fails the page must keep the
 * result it already has, say that the RELOAD failed — not the publication —
 * and let nothing escape the handler as an unhandled rejection.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn(), undo: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));

const STORES = [
  { id: 'store-a', name: 'EliteToGo', slug: 'elite', archivedAt: null },
  { id: 'store-b', name: 'Norte', slug: 'norte', archivedAt: null },
];
vi.mock('../../../lib/use-website-config', () => ({
  useStores: () => ({ stores: STORES }),
  buildWebsiteUrl: () => 'https://example.test',
}));
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'manager@elite.example', role: 'ORGANIZATION_MANAGER' },
    scope: {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: 'org-1',
      storeId: null,
      allowedStoreIds: ['store-a', 'store-b'],
    },
    accessToken: 'token',
  }),
}));

const PRODUCTS = [
  {
    id: 'p-1',
    name: 'Cuaderno',
    slug: 'cuaderno',
    status: 'PUBLISHED',
    price: 10,
    branchLinks: [{ store: 'store-a', published: false }],
    stores: [{ id: 'store-a', name: 'EliteToGo', slug: 'elite' }],
  },
  {
    id: 'p-2',
    name: 'Lápiz',
    slug: 'lapiz',
    status: 'PUBLISHED',
    price: 3,
    branchLinks: [{ store: 'store-a', published: false }],
    stores: [{ id: 'store-a', name: 'EliteToGo', slug: 'elite' }],
  },
];

let calls: { path: string; method: string; body: any }[] = [];
let publicationDone = false;
vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith('/products?')) {
      // The reload AFTER the publication is the one that fails.
      if (publicationDone) throw new Error('network down');
      return { items: PRODUCTS, totalPages: 1, total: PRODUCTS.length };
    }
    if (path.startsWith('/categories')) return { items: [] };
    if (path.startsWith('/products/family-suggestions')) return { data: [], readyCount: 0, blockedCount: 0 };
    if (path === '/bulk/products/branch-publication') {
      publicationDone = true;
      const body = JSON.parse(init!.body!);
      return {
        storeId: body.storeId,
        published: body.published,
        updatedCount: body.ids.length,
        unchangedCount: 0,
        skippedParentCount: 0,
        failedCount: 0,
        outcomes: body.ids.map((id: string) => ({ id, outcome: 'UPDATED', globalStatus: 'PUBLISHED' })),
      };
    }
    return { data: null };
  },
}));

import ProductsPage from './page';

describe('the Items page after a website publication whose list reload fails', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    calls = [];
    publicationDone = false;
    toast.success.mockReset();
    toast.error.mockReset();
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    cleanupAll();
  });

  it('keeps the completed result, names the failed reload for what it is, and rejects nothing unhandled', async () => {
    window.history.replaceState({}, '', '/dashboard/products');
    const r = await renderComponent(
      <I18nProvider>
        <ProductsPage />
      </I18nProvider>,
    );
    await flush();
    await flush();
    expect(r.all('branch-state-')).toHaveLength(0); // no branch filter yet — the badge is not shown
    expect(r.find('select-all-on-page')).not.toBeNull();

    await click(r.get('select-all-on-page'));
    await flush();
    await click(r.get('bulk-website-publication'));
    await flush();
    await select(r.get('wp-store'), 'store-a');
    await click(r.get('wp-publish'));
    await click(r.get('wp-submit'));
    for (let i = 0; i < 4; i += 1) await flush();

    // The request went out exactly once, for both selected ids.
    const posts = calls.filter((c) => c.path === '/bulk/products/branch-publication');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ ids: ['p-1', 'p-2'], storeId: 'store-a', published: true });

    // The result survived the failed reload and says the reload failed.
    expect(r.get('wp-updated').textContent).toBe('Updated: 2');
    expect(r.get('wp-failed').textContent).toBe('Failed: 0');
    expect(r.get('wp-refresh-failed').textContent).toContain('could not be refreshed');
    expect(r.find('wp-error')).toBeNull(); // no request failure — the operation itself completed

    // The success was announced as a success; the reload failure separately.
    expect(toast.success).toHaveBeenCalledWith('Website publication: 2 updated, 0 unchanged, 0 skipped, 0 failed');
    expect(toast.error).toHaveBeenCalledWith('The list could not be refreshed; the website publication itself completed.');
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/could not be completed/));

    // Nothing escaped the handler.
    expect(unhandled).toEqual([]);
  });
});
