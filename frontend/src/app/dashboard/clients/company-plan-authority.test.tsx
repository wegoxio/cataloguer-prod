import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import ClientsPage from './page';

/**
 * ONLY THE UNSCOPED PLATFORM OWNER SEES THE COMPANY PLAN CONTROL (#318).
 *
 * A Superadmin working inside a managed company, and every tenant role, get
 * no Clients page: no overview read, no company list, no plan control and no
 * write. The server refuses them independently; this proves they are never offered it.
 */
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
// Forward EVERY prop: a mock that keeps only href silently drops data-testid.
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));

const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));


let scope: Record<string, unknown>;
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'user@example.com', role: scope.role }, scope, accessToken: 'token' }),
}));
const calls: { path: string; method: string }[] = [];
vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    return { data: null };
  },
}));

const SCOPES: Record<string, Record<string, unknown>> = {
  'managed Superadmin': { platform: true, role: 'SUPER_ADMIN', organizationId: 'org-1', storeId: null, allowedStoreIds: ['s-1'] },
  'Organization Manager': { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: ['s-1'] },
  'branch Admin': { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: 's-1', allowedStoreIds: ['s-1'] },
  Editor: { platform: false, role: 'EDITOR', organizationId: 'org-1', storeId: 's-1', allowedStoreIds: ['s-1'] },
  Viewer: { platform: false, role: 'VIEWER', organizationId: 'org-1', storeId: 's-1', allowedStoreIds: ['s-1'] },
};

describe('Clients page: the company plan control is the unscoped owner\'s alone', () => {
  afterEach(() => cleanupAll());

  for (const [label, s] of Object.entries(SCOPES)) {
    it(`${label}: no control, no company or overview read, no write`, async () => {
      scope = s;
      calls.length = 0;
      const view = await renderComponent(<I18nProvider><ClientsPage /></I18nProvider>);
      await new Promise((r) => setTimeout(r, 0));
      expect(view.container.querySelector('[data-testid^="change-plan-"]')).toBeNull();
      expect(view.container.querySelector('#company-plan-select')).toBeNull();
      expect(calls.filter((c) => c.path.startsWith('/organizations') || c.path === '/stores/overview')).toEqual([]);
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });
  }
});
