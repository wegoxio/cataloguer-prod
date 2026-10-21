import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import ManufacturerCodeNotice, { type ManufacturerCodeMatch } from './manufacturer-code-notice';
import { I18nProvider } from '../../../lib/i18n';

const notice = (matches: ManufacturerCodeMatch[], ambiguities: number) => (
  <I18nProvider>
    <ManufacturerCodeNotice matches={matches} ambiguities={ambiguities} />
  </I18nProvider>
);

const MATCHES: ManufacturerCodeMatch[] = [
  { code: 'LMP-9', outcome: 'UNIQUE', productIds: ['p-1'], rowNumbers: [2] },
  { code: 'KARE-71234', outcome: 'AMBIGUOUS', productIds: ['p-2', 'p-3'], rowNumbers: [3, 4] },
  { code: 'BRAND-NEW', outcome: 'NONE', productIds: [], rowNumbers: [5] },
];

describe('manufacturer-code ambiguity feedback (P5-W1 / P5-W5)', () => {
  afterEach(() => cleanupAll());

  it('renders nothing when the file names no manufacturer codes', async () => {
    const view = await renderComponent(notice([], 0));
    expect(view.find('manufacturer-code-notice')).toBeNull();
  });

  it('names the colliding code, how many products it matches, and the rows that used it', async () => {
    const view = await renderComponent(notice(MATCHES, 1));
    const row = view.get('manufacturer-code-ambiguous-KARE-71234');
    expect(row.textContent).toContain('KARE-71234');
    expect(row.textContent).toContain('2');
    // The exact spreadsheet rows, so the operator knows what to fix.
    expect(row.textContent).toContain('3, 4');
  });

  it('states that ambiguous rows will NOT be applied, and offers no way to choose', async () => {
    const view = await renderComponent(notice(MATCHES, 1));
    const banner = view.get('manufacturer-code-ambiguities');
    expect(banner.textContent).toMatch(/will NOT be applied/i);
    // Choosing one of the colliding products is exactly the silent resolution
    // the contract forbids, so there is no control to do it.
    expect(banner.querySelectorAll('button').length).toBe(0);
    expect(banner.querySelectorAll('select').length).toBe(0);
  });

  it('summarises what will update and what is new', async () => {
    const view = await renderComponent(notice(MATCHES, 1));
    const summary = view.get('manufacturer-code-summary').textContent ?? '';
    expect(summary).toContain('1');
  });

  it('shows no ambiguity banner when every code resolves cleanly', async () => {
    const clean = MATCHES.filter((match) => match.outcome !== 'AMBIGUOUS');
    const view = await renderComponent(notice(clean, 0));
    expect(view.find('manufacturer-code-ambiguities')).toBeNull();
    expect(view.find('manufacturer-code-summary')).not.toBeNull();
  });
});
