import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, type } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import { ES } from '../../../lib/translations.es';
import ClientsPage from './page';

/**
 * ONE REQUEST, AND THE THREE OUTCOMES A CLIENT CAN HAVE.
 *
 * The old screen posted three times — organization, store, then a user with
 * `role: 'ADMIN'` — so any prefix could commit and the company it produced had
 * a branch administrator instead of a manager. These assert the network shape
 * itself, because "one call" is the property that fixes it: counting the calls
 * is the test, not an implementation detail.
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

/** Every request the page makes, so "exactly one" is assertable. */
let calls: { path: string; method: string; body: unknown }[] = [];
let onboardResponse: unknown;
let onboardRejects: Error | null = null;
let resendDeliveryStatus: 'DELIVERED' | 'FAILED' = 'DELIVERED';

vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (path === '/stores/overview') {
      return { data: { totals: { activeClients: 0, monthlyRecurringUsd: 0, ordersThisMonth: 0, revenueThisMonth: 0 }, clients: [], plans: [] } };
    }
    if (path === '/organizations/onboard') {
      if (onboardRejects) throw onboardRejects;
      return onboardResponse;
    }
    if (path.includes('/resend-invitation')) return { data: { pending: true, deliveryStatus: resendDeliveryStatus } };
    return { data: null };
  },
}));

const OK = {
  data: {
    organization: { id: 'org-1', name: 'Acme', slug: 'acme', plan: 'BASICO', archivedAt: null },
    store: { id: 'store-1', name: 'Acme', slug: 'acme', websiteUrl: 'https://acme.example.com' },
    manager: { id: 'user-1', email: 'ana@acme.com', role: 'ORGANIZATION_MANAGER', store: null, pendingInvite: true },
    invitation: { pending: true, deliveryStatus: 'DELIVERED' },
    idempotent: false,
  },
};

const page = () =>
  renderComponent(
    <I18nProvider>
      <ClientsPage />
    </I18nProvider>,
  );

/** The rendered button whose text matches — the helper works on elements. */
const button = (r: { container: HTMLElement }, label: RegExp): HTMLElement => {
  const found = Array.from(r.container.querySelectorAll('button')).find((b) => label.test(b.textContent ?? ''));
  if (!found) throw new Error(`no button matching ${label}`);
  return found as HTMLElement;
};
const field = (r: { container: HTMLElement }, name: string): HTMLElement =>
  r.container.querySelector<HTMLElement>(`input[name="${name}"]`)!;

const fillForm = async (r: Awaited<ReturnType<typeof page>>) => {
  await click(button(r, /New Client/));
  await type(field(r, 'clientCompanyName'), 'Acme');
  await type(field(r, 'clientAdminEmail'), 'ana@acme.com');
  await type(field(r, 'clientWebsiteUrl'), 'https://acme.example.com');
};
const fillAndSubmit = async (r: Awaited<ReturnType<typeof page>>) => {
  await fillForm(r);
  await click(button(r, /Create and invite|Crear e invitar/));
};

