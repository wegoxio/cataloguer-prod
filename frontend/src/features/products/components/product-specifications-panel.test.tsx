import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, cleanupAll } from '../../../test/render';
import ProductSpecificationsPanel, {
  applicableTo,
  displayValue,
  groupSpecifications,
} from './product-specifications-panel';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { EffectiveFieldValue, FieldDefinition } from '../services/catalogue-detail.service';

const fetchMock = vi.fn();
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

const ORG = 'org-1';
const STORE_A = 'store-a';
const STORE_B = 'store-b';

const scopeFor = (overrides: Partial<SessionScope>): SessionScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: [STORE_A, STORE_B],
  ...overrides,
});

const MANAGER = scopeFor({});
const ADMIN = scopeFor({ role: 'ADMIN', storeId: STORE_A, allowedStoreIds: [STORE_A] });
const EDITOR = scopeFor({ role: 'EDITOR', storeId: STORE_A, allowedStoreIds: [STORE_A] });
const VIEWER = scopeFor({ role: 'VIEWER', storeId: STORE_A, allowedStoreIds: [STORE_A] });
const UNSCOPED_PLATFORM = scopeFor({ platform: true, role: 'SUPER_ADMIN', organizationId: null, allowedStoreIds: [] });
const MANAGED_PLATFORM = scopeFor({ platform: true, role: 'SUPER_ADMIN' });

const definition = (overrides: Partial<FieldDefinition>): FieldDefinition => ({
  id: 'def-1',
  key: 'width',
  label: 'Width',
  type: 'NUMBER',
  unit: 'cm',
  source: 'CUSTOM',
  group: 'Dimensions',
  applicability: 'BOTH',
  childOverrideAllowed: true,
  options: null,
  sortOrder: 0,
  archivedAt: null,
  ...overrides,
});

const effectiveValue = (overrides: Partial<EffectiveFieldValue>): EffectiveFieldValue => ({
  definitionId: 'def-1',
  key: 'width',
  label: 'Width',
  group: 'Dimensions',
  type: 'NUMBER',
  unit: 'cm',
  value: '80',
  source: 'DIRECT',
  sourceProductId: 'p-1',
  ...overrides,
});

const DEFINITIONS: FieldDefinition[] = [
  definition({}),
  definition({ id: 'def-2', key: 'depth', label: 'Depth', group: 'Dimensions', sortOrder: 1 }),
  definition({ id: 'def-3', key: 'material', label: 'Material', type: 'TEXT', unit: null, group: 'Materials' }),
  definition({ id: 'def-4', key: 'note', label: 'Note', type: 'TEXT', unit: null, group: null }),
  definition({ id: 'def-5', key: 'gone', label: 'Retired', group: 'Materials', archivedAt: '2026-01-01' }),
];

const panel = (props: Partial<React.ComponentProps<typeof ProductSpecificationsPanel>> = {}) => (
  <I18nProvider>
    <ToastProvider>
      <ProductSpecificationsPanel
        productId="p-1"
        role="STANDALONE"
        accessToken="token"
        scope={MANAGER}
        definitions={DEFINITIONS}
        effective={[effectiveValue({})]}
        {...props}
      />
    </ToastProvider>
  </I18nProvider>
);

describe('specification grouping and display (P5-W4)', () => {
  it('keeps declared group order and puts ungrouped fields last', () => {
    const groups = groupSpecifications(
      DEFINITIONS.map((def) => ({ definition: def, effective: null })),
    );
    expect(groups.map((g) => g.group)).toEqual(['Dimensions', 'Materials', null]);
    expect(groups[0].rows.map((r) => r.definition.key)).toEqual(['width', 'depth']);
  });

  it('applies PARENT fields to models and standalone items, never to versions', () => {
    const parentOnly = definition({ applicability: 'PARENT' });
    expect(applicableTo(parentOnly, 'PARENT')).toBe(true);
    expect(applicableTo(parentOnly, 'STANDALONE')).toBe(true);
    expect(applicableTo(parentOnly, 'CHILD')).toBe(false);
  });

  it('applies CHILD fields only to versions', () => {
    const childOnly = definition({ applicability: 'CHILD' });
    expect(applicableTo(childOnly, 'CHILD')).toBe(true);
    expect(applicableTo(childOnly, 'PARENT')).toBe(false);
    expect(applicableTo(childOnly, 'STANDALONE')).toBe(false);
  });

  it('renders a unit with its number, a boolean as words, and an absence as an absence', () => {
    const t = (s: string) => s;
    expect(displayValue({ definition: definition({}), effective: effectiveValue({}) }, t)).toBe('80 cm');
    expect(
      displayValue(
        { definition: definition({ type: 'BOOLEAN', unit: null }), effective: effectiveValue({ value: true }) },
        t,
      ),
    ).toBe('Yes');
    expect(displayValue({ definition: definition({}), effective: null }, t)).toBe('-');
  });
});

