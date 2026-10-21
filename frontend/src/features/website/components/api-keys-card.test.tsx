import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, type as typeInto, cleanupAll } from '../../../test/render';
import ApiKeysCard from './api-keys-card';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { StoreRecord } from '../../../lib/use-website-config';

const fetchMock = vi.fn();
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

let currentScope: SessionScope | null = null;
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ scope: currentScope, accessToken: 'token', user: { id: 'u1' } }),
}));

const ORG = 'org-1';
const MANAGER: SessionScope = {
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: ['store-a'],
};

const STORES: StoreRecord[] = [{ id: 'store-a', name: 'Main', slug: 'main' } as StoreRecord];

const card = () => (
  <I18nProvider>
    <ToastProvider>
      <ApiKeysCard accessToken="token" stores={STORES} storeId="store-a" />
    </ToastProvider>
  </I18nProvider>
);

const buttonByText = (container: HTMLElement, pattern: RegExp) =>
  Array.from(container.querySelectorAll('button')).find((button) => pattern.test(button.textContent ?? '')) ?? null;

const checkboxByLabel = (container: HTMLElement, pattern: RegExp) => {
  const label = Array.from(container.querySelectorAll('label')).find((node) => pattern.test(node.textContent ?? ''));
  return label?.querySelector('input[type="checkbox"]') ?? null;
};

const lastCreateBody = () => {
  const call = fetchMock.mock.calls.find(
    ([path, options]: any[]) => path === '/api-keys' && options?.method === 'POST',
  ) as any[];
  return JSON.parse(call[1].body);
};

/**
 * Phase 6 — issuing a key is now issuing an AUTHORITY, and the dialog must
 * make that choice explicit: read-only by default, orders only by deliberate
 * opt-in with a visible warning, and never a key that can do nothing.
 */
describe('ApiKeysCard capability issuance', () => {
  beforeEach(() => {
    currentScope = MANAGER;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return { data: { key: 'ck_new_secret', capabilities: [] } };
      return { data: [] };
    });
  });

  afterEach(() => {
    cleanupAll();
  });

  const openDialog = async (view: Awaited<ReturnType<typeof renderComponent>>) => {
    await click(buttonByText(view.container, /new key/i));
    await typeInto(view.container.querySelector('input:not([type="checkbox"])'), 'Sitio web');
  };

  it('defaults to read-only: CATALOGUE_READ checked, order authority not', async () => {
    const view = await renderComponent(card());
    await openDialog(view);
    expect((checkboxByLabel(view.container, /read the catalogue/i) as HTMLInputElement).checked).toBe(true);
    expect((checkboxByLabel(view.container, /create orders/i) as HTMLInputElement).checked).toBe(false);
    expect((checkboxByLabel(view.container, /validate discount/i) as HTMLInputElement).checked).toBe(false);

    await click(buttonByText(view.container, /create key/i));
    expect(lastCreateBody()).toEqual({ name: 'Sitio web', storeId: 'store-a', capabilities: ['CATALOGUE_READ'] });
  });

  it('granting order authority shows the warning and sends the grant', async () => {
    const view = await renderComponent(card());
    await openDialog(view);
    expect(view.text()).not.toMatch(/place orders/i);
    await click(checkboxByLabel(view.container, /create orders/i));
    // the warning names the risk and the server-side rule
    expect(view.text()).toMatch(/place orders/i);
    expect(view.text()).toMatch(/server-side/i);

    await click(buttonByText(view.container, /create key/i));
    expect(lastCreateBody().capabilities).toEqual(['CATALOGUE_READ', 'ORDER_CREATE']);
  });

  it('refuses to create a key with no capability at all', async () => {
    const view = await renderComponent(card());
    await openDialog(view);
    await click(checkboxByLabel(view.container, /read the catalogue/i));
    const create = buttonByText(view.container, /create key/i) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await click(create);
    expect(fetchMock.mock.calls.filter(([, options]: any[]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('lists a legacy full key with its three permission badges', async () => {
    fetchMock.mockImplementation(async () => ({
      data: [
        {
          id: 'k1',
          name: 'legacy website',
          prefix: 'ck_legacy1',
          store: { id: 'store-a', name: 'Main' },
          capabilities: ['CATALOGUE_READ', 'ORDER_CREATE', 'DISCOUNT_VALIDATE'],
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    const view = await renderComponent(card());
    expect(view.text()).toMatch(/read/i);
    expect(view.text()).toMatch(/orders/i);
    expect(view.text()).toMatch(/discounts/i);
  });
});
