import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import ProductTable from './product-table';
import type { Product } from '../types/product.types';

// Forward EVERY prop: a mock that keeps only href silently drops data-testid
// and aria-label and would make a present element look absent.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const p = (o: Partial<Product>): Product =>
  ({ id: 'x', name: 'n', slug: 's', price: 10, status: 'PUBLISHED', ...o }) as Product;

const CARD = p({
  id: 'card',
  name: 'Crema de Queso de Cabra',
  slug: 'crema-de-queso-de-cabra',
  children: [
    { id: 'kid', name: 'Crema de Queso de Cabra (Grande)' },
    { id: 'kid2', name: 'Crema de Queso de Cabra (Pequeña)' },
  ],
});
const KID = p({
  id: 'kid',
  name: 'Crema de Queso de Cabra (Grande)',
  slug: 'crema-de-queso-de-cabra-grande',
  optionLabel: 'Grande',
  parent: { id: 'card', name: 'Crema de Queso de Cabra' },
});
/** A child whose label was never set: the parent still shows, the option line does not. */
const UNLABELLED = p({
  id: 'kid2',
  name: 'Crema de Queso de Cabra (Pequeña)',
  slug: 'crema-de-queso-de-cabra-pequena',
  parent: { id: 'card', name: 'Crema de Queso de Cabra' },
});
const ALONE = p({ id: 'solo', name: 'Lámpara', slug: 'lampara', price: 80, salePrice: 60, stockQuantity: 3, trackInventory: true });
const GONE = p({ id: 'gone', name: 'Vieja silla', slug: 'vieja-silla', archivedAt: '2026-01-01T00:00:00Z' } as Partial<Product>);
/** A child whose parent arrived as a bare id: no name to show, still a child. */
const BYID = p({ id: 'kid3', name: 'Crema de Queso de Cabra (Mini)', slug: 'crema-de-queso-de-cabra-mini', parent: 'card' });

const noop = () => undefined;
const table = (products: Product[] = [CARD, KID, UNLABELLED, ALONE, GONE, BYID], over: Record<string, unknown> = {}) =>
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

const headersOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('thead th')).map((h) => h.textContent?.trim());
const rowOf = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) => r.querySelector('td:nth-child(3) a')?.textContent === name)!;
const cellsOf = (row: Element) => Array.from(row.querySelectorAll('td'));

afterEach(() => cleanupAll());

/**
 * The family is a fact ABOUT an item, so it gets columns of its own: Role says
 * what the item is, Parent item says which family a child belongs to and the
 * option it is sold under. The Name column is the item's own name and slug and
 * nothing else — "Crema de Queso de Cabra (Grande) of Crema de Queso de Cabra"
 * wrapped over three lines and read as one long name.
 */
describe('the Items table columns', () => {
  it('reads Checkbox · Image · Name · Role · Parent item · Status · Category · Price · Sale price · Stock · Actions', async () => {
    const { container } = await table();
    expect(headersOf(container)).toEqual([
      '',
      'Image',
      'Name',
      'Role',
      'Parent item',
      'Status',
      'Category',
      'Price',
      'Sale Price',
      'Stock',
      'Actions',
    ]);
  });

  it('gives every body row the same number of cells as the header', async () => {
    const { container } = await table();
    const count = container.querySelectorAll('thead th').length;
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      expect(row.querySelectorAll('td').length).toBe(count);
    }
  });
});

