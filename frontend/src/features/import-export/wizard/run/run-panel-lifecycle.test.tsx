import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, cleanupAll } from '../../../../test/render';
import { RunPanel } from './run-panel';
import { initialRunState } from './run-machine';
import type { PlanLifecycle } from '../api/lifecycle.service';

/**
 * What may be offered, decided by the server rather than by this browser.
 *
 * A plan carries a status column and nothing advances it after a run. Plan
 * d5ec89ac-a010-49b2-8975-453d6d6e716f sat at APPROVED for two days while its
 * execution had COMPLETED and its approval had been consumed inside the same
 * minute — and the panel, reading the column, offered Approve on an import that
 * had already happened, behind a proof that could never be spent again. There
 * was no way forward from that screen at all.
 *
 * So every control here is gated on the server's reconciliation, and every
 * state says precisely which one it is. "This plan can no longer be approved"
 * is true of a completed import, a running one, a cancelled one and an expired
 * approval alike, and tells somebody nothing about what to do next.
 */

const actions = {
  createPlan: vi.fn(),
  approve: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  loadResults: vi.fn(),
    withdraw: vi.fn(),
    editMapping: vi.fn(),
  reportHref: null,
};

const PLAN = {
  id: 'plan-1',
  planHash: 'abcdef0123456789'.repeat(4),
  readiness: { allowed: true },
  outstanding: 0,
  alreadyExisted: false,
};

const lifecycle = (over: Partial<PlanLifecycle> = {}): PlanLifecycle => ({
  planId: 'plan-1',
  planHash: PLAN.planHash,
  sourceId: 'source-1',
  importType: 'PRODUCTS',
  storeId: null,
  state: 'PREPARED',
  authority: 'PLAN',
  statusIsStale: false,
  storedStatus: 'DRAFT',
  mayApprove: true,
  mayExecute: false,
  approval: null,
  execution: null,
  ...over,
});

/**
 * `proof` is explicit because it is a capability, not decoration.
 *
 * The panel used to offer Start on `mayExecute` alone, with no proof in hand —
 * a button whose only possible outcome was a refusal. The projection now
 * requires the proof for Start and offers withdrawal without it, so a test that
 * means "approved and runnable" has to say which of the two it means.
 */
const panel = (
  phase: 'IDLE' | 'PLANNED' | 'APPROVED',
  life: PlanLifecycle | null,
  proof: string | null = null,
) =>
  renderComponent(
    <RunPanel
      state={{ ...initialRunState(), phase, plan: phase === 'IDLE' ? null : PLAN, lifecycle: life, proof }}
      readiness={{ allowed: true }}
      actions={actions}
    />,
  );

afterEach(() => cleanupAll());

describe('a plan that is genuinely ready', () => {
  it('offers Approve, and says nothing that needs explaining', async () => {
    const view = await panel('PLANNED', lifecycle());
    expect(view.find('approve-import')).not.toBeNull();
    expect(view.get('plan-surface-headline').textContent ?? '').toMatch(/ready to import/i);
  });

  it('offers Start importing once it is approved AND the proof is held', async () => {
    const view = await panel(
      'APPROVED',
      lifecycle({ state: 'APPROVED', mayApprove: false, mayExecute: true }),
      'proof-1',
    );
    expect(view.find('start-import')).not.toBeNull();
  });

  it('offers withdrawal, not a dead Start, when the proof is not held', async () => {
    // The old panel rendered Start here regardless. Pressing it could only
    // produce a refusal, because `/execute` cannot be called without the
    // one-time proof this browser no longer holds.
    const view = await panel('APPROVED', lifecycle({ state: 'APPROVED', mayApprove: false, mayExecute: true }));
    expect(view.find('start-import')).toBeNull();
    expect(view.container.querySelector('[data-plan-action="WITHDRAW"]')).not.toBeNull();
    expect(view.get('plan-surface-headline').textContent ?? '').toMatch(/one-time authorization is unavailable/i);
  });
});

describe('a plan whose lifecycle has not come back', () => {
  it('offers nothing at all', async () => {
    // Fails CLOSED. The hopeful default is exactly how an Approve button
    // appeared on an import that had already run, and a control that cannot
    // work is worse than a moment without one.
    const view = await panel('PLANNED', null);
    expect(view.find('approve-import')).toBeNull();
  });

  it('offers nothing to execute either', async () => {
    const view = await panel('APPROVED', null);
    expect(view.find('start-import')).toBeNull();
  });
});

