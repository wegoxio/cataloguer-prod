import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, select, flush } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import { ES } from '../../../lib/translations.es';
import BulkWebsitePublicationModal from './bulk-website-publication-modal';
import BulkWebsitePublicationResult from './bulk-website-publication-result';
import BulkActionsBar from './bulk-actions-bar';
import type { BulkBranchPublicationRun, Product } from '../types/product.types';

const p = (o: Partial<Product>): Product =>
  ({ id: 'x', name: 'n', slug: 's', price: 10, status: 'PUBLISHED', ...o }) as Product;

const STORES = [
  { id: 'store-a', name: 'EliteToGo', archivedAt: null },
  { id: 'store-b', name: 'Norte', archivedAt: null },
  { id: 'store-z', name: 'Closed', archivedAt: '2026-01-01' },
];
const HIDDEN_HERE = p({ id: 'h1', name: 'Cuaderno', branchLinks: [{ store: 'store-a', published: false }] });
const CARD = p({ id: 'card', name: 'Silla', children: [{ id: 'k1', name: 'Verde' }] });
const ELSEWHERE = p({ id: 'e1', name: 'Lámpara', branchLinks: [{ store: 'store-b', published: true }] });

afterEach(() => cleanupAll());

const modal = (over: Partial<React.ComponentProps<typeof BulkWebsitePublicationModal>> = {}) =>
  renderComponent(
    <I18nProvider>
      <BulkWebsitePublicationModal
        stores={STORES}
        selectedCount={3}
        selectedOnPage={[HIDDEN_HERE, CARD, ELSEWHERE]}
        onRun={async () => undefined}
        onClose={() => undefined}
        {...over}
      />
    </I18nProvider>,
  );

/**
 * The Website publication dialog (ADR 029) decides nothing on its own.
 */
