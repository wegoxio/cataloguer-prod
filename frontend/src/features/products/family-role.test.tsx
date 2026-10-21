import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../test/render';
import { I18nProvider } from '../../lib/i18n';
import { FamilyRoleBadge, familyRoleOf, familyRoleLabel } from './family-role';
import type { Product } from './types/product.types';

const product = (over: Partial<Product>): Product =>
  ({ id: 'p1', name: 'Silla', slug: 'silla', price: 10, status: 'PUBLISHED', ...over }) as Product;

const PARENT = product({ id: 'card', children: [{ id: 'a', name: 'Verde' }, { id: 'b', name: 'Marrón' }] });
const CHILD = product({ id: 'kid', parent: { id: 'card', name: 'Silla' } });
const ALONE = product({ id: 'solo' });

const render = (p: Product) =>
  renderComponent(
    <I18nProvider>
      <FamilyRoleBadge product={p} t={(k) => k} />
    </I18nProvider>,
  );

afterEach(() => cleanupAll());

/**
 * An item's ROLE must be stated, never inferred.
 *
 * A standalone item used to carry no badge at all: the only way to know its
 * role was that nothing else was shown, which is not something a reader can
 * check — and is exactly what "do not make users infer the role" forbids.
 */
describe('family role', () => {
  describe('classification', () => {
    it.each([
      ['a product with children', PARENT, 'PARENT'],
      ['a product with a parent', CHILD, 'CHILD'],
      ['a product with neither', ALONE, 'STANDALONE'],
    ])('classifies %s as %s', (_label, p, expected) => {
      expect(familyRoleOf(p)).toBe(expected);
    });

    it('reads a parent given as a bare id, not only as an object', () => {
      expect(familyRoleOf(product({ parent: 'card' }))).toBe('CHILD');
    });

    it('treats an EMPTY children array as standalone, not as a parent', () => {
      expect(familyRoleOf(product({ children: [] }))).toBe('STANDALONE');
    });

    it('prefers PARENT when a product somehow has both', () => {
      // A three-level hierarchy is refused at the backend, but if one ever
      // arrived the card identity is the safer thing to show: it is the one
      // that must not be sold.
      expect(familyRoleOf(product({ parent: 'x', children: [{ id: 'a', name: 'A' }] }))).toBe('PARENT');
    });
  });

  describe('the badge says the role in words', () => {
    it('names a parent and how many children it has', async () => {
      const { get } = await render(PARENT);
      expect(get('family-role-card').textContent).toBe('Parent (2)');
    });

    it('names a child', async () => {
      const { get } = await render(CHILD);
      expect(get('family-role-kid').textContent).toBe('Child');
    });

    it('names a standalone item explicitly', async () => {
      const { get } = await render(ALONE);
      expect(get('family-role-solo').textContent).toBe('Standalone');
    });
  });

  describe('accessibility', () => {
    it('is never colour-only — the role survives greyscale and a screen reader', async () => {
      for (const p of [PARENT, CHILD, ALONE]) {
        const { get } = await render(p);
        const text = get(`family-role-${p.id}`).textContent ?? '';
        expect(text.trim().length).toBeGreaterThan(0);
        cleanupAll();
      }
    });

    it('carries the role as data too, so a test or a tool need not parse prose', async () => {
      const { get } = await render(CHILD);
      expect(get('family-role-kid').getAttribute('data-role')).toBe('CHILD');
    });
  });

  describe('terminology', () => {
    it('never uses the retired "model" or "variant" wording', () => {
      const labels = (['PARENT', 'CHILD', 'STANDALONE'] as const).map((r) => familyRoleLabel(r, (k) => k));
      expect(labels).toEqual(['Parent', 'Child', 'Standalone']);
      for (const label of labels) expect(label.toLowerCase()).not.toMatch(/model|variant|versión|version/);
    });
  });
  describe('Spanish copy', () => {
    it('translates all three roles, and the standalone explainer', async () => {
      const { ES: es } = await import('../../lib/translations.es');
      expect(es['Parent']).toBe('Padre');
      expect(es['Child']).toBe('Hijo');
      expect(es['Standalone']).toBe('Independiente');
      expect(es['This is a standalone product: it has no parent and no children.']).toBe(
        'Este es un producto independiente: no tiene padre ni hijos.',
      );
      // The untruthful instruction is gone from Spanish too, not only English.
      const stale = Object.keys(es).find((k) => k.includes('from the item list') && k.includes('standalone'));
      expect(stale).toBeUndefined();
      expect(Object.values(es).some((v) => v.includes('desde la lista de artículos'))).toBe(false);
    });

    it('translates the Smart import denial', async () => {
      const { ES: es } = await import('../../lib/translations.es');
      expect(es['Only a company manager can run an import.']).toContain('gerente de empresa');
      expect(es['Only a company manager can run an import. Ask one to run it, or to change your role.']).toContain(
        'gerente de empresa',
      );
    });
  });
});
