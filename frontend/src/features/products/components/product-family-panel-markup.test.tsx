import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import ProductFamilyPanel, { type FamilyView } from './product-family-panel';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { Product } from '../types/product.types';

vi.mock('../../../lib/api-client', () => ({ apiFetch: vi.fn(async () => ({ items: [] })) }));

const MANAGER: SessionScope = {
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: ['store-a'],
};
const VIEWER: SessionScope = { ...MANAGER, role: 'VIEWER', storeId: 'store-a' };

const CARD: Product = { id: 'card-1', name: 'Nordic chair', slug: 'nordic-chair', status: 'PUBLISHED' };
const FAMILY: FamilyView = {
  parentId: 'card-1',
  parentName: 'Nordic chair',
  members: [
    { id: 'child-1', name: 'Nordic chair green', optionLabel: 'Green', price: 100, trackInventory: true, stockQuantity: 2 },
    { id: 'child-2', name: 'Nordic chair blue', optionLabel: null, price: 100, trackInventory: false },
  ],
};

/** What React says, in development, about markup a browser would repair: the hydration error in the screenshots. */
const NESTING = /cannot (appear as|be) a child of|validateDOMNesting|hydration/i;

/**
 * THE FAMILY TABLE IS VALID TABLE MARKUP.
 *
 * `THead` renders its own header row and takes cells. The panel passed it a
 * `TR`, so the header was `<thead><tr><tr>…`: invalid HTML, which a browser
 * repairs by moving rows around, and which React reports in development as a
 * hydration error ("<tr> cannot be a child of <tr>"). Every other `THead`
 * caller in the app passes cells.
 */
describe('family panel · table markup', () => {
  afterEach(() => {
    cleanupAll();
    vi.restoreAllMocks();
  });

  for (const [who, scope] of [
    ['a catalogue manager', MANAGER],
    ['a viewer', VIEWER],
  ] as const) {
    it(`renders one header row of column headers, and no row inside a row, for ${who}`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = await renderComponent(
        <I18nProvider>
          <ToastProvider>
            <ProductFamilyPanel product={CARD} family={FAMILY} accessToken="token" scope={scope} />
          </ToastProvider>
        </I18nProvider>,
      );

      expect(view.container.querySelectorAll('tr tr')).toHaveLength(0);
      const thead = view.container.querySelector('thead');
      expect(thead?.children).toHaveLength(1);
      expect(thead?.children[0].tagName).toBe('TR');
      const headers = Array.from(thead?.children[0].children ?? []);
      expect(headers.length).toBeGreaterThan(0);
      for (const cell of headers) {
        expect(cell.tagName).toBe('TH');
        expect(cell.getAttribute('scope')).toBe('col');
      }
      // One body row per member, each a direct child of the body.
      expect(view.container.querySelectorAll('tbody > tr')).toHaveLength(FAMILY.members.length);

      const nesting = errors.mock.calls.map((call) => call.map(String).join(' ')).filter((text) => NESTING.test(text));
      expect(nesting).toEqual([]);
    });
  }
});
