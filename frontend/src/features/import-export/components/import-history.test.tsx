import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';

type Scope = Record<string, unknown> | null;
let currentScope: Scope = null;
const getHistory = vi.fn();

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ scope: currentScope, accessToken: 'token' }),
}));
vi.mock('../services/import.service', () => ({
  importService: { getHistory: (...a: unknown[]) => getHistory(...a) },
}));

import ImportHistory from './import-history';

const view = () => (
  <I18nProvider>
    <ImportHistory />
  </I18nProvider>
);

const orgWide = (role: string): Scope => ({
  role,
  platform: false,
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: [],
});
const branchBound = (): Scope => ({
  role: 'ADMIN',
  platform: false,
  organizationId: 'org-1',
  storeId: 'store-1',
  allowedStoreIds: ['store-1'],
});

describe('ImportHistory access state', () => {
  beforeEach(() => {
    getHistory.mockReset();
    getHistory.mockResolvedValue([]);
  });
  afterEach(() => cleanupAll());

  it('tells a branch ADMIN they cannot read it, instead of showing an empty history', async () => {
    // The regression this guards: the backend's 403 was swallowed by
    // `.catch(() => setRecords([]))`, so a refusal rendered as "No imports
    // recorded yet." — indistinguishable from a company that has genuinely
    // never imported anything.
    currentScope = branchBound();
    const r = await renderComponent(view());
    expect(r.text()).toMatch(/not available for your access/i);
    expect(r.text()).not.toMatch(/No imports recorded yet/i);
  });

  it('does not call the endpoint at all when the actor cannot read history', async () => {
    currentScope = branchBound();
    await renderComponent(view());
    expect(getHistory).not.toHaveBeenCalled();
  });

  it('loads history for an organization manager', async () => {
    currentScope = orgWide('ORGANIZATION_MANAGER');
    const r = await renderComponent(view());
    expect(getHistory).toHaveBeenCalledWith('token');
    expect(r.text()).not.toMatch(/not available for your access/i);
  });

  it('loads history for a scoped platform owner', async () => {
    currentScope = orgWide('SUPER_ADMIN');
    await renderComponent(view());
    expect(getHistory).toHaveBeenCalled();
  });

  it('refuses an EDITOR', async () => {
    currentScope = orgWide('EDITOR');
    const r = await renderComponent(view());
    expect(r.text()).toMatch(/not available for your access/i);
    expect(getHistory).not.toHaveBeenCalled();
  });

  it('refuses a company-less scope', async () => {
    currentScope = null;
    const r = await renderComponent(view());
    expect(r.text()).toMatch(/not available for your access/i);
    expect(getHistory).not.toHaveBeenCalled();
  });
});
