import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import ClientsPage from './page';

/**
 * PLAN GRATIS IN THE PLATFORM OWNER'S CLIENTS TABLE: clearly "Plan Gratis" and
 * "Free", never a "$0" price. The Básico row is the control for the price text.
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

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@wegox.com', role: 'SUPER_ADMIN' },
    scope: { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null, allowedStoreIds: [] },
    accessToken: 'token',
  }),
}));


const row = (id: string, plan: { key: string; name: string; priceUsd: number | null; complimentary?: boolean }) => ({
  id,
  organizationId: `org-${id}`,
  name: `Company ${id}`,
  slug: id,
  websiteUrl: null,
  plan,
  billingStatus: 'ACTIVE',
  enabledIntegrations: [],
  archivedAt: null,
  organizationArchivedAt: null,
  organizationMergedIntoId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  usersCount: 1,
  productsCount: 0,
  ordersThisMonth: 0,
  revenueThisMonth: 0,
  lastOrderAt: null,
  totalPaid: 0,
  lastPaymentAt: null,
});

vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string) => {
    if (path === '/stores/overview') {
      return {
        data: {
          totals: { activeClients: 2, monthlyRecurringUsd: 30, ordersThisMonth: 0, revenueThisMonth: 0 },
          clients: [
            row('gratis', { key: 'GRATIS', name: 'Plan Gratis', priceUsd: 0, complimentary: true }),
            row('basico', { key: 'BASICO', name: 'Básico', priceUsd: 30, complimentary: false }),
          ],
          plans: [],
        },
      };
    }
    return { data: null };
  },
}));

describe('Clients page: Plan Gratis', () => {
  afterEach(() => cleanupAll());

  it('labels the company "Plan Gratis" with a "Free" badge and no $0 price; a Básico company keeps its price', async () => {
    const r = await renderComponent(
      <I18nProvider>
        <ClientsPage />
      </I18nProvider>,
    );
    const gratis = r.container.querySelector('[data-testid="client-plan-gratis"]');
    expect(gratis?.textContent).toContain('Plan Gratis');
    expect(gratis?.textContent).toContain('Free');
    expect(gratis?.textContent).not.toContain('$');
    expect(r.container.querySelector('[data-testid="client-plan-basico"]')?.textContent).toContain('— $30');
  });
});