describe('the Name cell', () => {
  it('holds only the name link, the slug and nothing about the family', async () => {
    const { container } = await table();
    const cell = cellsOf(rowOf(container, 'Crema de Queso de Cabra (Grande)'))[headersOf(container).indexOf('Name')];
    expect(cell.querySelector('a')?.getAttribute('href')).toBe('/dashboard/products/kid');
    expect(cell.querySelector('a')?.textContent).toBe('Crema de Queso de Cabra (Grande)');
    expect(cell.textContent).toContain('crema-de-queso-de-cabra-grande');
    expect(cell.querySelector('[data-testid^="parent-of-"]')).toBeNull();
    expect(cell.querySelector('[data-testid^="option-label-"]')).toBeNull();
    expect(cell.querySelector('[data-testid^="family-role-"]')).toBeNull();
    expect(cell.textContent).not.toContain('Grande)Grande');
    expect(cell.textContent).not.toContain(' of ');
  });

  it('keeps the Archived badge, translated', async () => {
    const { container } = await table();
    const cell = cellsOf(rowOf(container, 'Vieja silla'))[headersOf(container).indexOf('Name')];
    expect(cell.textContent).toContain('Archived');
  });

  it('shows the website link only when one is available', async () => {
    const { container } = await table([ALONE], {
      websiteUrlForProduct: (product: Product) => (product.id === 'solo' ? 'https://shop.example/products/lampara' : null),
    });
    const cell = cellsOf(rowOf(container, 'Lámpara'))[headersOf(container).indexOf('Name')];
    const external = cell.querySelector('a[target="_blank"]');
    expect(external?.getAttribute('href')).toBe('https://shop.example/products/lampara');
    expect(external?.getAttribute('aria-label')).toBe('View on website');
  });
});

describe('the Parent item cell', () => {
  it('links a child to its parent and names the option beneath', async () => {
    const { get } = await table();
    const link = get('parent-of-kid');
    expect(link.getAttribute('href')).toBe('/dashboard/products/card');
    expect(link.textContent).toBe('Crema de Queso de Cabra');
    expect(link.getAttribute('aria-label')).toBe('Open parent Crema de Queso de Cabra');
    expect(get('option-label-kid').textContent).toBe('Option: Grande');
    expect(get('parent-item-kid').contains(link)).toBe(true);
  });

  it('omits the option line for a child that has no label', async () => {
    const { get, find } = await table();
    expect(get('parent-of-kid2').textContent).toBe('Crema de Queso de Cabra');
    expect(find('option-label-kid2')).toBeNull();
  });

  it('links a child whose parent is only an id under a neutral name, never "Parent" twice', async () => {
    const { get, container } = await table();
    const link = get('parent-of-kid3');
    expect(link.getAttribute('href')).toBe('/dashboard/products/card');
    expect(link.textContent).toBe('Parent item');
    expect(link.getAttribute('aria-label')).toBe('Open parent item');
    expect(link.getAttribute('aria-label')).not.toMatch(/Parent Parent/);
    // Still a Child in the Role column.
    expect(get('family-role-kid3').textContent?.trim()).toBe('Child');
    const cells = cellsOf(rowOf(container, 'Crema de Queso de Cabra (Mini)'));
    expect(cells[headersOf(container).indexOf('Parent item')].contains(link)).toBe(true);
  });

  it.each([
    ['a standalone item', 'solo'],
    ['a parent card', 'card'],
  ])('shows a dash that a screen reader can name for %s', async (_what, id) => {
    const { get, find } = await table();
    const cell = get(`parent-item-${id}`);
    expect(cell.textContent).toContain('—');
    expect(cell.textContent).toContain('No parent');
    expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
    expect(find(`parent-of-${id}`)).toBeNull();
    expect(find(`option-label-${id}`)).toBeNull();
  });

  it('sits in the Parent item column, not in Name or Role', async () => {
    const { container, get } = await table();
    const headers = headersOf(container);
    const cells = cellsOf(rowOf(container, 'Crema de Queso de Cabra (Grande)'));
    expect(cells[headers.indexOf('Parent item')].contains(get('parent-item-kid'))).toBe(true);
    expect(cells[headers.indexOf('Role')].textContent?.trim()).toBe('Child');
  });
});

describe('the Role cell is unchanged', () => {
  it('still says Parent (n) with the Not purchasable warning, Child, and Standalone', async () => {
    const { get, find } = await table();
    expect(get('family-role-card').textContent?.trim()).toBe('Parent (2)');
    expect(get('not-purchasable-card').textContent).toContain('Not purchasable');
    expect(get('family-role-kid').textContent?.trim()).toBe('Child');
    expect(get('family-role-solo').textContent?.trim()).toBe('Standalone');
    expect(find('not-purchasable-kid')).toBeNull();
    expect(find('not-purchasable-solo')).toBeNull();
  });
});

