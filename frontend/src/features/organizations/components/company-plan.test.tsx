import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, select } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import ActiveCompaniesCard from './active-companies-card';

/**
 * THE COMPANY PLAN CONTROL (#318).
 *
 * The current plan shown is the company's own, from the company list. Plan
 * Gratis states what it means before it is saved. Exactly one company-route
 * write happens on save. Without owner authority there is no control at all.
 */
const calls: { path: string; method: string; body?: unknown }[] = [];
let companies: unknown[];
vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith('/organizations?includeArchived=true')) return { data: companies };
    return { data: { id: 'ok' } };
  },
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));

const PLANS = [
  { key: 'BASICO', name: 'Básico', priceUsd: 30, maxWebsites: 1, maxTeamUsers: 3, complimentary: false },
  { key: 'CRECIMIENTO', name: 'Crecimiento', priceUsd: 50, maxWebsites: 3, maxTeamUsers: 10, complimentary: false },
  { key: 'MULTIMARCA', name: 'Multimarca', priceUsd: 70, maxWebsites: 5, maxTeamUsers: 20, complimentary: false },
  { key: 'CORPORATIVO', name: 'Corporativo', priceUsd: null, maxWebsites: null, maxTeamUsers: null, complimentary: false },
  { key: 'GRATIS', name: 'Plan Gratis', priceUsd: 0, maxWebsites: 1, maxTeamUsers: 3, complimentary: true },
];
const base = { slug: 's', billingStatus: 'ACTIVE', archivedAt: null, mergedIntoOrganizationId: null };
const flush = () => new Promise((r) => setTimeout(r, 0));
const render = async (canManagePlan: boolean) => {
  const onPlanChanged = vi.fn();
  const view = await renderComponent(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ActiveCompaniesCard, { accessToken: 't', canManagePlan, plans: PLANS, onPlanChanged }),
    ),
  );
  await flush();
  await flush();
  return { ...view, onPlanChanged };
};
const q = (view: { container: HTMLElement }, id: string) => view.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('ActiveCompaniesCard — the company plan control (#318)', () => {
  beforeEach(() => {
    cleanupAll();
    calls.length = 0;
    toast.success.mockReset();
    toast.error.mockReset();
    companies = [
      { ...base, id: 'org-basico', name: 'Two Branch SA', plan: 'BASICO', liveStoreCount: 2 },
      { ...base, id: 'org-gratis', name: 'Free Co', plan: 'GRATIS', liveStoreCount: 1 },
      { ...base, id: 'org-empty', name: 'No Branch Ltd', plan: 'CRECIMIENTO', liveStoreCount: 0 },
    ];
  });

  it("shows each company's ACTUAL plan, from the company record, whatever its branch count", async () => {
    const view = await render(true);
    expect(q(view, 'active-company-plan-org-basico')?.textContent).toBe('Básico — $30/month');
    expect(q(view, 'active-company-plan-org-gratis')?.textContent).toBe('Plan Gratis — Free');
    expect(q(view, 'active-company-plan-org-empty')?.textContent).toBe('Crecimiento — $50/month');
  });

  it('opens on the current plan, explains Plan Gratis, and writes exactly once to the COMPANY route', async () => {
    const view = await render(true);
    await click(q(view, 'change-plan-org-basico'));
    expect(q(view, 'company-plan-current')?.textContent).toContain('Básico — $30/month');
    const selector = view.container.querySelector<HTMLSelectElement>('#company-plan-select')!;
    expect(selector.value).toBe('BASICO');
    expect((q(view, 'company-plan-save') as HTMLButtonElement).disabled).toBe(true);
    expect(q(view, 'company-plan-gratis-notice')).toBeNull();

    await select(selector, 'GRATIS');
    const notice = q(view, 'company-plan-gratis-notice')?.textContent ?? '';
    for (const line of ['Free', 'Same limits as Básico', 'No card subscription required', 'Applies to the entire company and all its branches']) {
      expect(notice).toContain(line);
    }
    await click(q(view, 'company-plan-save'));
    await flush();
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toEqual([{ path: '/organizations/org-basico', method: 'PATCH', body: { plan: 'GRATIS' } }]);
    expect(view.onPlanChanged).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalled();
  });

  it('opens on THAT company\'s plan, not on the first plan in the catalogue', async () => {
    const view = await render(true);
    await click(q(view, 'change-plan-org-empty'));
    expect(q(view, 'company-plan-current')?.textContent).toContain('Crecimiento — $50/month');
    expect(view.container.querySelector<HTMLSelectElement>('#company-plan-select')!.value).toBe('CRECIMIENTO');
  });

  it('without platform-owner authority there is no plan control and no write', async () => {
    const view = await render(false);
    expect(view.container.querySelector('[data-testid^="change-plan-"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Change plan');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});
