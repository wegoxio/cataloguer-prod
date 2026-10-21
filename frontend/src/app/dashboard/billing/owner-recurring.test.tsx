import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import BillingPage from './page';

/**
 * THE OWNER'S REVENUE ESTIMATE IS THE COMPANY-LEVEL TOTAL (#318).
 *
 * It used to add a price per branch record, and branch records carry no plan,
 * so it always said $0. It now shows the server's recurring total, where each
 * company is counted once. The branch list cannot move it.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => React.createElement('a', rest, children),
}));
vi.mock('../../../components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', role: 'SUPER_ADMIN' },
    scope: { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null, allowedStoreIds: [] },
    accessToken: 'token',
  }),
}));
let branches: unknown[] = [];
vi.mock('../../../lib/use-website-config', () => ({ useStores: () => ({ stores: branches, refresh: vi.fn(), loaded: true }) }));
vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string) => {
    if (path === '/stores/subscription') return { data: { platformOwner: true, status: 'ACTIVE' } };
    if (path === '/stores/overview') {
      return { data: { totals: { activeClients: 4, monthlyRecurringUsd: 80, recurringCompanies: 3, ordersThisMonth: 0, revenueThisMonth: 0 }, clients: [], plans: [] } };
    }
    return { data: null };
  },
}));

const branch = (id: string) => ({ id, name: `Branch ${id}`, archivedAt: null });

describe('Billing page: the owner revenue estimate (#318)', () => {
  afterEach(() => cleanupAll());

  it('shows the company-level recurring total and company count, unchanged by how many branches exist', async () => {
    for (const list of [[branch('a')], [branch('a'), branch('b'), branch('c'), branch('d')]]) {
      branches = list;
      const view = await renderComponent(<I18nProvider><BillingPage /></I18nProvider>);
      await new Promise((r) => setTimeout(r, 0));
      const estimate = view.container.querySelector('[data-testid="owner-recurring-revenue"]')?.textContent ?? '';
      expect(estimate).toContain('$80');
      expect(estimate).toContain('3 companies');
      cleanupAll();
    }
  });
});
