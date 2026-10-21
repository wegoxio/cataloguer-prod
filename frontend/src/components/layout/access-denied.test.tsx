import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../test/render';
import AccessDenied, { NoOrganizationContext } from './access-denied';
import { I18nProvider } from '../../lib/i18n';

/**
 * The two explicit empty-looking states (Phase 8 E).
 *
 * Both exist so that "you may not see this" and "no company is chosen" are
 * STATED, never rendered as an empty table that reads as real data. The
 * assertions pin the testids the browser matrix keys on, and the fact that
 * each state names a way forward — the dashboard, or the Clients page.
 */
describe('AccessDenied', () => {
  afterEach(() => cleanupAll());

  it('states the refusal with its landmark and a route back', async () => {
    const view = await renderComponent(
      <I18nProvider>
        <AccessDenied />
      </I18nProvider>,
    );
    const node = view.get('access-denied');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.textContent).toMatch(/do not have access/i);
    expect(node.querySelector('a[href="/dashboard"]')).not.toBeNull();
  });

  it('carries the caller’s own title and reason when given', async () => {
    const view = await renderComponent(
      <I18nProvider>
        <AccessDenied title="Team management is not part of your access" reason="Reserved for administrators." />
      </I18nProvider>,
    );
    expect(view.text()).toContain('Team management is not part of your access');
    expect(view.text()).toContain('Reserved for administrators.');
  });
});

describe('NoOrganizationContext', () => {
  afterEach(() => cleanupAll());

  it('says a company must be chosen, names the subject, and links to Clients', async () => {
    const view = await renderComponent(
      <I18nProvider>
        <NoOrganizationContext what="The catalogue" />
      </I18nProvider>,
    );
    const node = view.get('no-organization-context');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.textContent).toContain('Choose a company first');
    expect(node.textContent).toContain('The catalogue belongs to a company');
    expect(node.querySelector('a[href="/dashboard/clients"]')).not.toBeNull();
  });
});
