import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import { ES } from '../../../lib/translations.es';
import BillingPage from './page';

/**
 * PLAN GRATIS ON THE TENANT'S BILLING PAGE.
 *
 * A company on Plan Gratis sees its plan as free and is offered NOTHING to buy:
 * no card activation, no "pay by card" on another plan, no Plan Gratis card in
 * the list. The Básico control renders the same page with a paid plan and must
 * show those actions — it proves the selectors below would find them.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'manager-1', email: 'manager@example.com', role: 'ORGANIZATION_MANAGER', company: 'Acme' },
    scope: { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: ['store-1'] },
    accessToken: 'token',
  }),
}));
vi.mock('../../../lib/use-website-config', () => ({
  useStores: () => ({ stores: [], refresh: vi.fn(), loaded: true }),
}));

const TENANT_PLANS = [
  { key: 'BASICO', name: 'Básico', priceUsd: 30, maxWebsites: 1, maxTeamUsers: 3, offeredToTenants: true, complimentary: false },
  { key: 'CRECIMIENTO', name: 'Crecimiento', priceUsd: 50, maxWebsites: 3, maxTeamUsers: 10, offeredToTenants: true, complimentary: false },
  { key: 'MULTIMARCA', name: 'Multimarca', priceUsd: 70, maxWebsites: 5, maxTeamUsers: 20, offeredToTenants: true, complimentary: false },
  { key: 'CORPORATIVO', name: 'Corporativo', priceUsd: null, maxWebsites: null, maxTeamUsers: null, offeredToTenants: true, complimentary: false },
];
const GRATIS_PLAN = { key: 'GRATIS', name: 'Plan Gratis', priceUsd: 0, maxWebsites: 1, maxTeamUsers: 3, offeredToTenants: false, complimentary: true };
const usage = { teamUsers: 1, maxTeamUsers: 3, websites: 1, maxWebsites: 1 };

let subscription: unknown;
let calls: { path: string; method: string; body: unknown }[] = [];
vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (path === '/stores/subscription') return { data: subscription };
    if (path === '/billing/stripe-info') return { data: { active: false } };
    if (path === '/billing/payments') return { data: [] };
    if (path === '/billing/checkout') return { data: { url: null } };
    return { data: null };
  },
}));

const gratisSubscription = (plans = TENANT_PLANS) => ({
  platformOwner: false,
  status: 'ACTIVE',
  plans,
  stripeManaged: false,
  planManagedByPlatform: true,
  plan: { key: 'GRATIS', name: 'Plan Gratis', priceUsd: 0, complimentary: true },
  usage,
});
const basicoSubscription = () => ({
  platformOwner: false,
  status: 'ACTIVE',
  plans: TENANT_PLANS,
  stripeManaged: false,
  planManagedByPlatform: false,
  plan: { key: 'BASICO', name: 'Básico', priceUsd: 30, complimentary: false },
  usage,
});

const page = () => renderComponent(<I18nProvider><BillingPage /></I18nProvider>);
const buttons = (r: { container: HTMLElement }) => Array.from(r.container.querySelectorAll('button')).map((b) => b.textContent ?? '');

describe('Billing page: Plan Gratis', () => {
  beforeEach(() => {
    calls = [];
    toast.success.mockReset();
    toast.error.mockReset();
  });
  afterEach(() => cleanupAll());

  it('shows "Plan Gratis" and "Free" — never "Plan Plan Gratis" and never a $0 price', async () => {
    subscription = gratisSubscription();
    const r = await page();
    expect(r.container.querySelector('[data-testid="billing-current-plan"]')?.textContent).toBe('Plan Gratis');
    expect(r.container.querySelector('[data-testid="billing-current-price"]')?.textContent).toBe('Free');
    expect(r.container.textContent).not.toContain('$0');
    expect(r.container.querySelector('[data-testid="billing-complimentary-note"]')).not.toBeNull();
  });

  it('offers nothing to buy: no card activation, no "Pay by card", no plan request, and no checkout request is made', async () => {
    subscription = gratisSubscription();
    const r = await page();
    expect(buttons(r).filter((label) => /Activate card payment|Pay by card|Manage payment/.test(label))).toEqual([]);
    expect(r.container.textContent).not.toContain('Request this plan');
    expect(r.container.querySelector('[data-testid="billing-plan-managed-note"]')).not.toBeNull();
    expect(calls.filter((c) => c.path === '/billing/checkout' || c.path === '/billing/portal')).toEqual([]);
  });

  it('never lists Plan Gratis as a choice — even if a response wrongly included it', async () => {
    subscription = gratisSubscription([...TENANT_PLANS, GRATIS_PLAN]);
    const r = await page();
    const options = Array.from(r.container.querySelectorAll('[data-testid^="billing-plan-option-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(options).toEqual([
      'billing-plan-option-BASICO',
      'billing-plan-option-CRECIMIENTO',
      'billing-plan-option-MULTIMARCA',
      'billing-plan-option-CORPORATIVO',
    ]);
  });

  it('CONTROL — a Básico company still sees and uses its card actions', async () => {
    subscription = basicoSubscription();
    const r = await page();
    expect(r.container.querySelector('[data-testid="billing-current-plan"]')?.textContent).toBe('Plan Básico');
    const labels = buttons(r);
    expect(labels.some((label) => /Activate card payment/.test(label))).toBe(true);
    expect(labels.filter((label) => /Pay by card/.test(label)).length).toBe(2);
    expect(r.container.querySelectorAll('[data-testid^="billing-plan-option-"]').length).toBe(4);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await click(Array.from(r.container.querySelectorAll('button')).find((b) => /Activate card payment/.test(b.textContent ?? '')) ?? null);
    expect(calls.filter((c) => c.path === '/billing/checkout').map((c) => c.body)).toEqual([{ plan: 'BASICO' }]);
    open.mockRestore();
  });

  it('reads in Spanish', () => {
    expect(ES['Free']).toBe('Gratis');
    expect(ES['Plan Gratis is assigned by Wegox and is never billed.']).toBeTruthy();
    expect(ES['To change your plan, contact your provider.']).toBeTruthy();
  });
});