describe('numbers', () => {
  it('right-aligns Price, Sale Price and Stock with tabular digits, header and body alike', async () => {
    const { container } = await table();
    const headers = headersOf(container);
    const ths = Array.from(container.querySelectorAll('thead th'));
    const cells = cellsOf(rowOf(container, 'Lámpara'));
    for (const column of ['Price', 'Sale Price', 'Stock']) {
      const index = headers.indexOf(column);
      expect(ths[index].className, `${column} header`).toMatch(/text-right/);
      expect(cells[index].className, `${column} cell`).toMatch(/text-right/);
      expect(cells[index].className, `${column} cell`).toMatch(/tabular-nums/);
    }
    expect(cells[headers.indexOf('Price')].textContent).toBe('$80.00');
    expect(cells[headers.indexOf('Sale Price')].textContent).toBe('$60.00');
    expect(cells[headers.indexOf('Stock')].textContent).toContain('3');
  });
});

describe('the sticky identity group', () => {
  it('pins the checkbox, image and name cells in header and body, with opaque backgrounds', async () => {
    const { container } = await table();
    const ths = Array.from(container.querySelectorAll('thead th')).slice(0, 3);
    const tds = cellsOf(rowOf(container, 'Lámpara')).slice(0, 3);
    for (const cell of [...ths, ...tds]) {
      expect(cell.className).toMatch(/\bsticky\b/);
      expect(cell.className).toMatch(/\bbg-(white|slate-50)\b/);
    }
    // The first column is pinned at the edge; the next two carry a measured
    // offset (zero in this DOM, which has no layout) as inline geometry.
    expect(ths[0].className).toMatch(/\bleft-0\b/);
    expect(tds[0].className).toMatch(/\bleft-0\b/);
    for (const cell of [ths[1], ths[2], tds[1], tds[2]]) {
      expect((cell as HTMLElement).style.left).toBe('0px');
    }
    // The name cell closes the group with an edge line.
    expect(ths[2].className).toMatch(/border-r/);
    expect(tds[2].className).toMatch(/border-r/);
  });

  it('repaints the selection tint on the pinned cells so it stays visible while scrolling', async () => {
    const { container } = await table(undefined, { selectedProductIds: ['solo'] });
    const tds = cellsOf(rowOf(container, 'Lámpara')).slice(0, 3);
    for (const cell of tds) expect(cell.className).toMatch(/before:bg-primary\/5/);
    const others = cellsOf(rowOf(container, 'Lámpara')).slice(3);
    for (const cell of others) expect(cell.className).not.toMatch(/before:bg-primary\/5/);
  });

  it('names the box neutrally, with no tab stop and no scroll wording, while nothing overflows', async () => {
    // This DOM has no layout, so scrollWidth and clientWidth are both zero:
    // the same state as a desktop box whose table fits.
    const { container, get } = await table();
    const box = get('items-table-box');
    expect(box.getAttribute('role')).toBe('region');
    expect(box.getAttribute('aria-label')).toBe('Items table');
    expect(box.hasAttribute('tabindex')).toBe(false);
    expect(box.getAttribute('data-horizontal-overflow')).toBe('false');
    expect(box.getAttribute('data-sticky-columns')).toBe('true');
    expect(box.className).toMatch(/overflow-x-auto/);
    expect(box.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('[role="region"]')).toHaveLength(1);
  });
});

describe('Spanish', () => {
  it('has an entry for every string this change adds', async () => {
    const { ES } = await import('../../../lib/translations.es');
    for (const key of [
      'Parent item',
      'Option: {label}',
      'Open parent {name}',
      'No parent',
      'Select {name}',
      'Items table',
      'Items table, scrolls horizontally',
      'Open parent item',
      'Archived',
      'View on website',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
      expect(ES[key]).not.toBe(key);
    }
    expect(ES['Parent item']).toBe('Artículo padre');
    expect(ES['Option: {label}']).toBe('Opción: {label}');
  });
});