describe('the shape production is in', () => {
  const completed = lifecycle({
    state: 'COMPLETED',
    authority: 'EXECUTION',
    storedStatus: 'APPROVED',
    statusIsStale: true,
    mayApprove: false,
    mayExecute: false,
    approval: { id: 'a1', state: 'CONSUMED', expiresAt: '2026-08-30T21:51:50.000Z', consumedAt: '2026-08-27T21:52:22.000Z' },
    execution: { id: 'e1', status: 'COMPLETED', startedAt: '2026-08-27T21:52:01.000Z', finishedAt: '2026-08-27T21:52:22.000Z', cancelRequested: false },
  });

  it('says “Already executed”, though the stored status still says APPROVED', async () => {
    const view = await panel('PLANNED', completed);
    expect(view.get('plan-surface-headline').textContent ?? '').toMatch(/has run/i);
  });

  it('offers neither Approve nor Start importing', async () => {
    const view = await panel('PLANNED', completed);
    expect(view.find('approve-import')).toBeNull();
    const approved = await panel('APPROVED', completed);
    expect(approved.find('start-import')).toBeNull();
  });

  it('names when it happened, so “already” is checkable', async () => {
    const view = await panel('PLANNED', completed);
    expect(view.get('plan-surface').textContent ?? '').toMatch(/2026/);
  });

  it('says the answer came from the run, not from the record', async () => {
    // Shown because it is true. The stored status and what actually happened
    // disagree, and somebody comparing the two deserves to know which won.
    const view = await panel('PLANNED', completed);
    expect(view.find('lifecycle-authority')).not.toBeNull();
  });

  it('offers no rerun, implicit or otherwise', async () => {
    // Deliberate: product-stock imports post movements rather than target
    // balances, so running one twice doubles the stock.
    const view = await panel('PLANNED', completed);
    const text = view.get('run-panel').textContent ?? '';
    expect(text).not.toMatch(/run again|import again|retry/i);
  });
});

describe('a run in flight', () => {
  const executing = lifecycle({
    state: 'EXECUTING',
    authority: 'EXECUTION',
    mayApprove: false,
    mayExecute: false,
    execution: { id: 'e1', status: 'RUNNING', startedAt: '2026-08-29T10:00:00.000Z', finishedAt: null, cancelRequested: false },
  });

  it('says it is running and offers no second approval or start', async () => {
    const view = await panel('PLANNED', executing);
    expect(view.get('plan-surface-headline').textContent).toContain('This import is running');
    expect(view.find('approve-import')).toBeNull();
    expect(view.find('start-import')).toBeNull();
  });

  it('points at the run itself for stopping it', async () => {
    // A different cancel from the one that ends a file, and saying so is what
    // stops somebody pressing the wrong one and believing the run stopped.
    const view = await panel('PLANNED', executing);
    expect(view.get('plan-surface').textContent ?? '').toMatch(/stop it from the run/i);
  });
});

describe('a run that did not finish cleanly', () => {
  it('describes a partial import as partly done, and says to resume', async () => {
    const view = await panel(
      'PLANNED',
      lifecycle({ state: 'PARTIALLY_COMPLETED', authority: 'EXECUTION', mayApprove: false, mayExecute: false }),
    );
    expect(view.get('plan-surface-headline').textContent).toContain('partly ran');
    // Resuming, not restarting: the rows already written must not be written
    // a second time.
    expect(view.get('plan-surface').textContent ?? '').toMatch(/resume/i);
    expect(view.get('plan-surface').textContent ?? '').toMatch(/not written twice/i);
  });

  it('describes a failure as a failure, and says nothing further was written', async () => {
    const view = await panel(
      'PLANNED',
      lifecycle({ state: 'FAILED', authority: 'EXECUTION', mayApprove: false, mayExecute: false }),
    );
    expect(view.get('plan-surface-headline').textContent).toContain('This import failed');
    expect(view.find('approve-import')).toBeNull();
  });

  it('describes a cancelled run, and keeps what it managed to import', async () => {
    const view = await panel(
      'PLANNED',
      lifecycle({ state: 'CANCELLED', authority: 'EXECUTION', mayApprove: false, mayExecute: false }),
    );
    expect(view.get('plan-surface-headline').textContent).toContain('This import was stopped');
    expect(view.get('plan-surface').textContent ?? '').toMatch(/is kept/i);
  });
});

describe('an approval that can no longer be used', () => {
  const spent = (state: 'CONSUMED' | 'EXPIRED' | 'REVOKED') =>
    lifecycle({
      state: 'APPROVAL_SPENT',
      authority: 'APPROVAL',
      mayApprove: false,
      mayExecute: false,
      approval: { id: 'a1', state, expiresAt: '2026-08-30T00:00:00.000Z', consumedAt: state === 'CONSUMED' ? '2026-08-29T00:00:00.000Z' : null },
    });

  it.each([
    ['CONSUMED', 'This approval has already been used'],
    ['EXPIRED', 'This approval has expired'],
    ['REVOKED', 'This approval was withdrawn'],
  ] as const)('says exactly which: %s', async (state, title) => {
    // Three different facts leading to three different actions. Collapsing
    // them into "this plan can no longer be approved" is what left an operator
    // with no idea what they were looking at.
    const view = await panel('PLANNED', spent(state));
    expect(view.get('plan-surface-headline').textContent).toBe(title);
  });

  it('never shows the generic sentence when a precise state is known', async () => {
    for (const state of ['CONSUMED', 'EXPIRED', 'REVOKED'] as const) {
      const view = await panel('PLANNED', spent(state));
      expect(view.get('run-panel').textContent ?? '').not.toContain('can no longer be approved');
      cleanupAll();
    }
  });

  it('offers no approval button behind any of them', async () => {
    for (const state of ['CONSUMED', 'EXPIRED', 'REVOKED'] as const) {
      const view = await panel('PLANNED', spent(state));
      expect(view.find('approve-import')).toBeNull();
      cleanupAll();
    }
  });

  it('says an approval authorises one run, so the way forward is a new plan', async () => {
    const view = await panel('PLANNED', spent('CONSUMED'));
    expect(view.get('plan-surface').textContent ?? '').toMatch(/cannot be reused/i);
    expect(view.get('plan-surface').textContent ?? '').toMatch(/new plan/i);
  });
});
