import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import ProductTable from './product-table';
import type { Product } from '../types/product.types';

// Forward EVERY prop: a mock that keeps only href silently drops data-testid
// and would make a present element look absent.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const p = (o: Partial<Product>): Product =>
  ({ id: 'x', name: 'n', slug: 's', price: 10, status: 'PUBLISHED', ...o }) as Product;

const CARD = p({ id: 'card', name: 'Silla Nordic', slug: 'silla', children: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
const KID = p({ id: 'kid', name: 'Silla Verde', slug: 'verde', optionLabel: 'Verde', parent: { id: 'card', name: 'Silla Nordic' } });
const ALONE = p({ id: 'solo', name: 'Lámpara', slug: 'lampara' });

const noop = () => undefined;
const table = (products: Product[] = [CARD, KID, ALONE], over: Record<string, unknown> = {}) =>
  renderComponent(
    <I18nProvider>
      <ProductTable
        products={products}
        canManage
        canArchive
        onEdit={noop}
        onArchive={noop}
        onRestore={noop}
        onRemove={noop}
        selectedProductIds={[]}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        {...(over as any)}
      />
    </I18nProvider>,
  );

afterEach(() => cleanupAll());

/**
 * The role belongs in a COLUMN, not appended to the item's name.
 *
 * A badge in the Name cell made the role look like part of the name and put
 * three different kinds of fact — identity, family role, and a warning — in one
 * cell. A column is a field a reader can scan and compare down the page.
 */
describe('the Items table Role column', () => {
  describe('the column exists and is a real header', () => {
    it('has a Role header cell', async () => {
      const { container } = await table();
      const headers = Array.from(container.querySelectorAll('thead th')).map((h) => h.textContent?.trim());
      expect(headers).toContain('Role');
    });

    it('declares the header as a COLUMN header for assistive technology', async () => {
      const { container } = await table();
      const role = Array.from(container.querySelectorAll('thead th')).find((h) => h.textContent?.trim() === 'Role');
      expect(role?.getAttribute('scope')).toBe('col');
    });

    it('sits between Name and Parent item, so the row reads identity → role → family → state', async () => {
      const { container } = await table();
      const headers = Array.from(container.querySelectorAll('thead th')).map((h) => h.textContent?.trim());
      expect(headers.indexOf('Role')).toBe(headers.indexOf('Name') + 1);
      expect(headers.indexOf('Parent item')).toBe(headers.indexOf('Role') + 1);
      expect(headers.indexOf('Status')).toBe(headers.indexOf('Parent item') + 1);
    });

    it('gives every body row the same number of cells as the header', async () => {
      const { container } = await table();
      const headerCount = container.querySelectorAll('thead th').length;
      for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
        expect(row.querySelectorAll('td, th').length).toBe(headerCount);
      }
    });
  });

  describe('the values are text', () => {
    it.each([
      ['card', 'Parent (2)'],
      ['kid', 'Child'],
      ['solo', 'Standalone'],
    ])('%s reads "%s"', async (id, expected) => {
      const { get } = await table();
      expect(get(`family-role-${id}`).textContent?.trim()).toBe(expected);
    });

    it('is a plain value, not a badge pill', async () => {
      const { get } = await table();
      const cell = get('family-role-solo');
      // The badge component's rounded-full pill classes must be gone.
      expect(cell.className).not.toMatch(/rounded-full/);
      expect(cell.getAttribute('data-role')).toBe('STANDALONE');
    });

    it('lives in the Role column, not in the Name cell', async () => {
      const { container, get } = await table();
      const headers = Array.from(container.querySelectorAll('thead th')).map((h) => h.textContent?.trim());
      const roleIndex = headers.indexOf('Role');
      const row = Array.from(container.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes('Lámpara'))!;
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells[roleIndex].contains(get('family-role-solo'))).toBe(true);
      // And the Name cell no longer carries it.
      expect(cells[headers.indexOf('Name')].querySelector('[data-testid^="family-role-"]')).toBeNull();
    });
  });

  describe('what stays where', () => {
    it('keeps the Not purchasable warning for a parent, beside its role', async () => {
      const { container, get } = await table();
      const headers = Array.from(container.querySelectorAll('thead th')).map((h) => h.textContent?.trim());
      const row = Array.from(container.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes('Silla Nordic'))!;
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells[headers.indexOf('Role')].contains(get('not-purchasable-card'))).toBe(true);
      expect(get('not-purchasable-card').textContent).toContain('Not purchasable');
    });

    it('shows it ONLY for a parent', async () => {
      const { find } = await table();
      expect(find('not-purchasable-kid')).toBeNull();
      expect(find('not-purchasable-solo')).toBeNull();
    });

    it("moves a child's parent link and option label OUT of the Name cell into Parent item", async () => {
      const { container, get } = await table();
      const headers = Array.from(container.querySelectorAll('thead th')).map((h) => h.textContent?.trim());
      const row = Array.from(container.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes('Silla Verde'))!;
      const cells = Array.from(row.querySelectorAll('td'));
      const nameCell = cells[headers.indexOf('Name')];
      // The name cell is the item's own name and slug, nothing about the family.
      expect(nameCell.querySelector('a')?.textContent).toBe('Silla Verde');
      expect(nameCell.querySelector('[data-testid^="parent-of-"]')).toBeNull();
      expect(nameCell.querySelector('[data-testid^="option-label-"]')).toBeNull();
      expect(nameCell.textContent).not.toContain('Silla Nordic');
      // The family lives in Parent item: the linked parent, then the option.
      const parentCell = cells[headers.indexOf('Parent item')];
      expect(parentCell.contains(get('parent-of-kid'))).toBe(true);
      expect(get('parent-of-kid').getAttribute('href')).toBe('/dashboard/products/card');
      expect(get('parent-of-kid').textContent).toBe('Silla Nordic');
      expect(get('option-label-kid').textContent).toBe('Option: Verde');
      // The Role cell says the role and nothing else about the family.
      expect(cells[headers.indexOf('Role')].textContent?.trim()).toBe('Child');
    });
  });

  describe('the rest of the table is unaffected', () => {
    it('keeps selection, status, price, stock and actions columns', async () => {
      const { container } = await table();
      const headers = Array.from(container.querySelectorAll('thead th')).map((h) => h.textContent?.trim());
      for (const h of ['Image', 'Name', 'Status', 'Category', 'Price', 'Sale Price', 'Stock']) {
        expect(headers).toContain(h);
      }
    });

    it('still links each item name to its page', async () => {
      const { container } = await table();
      const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
      expect(hrefs).toContain('/dashboard/products/card');
      expect(hrefs).toContain('/dashboard/products/solo');
    });

    it('renders one row per product, in the order given', async () => {
      const { container } = await table();
      const names = Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td:nth-child(3) a')?.textContent,
      );
      expect(names).toEqual(['Silla Nordic', 'Silla Verde', 'Lámpara']);
    });
  });

  describe('Spanish', () => {
    it('translates the column label', async () => {
      const { ES } = await import('../../../lib/translations.es');
      expect(ES['Role']).toBe('Rol');
      expect(ES['Standalone']).toBe('Independiente');
    });
  });
});