describe('onboarding a client from the Clients page', () => {
  beforeEach(() => {
    calls = [];
    onboardResponse = OK;
    onboardRejects = null;
    resendDeliveryStatus = 'DELIVERED';
    toast.success.mockReset();
    toast.error.mockReset();
  });
  afterEach(() => cleanupAll());

  it('posts EXACTLY ONE onboarding request — never the old three', async () => {
    const r = await page();
    await fillAndSubmit(r);

    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/organizations/onboard');
    // The endpoints the old sequence used must not be posted to at all.
    expect(calls.some((c) => c.method === 'POST' && c.path === '/organizations')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/stores')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/users')).toBe(false);
  });

  it('NEVER sends a role — the server decides the first user is a manager', async () => {
    const r = await page();
    await fillAndSubmit(r);
    const body = calls.find((c) => c.path === '/organizations/onboard')!.body as Record<string, never>;
    expect(JSON.stringify(body)).not.toMatch(/"role"/);
    expect(JSON.stringify(body)).not.toMatch(/ADMIN/);
    expect(body.organization).toEqual({ name: 'Acme' });
    expect(body.manager).toEqual({ email: 'ana@acme.com' });
    // D2: this screen always sends a store.
    expect(body.store).toEqual({ name: 'Acme', websiteUrl: 'https://acme.example.com' });
  });

  it('WITHOUT a website it still submits, and still sends a store', async () => {
    const r = await page();
    await click(button(r, /New Client/));
    await type(field(r, 'clientCompanyName'), 'Acme');
    await type(field(r, 'clientAdminEmail'), 'ana@acme.com');

    // The website has always been optional on this screen, and two older
    // browser journeys onboard without one. Requiring it would break them.
    expect((button(r, /Create and invite|Crear e invitar/) as HTMLButtonElement).disabled).toBe(false);
    await click(button(r, /Create and invite|Crear e invitar/));

    const body = calls.find((c) => c.path === '/organizations/onboard')!.body as Record<string, never>;
    // D2 still holds: a store is sent, with no website inside it.
    expect(body.store).toEqual({ name: 'Acme' });
  });

  it('says nothing succeeded until the single response arrives', async () => {
    const r = await page();
    await fillForm(r);
    // Before submitting, no success has been claimed.
    expect(toast.success).not.toHaveBeenCalled();
    await click(button(r, /Create and invite|Crear e invitar/));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  /**
   * FOUR STATES, and the one the boolean could not express.
   *
   * `delivered: false` meant both "the attempt failed" and "no attempt was
   * made", so an exact retry rendered failure copy over a healthy invitation —
   * and went on doing it after the manager had accepted, offering to re-send an
   * invitation that no longer existed.
   */
  const banner = (r: { container: HTMLElement }) =>
    r.container.querySelector('[data-testid="onboarding-result"]') as HTMLElement;
  const hasResend = (r: { container: HTMLElement }) =>
    Array.from(r.container.querySelectorAll('button')).some((b) => /Resend invitation|Reenviar/.test(b.textContent ?? ''));

  it('DELIVERED and pending: invited, not signed in, and nothing to re-send', async () => {
    const r = await page();
    await fillAndSubmit(r);
    expect(banner(r).getAttribute('data-delivery')).toBe('DELIVERED');
    expect(banner(r).getAttribute('data-pending')).toBe('yes');
    expect(r.text()).toMatch(/has not signed in yet/i);
    expect(r.text()).not.toMatch(/could not be delivered/i);
    expect(hasResend(r)).toBe(false);
  });

  it('FAILED and pending: created-but-undelivered, with a resend action', async () => {
    onboardResponse = { data: { ...OK.data, invitation: { pending: true, deliveryStatus: 'FAILED' } } };
    const r = await page();
    await fillAndSubmit(r);

    const text = r.text();
    // Never "failed onboarding": the company exists.
    expect(text).toMatch(/could not be delivered/i);
    expect(text).toMatch(/Nothing was lost/i);
    expect(banner(r).getAttribute('data-delivery')).toBe('FAILED');
    expect(hasResend(r)).toBe(true);
    expect(toast.error).toHaveBeenCalled();
  });

  it('UNKNOWN and pending: nothing duplicated, no failure wording, resend still offered', async () => {
    onboardResponse = {
      data: { ...OK.data, idempotent: true, invitation: { pending: true, deliveryStatus: 'UNKNOWN' } },
    };
    const r = await page();
    await fillAndSubmit(r);

    const text = r.text();
    expect(banner(r).getAttribute('data-delivery')).toBe('UNKNOWN');
    expect(text).toMatch(/Nothing was duplicated and no new email was sent/i);
    // The exact wording the old boolean produced here, and must not any more.
    expect(text).not.toMatch(/could not be delivered/i);
    // An explicit resend is still available — it is the operator's decision.
    expect(hasResend(r)).toBe(true);
  });

  it('ALREADY ACCEPTED: no failure wording and NO resend action', async () => {
    onboardResponse = {
      data: {
        ...OK.data,
        idempotent: true,
        manager: { ...OK.data.manager, pendingInvite: false },
        invitation: { pending: false, deliveryStatus: 'UNKNOWN' },
      },
    };
    const r = await page();
    await fillAndSubmit(r);

    const text = r.text();
    expect(banner(r).getAttribute('data-pending')).toBe('no');
    expect(text).toMatch(/has already accepted the invitation/i);
    expect(text).not.toMatch(/could not be delivered/i);
    expect(text).not.toMatch(/Nothing was lost/i);
    expect(hasResend(r)).toBe(false);
  });

  it('the resend action calls the bridge and moves the state to DELIVERED', async () => {
    onboardResponse = { data: { ...OK.data, invitation: { pending: true, deliveryStatus: 'FAILED' } } };
    const r = await page();
    await fillAndSubmit(r);
    calls = [];
    await click(button(r, /Resend invitation|Reenviar/));

    const resend = calls.find((c) => c.path.includes('/resend-invitation'));
    expect(resend?.path).toBe('/organizations/org-1/managers/user-1/resend-invitation');
    expect(resend?.method).toBe('POST');
    expect(banner(r).getAttribute('data-delivery')).toBe('DELIVERED');
    expect(r.text()).toMatch(/has not signed in yet/i);
  });

  it('a resend that fails again says so, and keeps the resend available', async () => {
    onboardResponse = {
      data: { ...OK.data, idempotent: true, invitation: { pending: true, deliveryStatus: 'UNKNOWN' } },
    };
    resendDeliveryStatus = 'FAILED';
    const r = await page();
    await fillAndSubmit(r);
    await click(button(r, /Resend invitation|Reenviar/));

    expect(banner(r).getAttribute('data-delivery')).toBe('FAILED');
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/still could not be delivered/i));
    expect(hasResend(r)).toBe(true);
  });

  it('an EXACT RETRY says nothing was duplicated', async () => {
    onboardResponse = {
      data: { ...OK.data, idempotent: true, invitation: { pending: true, deliveryStatus: 'UNKNOWN' } },
    };
    const r = await page();
    await fillAndSubmit(r);
    expect(r.text()).toMatch(/already existed/i);
    expect(toast.success).toHaveBeenCalled();
    // A retry is not a delivery failure, so it never toasts one.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('an unrecognised delivery status is UNKNOWN, never a failure claim', async () => {
    onboardResponse = { data: { ...OK.data, invitation: { pending: true } } };
    const r = await page();
    await fillAndSubmit(r);
    expect(banner(r).getAttribute('data-delivery')).toBe('UNKNOWN');
    expect(r.text()).not.toMatch(/could not be delivered/i);
  });

  it('a conflict surfaces the server message and claims no success', async () => {
    onboardRejects = new Error('That email already belongs to a user; onboarding creates a new manager');
    const r = await page();
    await fillAndSubmit(r);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already belongs to a user/i));
  });

  it('every invitation state is stated in both languages', () => {
    for (const key of [
      'That company already existed — nothing was created twice.',
      'The company was created, but the invitation email could not be delivered.',
      'was created, but the invitation email could not be delivered. Nothing was lost — send it again.',
      'has been invited and has not signed in yet.',
      'has already accepted the invitation and can sign in.',
      'still has an invitation open. Nothing was duplicated and no new email was sent — send it again if they need one.',
      'The invitation still could not be delivered.',
      'Resend invitation',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
    }
  });
});