describe('specifications panel: scope-derived rendering (P5-W5)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: {} });
  });
  afterEach(() => cleanupAll());

  it('shows the values to every actor, archived definitions excluded', async () => {
    const view = await renderComponent(panel({ scope: VIEWER }));
    expect(view.find('spec-row-width')).not.toBeNull();
    expect(view.find('spec-row-material')).not.toBeNull();
    // An archived definition is not a question anybody can answer.
    expect(view.find('spec-row-gone')).toBeNull();
  });

  it('offers editing to catalogue authority: manager, managed and unscoped platform owner, branch admin', async () => {
    // The UNSCOPED platform owner is included deliberately. `canManageCatalogue`
    // mirrors the server matrix, and the product routes scope by ORGANIZATION
    // through `assertProductInOrganization` — which the platform owner passes.
    // Excluding it here would make the panel narrower than the API, which is
    // the mirror-image mistake of offering an action the API refuses.
    for (const scope of [MANAGER, MANAGED_PLATFORM, ADMIN, UNSCOPED_PLATFORM]) {
      const view = await renderComponent(panel({ scope }));
      expect(view.find('spec-edit-width')).not.toBeNull();
      view.unmount();
    }
  });

  it('offers NO editing to EDITOR or VIEWER', async () => {
    for (const scope of [EDITOR, VIEWER]) {
      const view = await renderComponent(panel({ scope }));
      expect(view.find('spec-edit-width')).toBeNull();
      expect(view.find('spec-clear-width')).toBeNull();
      view.unmount();
    }
  });

  it('offers nothing at all while the scope is still absent', async () => {
    const view = await renderComponent(panel({ scope: null }));
    expect(view.find('spec-edit-width')).toBeNull();
  });

  it('stops offering controls the moment the scope NARROWS to a denied actor', async () => {
    const view = await renderComponent(panel({ scope: MANAGER }));
    expect(view.find('spec-edit-width')).not.toBeNull();
    // A tenant/scope transition: the same mounted panel, a new resolved scope.
    await view.rerender(panel({ scope: VIEWER }));
    expect(view.find('spec-edit-width')).toBeNull();
  });
});

describe('specifications panel: inheritance and overrides (P5-W4)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: {} });
  });
  afterEach(() => cleanupAll());

  it('marks an inherited answer and offers OVERRIDE rather than edit', async () => {
    const view = await renderComponent(
      panel({ role: 'CHILD', effective: [effectiveValue({ source: 'INHERITED', sourceProductId: 'parent-1' })] }),
    );
    expect(view.find('spec-inherited-width')).not.toBeNull();
    expect(view.get('spec-edit-width').textContent).toContain('Override');
    // Nothing to clear: the child has no answer of its own.
    expect(view.find('spec-clear-width')).toBeNull();
  });

  it("marks a version's OWN answer and offers CLEAR", async () => {
    const view = await renderComponent(panel({ role: 'CHILD', effective: [effectiveValue({ source: 'DIRECT' })] }));
    expect(view.find('spec-overridden-width')).not.toBeNull();
    expect(view.find('spec-clear-width')).not.toBeNull();
    expect(view.find('spec-inherited-width')).toBeNull();
  });

  it('disables OVERRIDE when the field forbids it, instead of failing at the server', async () => {
    const locked = DEFINITIONS.map((def) => (def.id === 'def-1' ? { ...def, childOverrideAllowed: false } : def));
    const view = await renderComponent(
      panel({ role: 'CHILD', definitions: locked, effective: [effectiveValue({ source: 'INHERITED' })] }),
    );
    expect((view.get('spec-edit-width') as HTMLButtonElement).disabled).toBe(true);
  });

  it('CLEAR removes only this product own answer', async () => {
    const onChanged = vi.fn();
    const view = await renderComponent(panel({ effective: [effectiveValue({ source: 'DIRECT' })], onChanged }));
    await click(view.get('spec-clear-width'));
    expect(fetchMock).toHaveBeenCalledWith('/products/p-1/fields/def-1', expect.objectContaining({ method: 'DELETE' }));
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('specifications panel: handler-level enforcement (P5-W5)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: {} });
  });
  afterEach(() => cleanupAll());

  /**
   * HIDING A CONTROL IS NOT ENFORCEMENT. A denied actor's panel renders no
   * button, so the only way to reach the handler is to hold a reference to it
   * across a scope change — which is exactly what a stale page does. The
   * handler must refuse on its own.
   */
  it('refuses the write when the control is triggered after the scope loses authority', async () => {
    const view = await renderComponent(panel({ effective: [effectiveValue({ source: 'DIRECT' })] }));
    const clearButton = view.get('spec-clear-width');
    // The scope transitions to a denied actor; the captured button element is
    // still in hand, exactly as a stale render would be.
    await view.rerender(panel({ scope: VIEWER, effective: [effectiveValue({ source: 'DIRECT' })] }));
    fetchMock.mockClear();
    await click(clearButton);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the write with no access token, rather than issuing an unauthenticated request', async () => {
    const view = await renderComponent(
      panel({ accessToken: null, effective: [effectiveValue({ source: 'DIRECT' })] }),
    );
    // The control still renders for an authorised actor; the handler is the
    // one that knows there is nothing to authenticate with.
    await click(view.get('spec-clear-width'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
