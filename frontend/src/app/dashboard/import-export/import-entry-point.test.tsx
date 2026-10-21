import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';

/**
 * The visible way into an import.
 *
 * The defect these cover shipped: the Import/Export screen carried its own
 * complete importer — file → mapping → "Confirm import" → `POST /import/commit`
 * — which wrote to the catalogue with no plan and no approval. It was also the
 * ONLY visible import action, so the safe wizard was unreachable without typing
 * its URL, and anyone following the obvious path used the unsafe one.
 *
 * So there are two properties, and both matter: the visible action must lead to
 * the wizard, and the legacy interface must be gone rather than merely
 * demoted.
 */

const mocks = vi.hoisted(() => ({
  scope: { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: ['s1', 's2'] } as any,
}));

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c' }, scope: mocks.scope, accessToken: 'token' }),
}));
vi.mock('../../../lib/i18n', () => ({ useT: () => (s: string) => s }));
vi.mock('../../../components/ui/toast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../../lib/api-client', () => ({
  apiDownload: vi.fn(async () => new Blob(['x'])),
  saveBlob: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));

import ImportExportPage from './page';
import { IMPORT_WIZARD_PATH } from '../../../features/import-export/wizard-route';

const asManager = () => {
  mocks.scope = { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: ['s1', 's2'] };
};
const asBranchAdmin = () => {
  mocks.scope = { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: 's1', allowedStoreIds: ['s1'] };
};
const asViewer = () => {
  mocks.scope = { platform: false, role: 'VIEWER', organizationId: 'org-1', storeId: 's1', allowedStoreIds: ['s1'] };
};

afterEach(() => {
  cleanupAll();
  asManager();
});

describe('the import entry point', () => {
  it('offers a visible "Start an import" action', async () => {
    asManager();
    const { container } = await renderComponent(<ImportExportPage />);
    expect(container.textContent).toContain('Start an import');
  });

  it('points that action at the wizard route', async () => {
    asManager();
    const { container } = await renderComponent(<ImportExportPage />);

    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('Start an import'),
    );
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe(IMPORT_WIZARD_PATH);
    expect(IMPORT_WIZARD_PATH).toBe('/dashboard/import-export/wizard');
  });

  it('is a real link, so it deep-links and opens in a new tab like any navigation', async () => {
    asManager();
    const { container } = await renderComponent(<ImportExportPage />);
    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('Start an import'),
    );
    // An onClick-only button would satisfy "visible" and fail every one of
    // middle-click, copy-link and browser back.
    expect(link?.tagName).toBe('A');
  });

  it('no longer presents the legacy direct-import interface', async () => {
    asManager();
    const { container } = await renderComponent(<ImportExportPage />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('Confirm import');
    expect(text).not.toContain('Analyze file');
    expect(text).not.toContain('This is what I read');
    expect(text).not.toContain('How are numbers written in your file?');
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('keeps import history reachable — as Import activity, on this page', async () => {
    // The separate history link is gone, and that IS the fix. It led to a page
    // reading a table nothing had been able to write to since the direct-commit
    // path was retired, so it reported "No imports recorded yet" while
    // completed imports sat in the lifecycle tables. Import activity on this
    // page is the history now, so a link from here to a route that redirects
    // straight back here would be a loop dressed as navigation.
    asManager();
    const { container } = await renderComponent(<ImportExportPage />);
    const stale = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/dashboard/import-export/history',
    );
    expect(stale).toBeUndefined();
    // The history itself is right here — the activity surface, whichever state
    // it is in. (This harness has no listing endpoint, so it renders the
    // failure branch rather than the list; either way the surface is present
    // and no stale link leads away from it.)
    const activity =
      container.querySelector('[data-testid="draft-imports"]') ??
      container.querySelector('[data-testid="draft-imports-failed"]') ??
      container.querySelector('[data-testid="draft-imports-loading"]');
    expect(activity).not.toBeNull();
  });

  it('keeps export reachable', async () => {
    asManager();
    const { container } = await renderComponent(<ImportExportPage />);
    expect(container.textContent).toContain('Export Tools');
  });
});

describe('who sees the import entry point', () => {
  it('a store-bound ADMIN gets export but NOT the import action', async () => {
    asBranchAdmin();
    const { container } = await renderComponent(<ImportExportPage />);
    const text = container.textContent ?? '';

    // Importing is organization-level authority; export is read-only, so ADMIN
    // keeps export. The import ACTION is now shown-but-disabled rather than
    // hidden: hiding it made "your role cannot do this" indistinguishable from
    // "this feature is gone". Authority is unchanged — see the disabled-state
    // assertions below.
    expect(text).toContain('Start an import');
    expect(text).toContain('Only a company manager can run an import.');
    expect(text).toContain('Export Tools');
  });

  it('a VIEWER is refused the screen outright', async () => {
    asViewer();
    const { container } = await renderComponent(<ImportExportPage />);
    const text = container.textContent ?? '';

    expect(text).toContain('Access Restricted:');
    expect(text).not.toContain('Start an import');
    expect(text).not.toContain('Export Tools');
  });
  /**
   * DISCOVERABILITY — "your role cannot use this" must not look like "this is gone".
   *
   * Smart import used to be rendered only when `mayImport`, so a branch ADMIN
   * saw no trace of it and could not tell whether the feature had been removed,
   * moved, or was simply beyond their role. It is always rendered now, and
   * disabled with a stated reason when the role cannot use it.
   *
   * The authorization boundary is untouched: ADMIN gains nothing, the disabled
   * control carries no link, and the wizard route and the backend refuse them
   * exactly as before.
   */
  describe('discoverability for a role that cannot import', () => {
    it('still shows Smart import to a branch admin', async () => {
      asBranchAdmin();
      const { container } = await renderComponent(<ImportExportPage />);
      expect(container.textContent).toContain('Smart import');
      expect(container.textContent).toContain('Start an import');
    });

    it('disables the action and says why', async () => {
      asBranchAdmin();
      const { container, get } = await renderComponent(<ImportExportPage />);
      const button = get('start-import') as HTMLButtonElement;
      expect(button.tagName).toBe('BUTTON');
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('Only a company manager can run an import.');
    });

    it('exposes the reason PROGRAMMATICALLY, not only as a hover tooltip', async () => {
      asBranchAdmin();
      const { container, get } = await renderComponent(<ImportExportPage />);
      const button = get('start-import');
      const describedBy = button.getAttribute('aria-describedby');
      expect(describedBy).toBe('smart-import-denied');
      // The id it points at must actually exist and carry the explanation.
      const explanation = container.querySelector(`#${describedBy}`);
      expect(explanation).toBeTruthy();
      expect(explanation?.textContent).toContain('company manager');
    });

    it('offers NO link, so the wizard cannot be reached by keyboard from here', async () => {
      asBranchAdmin();
      const { container } = await renderComponent(<ImportExportPage />);
      const wizardLink = Array.from(container.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === IMPORT_WIZARD_PATH,
      );
      // A disabled anchor is still focusable and still navigable — so there is
      // no anchor at all.
      expect(wizardLink).toBeUndefined();
    });

    it('gives an authorized manager a real, enabled link', async () => {
      asManager();
      const { container, get } = await renderComponent(<ImportExportPage />);
      const button = get('start-import') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-describedby')).toBeNull();
      const link = Array.from(container.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === IMPORT_WIZARD_PATH,
      );
      expect(link).toBeTruthy();
    });

    it('does not widen what any role may do — ADMIN still cannot import', async () => {
      // The permission function is the boundary; the UI only reports it.
      const { canRunCatalogueImport } = await import('../../../lib/permissions');
      expect(
        canRunCatalogueImport({ platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: 's1', allowedStoreIds: ['s1'] } as any),
      ).toBe(false);
      expect(
        canRunCatalogueImport({ platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: [] } as any),
      ).toBe(true);
    });
  });
});
