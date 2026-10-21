import { describe, expect, it, vi } from 'vitest';

/**
 * The old history bookmark.
 *
 * `/dashboard/import-export/history` rendered a page reading a table nothing
 * had been able to write to since the direct-commit path was retired, so it
 * said "No imports recorded yet" while completed imports sat in the lifecycle
 * tables. Import activity is that history now, and this route exists only to
 * carry an old link to it.
 */

const redirect = vi.fn();
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

describe('the retired history route', () => {
  it('sends an old bookmark to Import activity', async () => {
    const { default: Page } = await import('./page');
    Page();
    expect(redirect).toHaveBeenCalledWith('/dashboard/import-export');
  });

  it('renders nothing of its own, so the two cannot drift apart again', async () => {
    const { default: Page } = await import('./page');
    const source = Page.toString();
    // No data call and no list of its own — the route redirects and nothing
    // else. (Its function NAME still contains "ImportHistory", which is why
    // this asserts on behaviour rather than on the identifier.)
    expect(source).not.toMatch(/getHistory|importService|useState|fetch\(/);
    expect(source).toMatch(/redirect/);
  });
});