describe('the Website publication modal', () => {
  it('offers only active websites, with no default unless the list is filtered to one', async () => {
    const r = await modal();
    const options = Array.from((r.get('wp-store') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['', 'store-a', 'store-b']);
    expect((r.get('wp-store') as HTMLSelectElement).value).toBe('');
    expect((r.get('wp-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pre-selects the branch the list is filtered to', async () => {
    const r = await modal({ initialStoreId: 'store-b' });
    expect((r.get('wp-store') as HTMLSelectElement).value).toBe('store-b');
    // Still no action chosen — still not submittable.
    expect((r.get('wp-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the action only once BOTH a website and Publish/Hide are chosen, and says exactly what changes', async () => {
    const r = await modal();
    await select(r.get('wp-store'), 'store-a');
    expect((r.get('wp-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(r.find('wp-confirm-text')).toBeNull();

    await click(r.get('wp-publish'));
    expect((r.get('wp-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(r.get('wp-confirm-text').textContent).toContain('will be shown on EliteToGo');
    expect(r.get('wp-confirm-text').textContent).toContain('global status stay as they are');
    expect(r.get('wp-submit').textContent).toContain('Publish here');

    await click(r.get('wp-hide'));
    expect(r.get('wp-confirm-text').textContent).toContain('will be hidden on EliteToGo');
    expect(r.get('wp-confirm-text').textContent).toContain('publish them again later');
    expect(r.get('wp-submit').textContent).toContain('Hide here');
  });

  it('hands the chosen website and direction to onRun — publish is true, hide is false', async () => {
    const onRun = vi.fn(async () => undefined);
    const r = await modal({ onRun });
    await select(r.get('wp-store'), 'store-a');
    await click(r.get('wp-hide'));
    await click(r.get('wp-submit'));
    expect(onRun).toHaveBeenCalledWith('store-a', false);

    await click(r.get('wp-publish'));
    await click(r.get('wp-submit'));
    expect(onRun).toHaveBeenLastCalledWith('store-a', true);
  });

  it('warns, for the loaded page, about parent cards and about products not on that website', async () => {
    const r = await modal();
    await select(r.get('wp-store'), 'store-a');
    expect(r.get('wp-preflight-parents').textContent).toContain('1 parent cards will be skipped');
    expect(r.get('wp-preflight-parents').textContent).toContain('is not published on its own');
    // Lámpara is on Norte only; Cuaderno IS on EliteToGo (hidden), so it does not count.
    expect(r.get('wp-preflight-not-members').textContent).toContain('1 products are not on this website');
  });
});

const run = (over: Partial<BulkBranchPublicationRun> = {}): BulkBranchPublicationRun => ({
  storeId: 'store-a',
  published: true,
  updatedCount: 0,
  unchangedCount: 0,
  skippedParentCount: 0,
  failedCount: 0,
  notAttemptedCount: 0,
  notAttemptedIds: [],
  outcomes: [],
  failure: null,
  chunksSent: 1,
  chunksTotal: 1,
  ...over,
});

describe('the Website publication result panel', () => {
  it('shows the five counts, names failures with their reason, explains skipped cards once', async () => {
    const r = await renderComponent(
      <I18nProvider>
        <BulkWebsitePublicationResult
          websiteName="EliteToGo"
          products={[HIDDEN_HERE, CARD, ELSEWHERE]}
          onDismiss={() => undefined}
          run={run({
            updatedCount: 1,
            unchangedCount: 2,
            skippedParentCount: 1,
            failedCount: 1,
            outcomes: [
              { id: 'h1', outcome: 'UPDATED', globalStatus: 'DRAFT' },
              { id: 'card', outcome: 'SKIPPED_PARENT', message: 'is a parent card' },
              { id: 'e1', outcome: 'FAILED', message: 'This product is not on that website; add it there first (it is added hidden).' },
            ],
          })}
        />
      </I18nProvider>,
    );
    expect(r.get('wp-updated').textContent).toBe('Updated: 1');
    expect(r.get('wp-unchanged').textContent).toBe('Already in that state: 2');
    expect(r.get('wp-skipped').textContent).toBe('Skipped parent cards: 1');
    expect(r.get('wp-failed').textContent).toBe('Failed: 1');
    expect(r.get('wp-not-attempted').textContent).toBe('Not attempted: 0');
    expect(r.get('wp-failed-list').textContent).toContain('Lámpara');
    expect(r.get('wp-failed-list').textContent).toContain('not on that website');
    expect(r.get('wp-skipped-details').textContent).toContain('Silla');
    expect(r.get('wp-skipped-details').textContent).toContain('appears on a website when at least one of its child products');
    expect(r.get('wp-drafts-note').textContent).toContain('1 of these are global Drafts');
    expect(r.find('wp-retry')).toBeNull();
  });

  it('offers to retry ONLY the not-attempted ids, from an explicit button', async () => {
    const onRetry = vi.fn();
    const r = await renderComponent(
      <I18nProvider>
        <BulkWebsitePublicationResult
          websiteName="EliteToGo"
          products={[]}
          onDismiss={() => undefined}
          onRetryNotAttempted={onRetry}
          run={run({
            updatedCount: 2,
            notAttemptedCount: 3,
            notAttemptedIds: ['a', 'b', 'c'],
            failure: { chunkIndex: 2, chunkCount: 3, message: 'network down' },
            chunksSent: 1,
            chunksTotal: 3,
            outcomes: [
              { id: 'x', outcome: 'UPDATED' },
              { id: 'y', outcome: 'UPDATED' },
              { id: 'a', outcome: 'NOT_ATTEMPTED' },
              { id: 'b', outcome: 'NOT_ATTEMPTED' },
              { id: 'c', outcome: 'NOT_ATTEMPTED' },
            ],
          })}
        />
      </I18nProvider>,
    );
    expect(r.get('wp-not-attempted').textContent).toBe('Not attempted: 3');
    expect(r.get('wp-failure-message').textContent).toBe('Request 2 of 3 failed: network down');
    expect(r.get('wp-error').textContent).toContain('Already in that state');
    expect(r.get('wp-retry').textContent).toContain('Retry the 3 not attempted');
    await click(r.get('wp-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the request failure in SPANISH from its structured parts — the sentence is not built in the service', async () => {
    window.localStorage.setItem('wegox-lang', 'es');
    try {
      const r = await renderComponent(
        <I18nProvider>
          <BulkWebsitePublicationResult
            websiteName="EliteToGo"
            products={[]}
            onDismiss={() => undefined}
            onRetryNotAttempted={() => undefined}
            run={run({
              notAttemptedCount: 1,
              notAttemptedIds: ['a'],
              failure: { chunkIndex: 2, chunkCount: 3, message: 'red caída' },
              outcomes: [{ id: 'a', outcome: 'NOT_ATTEMPTED' }],
            })}
          />
        </I18nProvider>,
      );
      // The provider reads the stored language after mount.
      await flush();
      expect(r.get('wp-failure-message').textContent).toBe('La solicitud 2 de 3 falló: red caída');
      expect(r.get('wp-not-attempted').textContent).toBe('No intentados: 1');
      expect(r.get('wp-retry').textContent).toBe('Reintentar los 1 no intentados');
    } finally {
      window.localStorage.removeItem('wegox-lang');
    }
  });

  it('shows the progress of the run in flight from its OWN numbers, and none once it is over', async () => {
    const r = await renderComponent(
      <I18nProvider>
        <BulkWebsitePublicationResult
          websiteName="EliteToGo"
          products={[]}
          onDismiss={() => undefined}
          progress={{ sent: 1, total: 4 }}
          run={run({ chunksSent: 3, chunksTotal: 3 })}
        />
      </I18nProvider>,
    );
    // 1 of 4 — the current run — not the finished run's 3 of 3.
    expect(r.get('wp-progress').textContent).toBe('Sending 1 of 4 requests…');
    await r.rerender(
      <I18nProvider>
        <BulkWebsitePublicationResult
          websiteName="EliteToGo"
          products={[]}
          onDismiss={() => undefined}
          progress={null}
          run={run({ chunksSent: 3, chunksTotal: 3 })}
        />
      </I18nProvider>,
    );
    expect(r.find('wp-progress')).toBeNull();
  });

  it('names a failed reload for what it is, beside the completed result', async () => {
    const r = await renderComponent(
      <I18nProvider>
        <BulkWebsitePublicationResult
          websiteName="EliteToGo"
          products={[]}
          onDismiss={() => undefined}
          refreshFailed
          run={run({ updatedCount: 2, outcomes: [{ id: 'x', outcome: 'UPDATED' }, { id: 'y', outcome: 'UPDATED' }] })}
        />
      </I18nProvider>,
    );
    expect(r.get('wp-updated').textContent).toBe('Updated: 2');
    expect(r.get('wp-refresh-failed').textContent).toContain('could not be refreshed');
    expect(r.get('wp-refresh-failed').textContent).toContain('itself completed');
  });
});

describe('the bulk bar', () => {
  const bar = (canAssignStores: boolean, onOpenModal = vi.fn()) =>
    renderComponent(
      <I18nProvider>
        <BulkActionsBar
          count={2}
          canManage
          canAssignStores={canAssignStores}
          canArchive
          groupBlockedReason={null}
          onClear={() => undefined}
          onQuickAction={() => undefined}
          onOpenModal={onOpenModal}
        />
      </I18nProvider>,
    );

  it('offers Website publication with the same authority as Stores, and opens its modal', async () => {
    const onOpenModal = vi.fn();
    const r = await bar(true, onOpenModal);
    expect(r.get('bulk-website-publication').textContent).toBe('Website publication');
    await click(r.get('bulk-website-publication'));
    expect(onOpenModal).toHaveBeenCalledWith('websitePublication');
  });

  it('is absent for a narrowed actor', async () => {
    const r = await bar(false);
    expect(r.find('bulk-website-publication')).toBeNull();
  });
});

describe('translations', () => {
  it('every string this feature adds has a Spanish entry', () => {
    for (const key of [
      'Website publication',
      'Publish or hide the selected products on one website',
      'Branch publication',
      'Published or hidden here',
      'Select every item on this page',
      'Choose a website',
      'The selected products will be shown on {website}. Nothing else changes: store membership, branch prices, stock, lead time, other websites and the product’s global status stay as they are.',
      'The selected products will be hidden on {website}. They stay assigned to it with their branch prices and stock, so you can publish them again later.',
      'A parent card is not published on its own: it appears on a website when at least one of its child products is published there. Select the child products to change what the card shows.',
      'On this page: {n} parent cards will be skipped',
      'On this page: {n} products are not on this website and will be reported, not added',
      'Sending {sent} of {total} requests…',
      'Updated: {n}',
      'Already in that state: {n}',
      'Skipped parent cards: {n}',
      'Failed: {n}',
      'Not attempted: {n}',
      'Retry the {m} not attempted',
      'If the interrupted request was applied, those products appear as “Already in that state”.',
      '{n} of these are global Drafts and stay off the website until published globally',
      'Website publication: {updated} updated, {unchanged} unchanged, {skipped} skipped, {failed} failed',
      'Website publication stopped: {notAttempted} not attempted',
      'Dismiss results',
      'Request {k} of {n} failed: {message}',
      'The list could not be refreshed; the website publication itself completed.',
      'Website publication could not be completed',
      // Reused, must still exist.
      'Publish here',
      'Hide here',
      'Website',
      'Action',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
      expect(ES[key]).not.toBe(key);
    }
  });
});
