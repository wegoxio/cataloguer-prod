import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../test/render';
import { DraftImports } from './draft-imports';

/**
 * The listing, across a version skew.
 *
 * The frontend and the backend deploy separately, so for the width of a
 * rollout one is older than the other. That window used to be a crash: the
 * stage lookup was `STAGES[item.stage]` with no fallback, so a stage the build
 * had never heard of threw `Cannot read properties of undefined (reading
 * 'label')` — and because it threw during render, it took the whole listing
 * down, including every unrelated import on it.
 *
 * That was measured, not imagined: the deployed frontend (827f31b) does
 * exactly this when handed the `APPROVED_PENDING` stage this correction adds.
 * It is why the rollout order is frontend first, backend second, and why the
 * lookup now degrades instead of throwing.
 */

const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';

const oldBackendRow = () => ({
  sourceId: SOURCE,
  fileName: 'skew.csv',
  importType: 'PRODUCTS',
  organizationId: 'org-1',
  storeId: null,
  // What e7c34cb emits for an approved, unexecuted plan.
  stage: 'ACTIVE',
  planId: null,
  sourceStatus: 'AVAILABLE',
  analysisStatus: 'COMPLETED',
  planStatus: 'APPROVED',
  executionStatus: null,
  hasUnexecutedDraftPlan: false,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
});

const unrelated = () => ({ ...oldBackendRow(), sourceId: OTHER, fileName: 'other.csv', stage: 'MAPPING_IN_PROGRESS', planStatus: null });

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('new frontend meets a stage from a FUTURE backend', () => {
  afterEach(() => cleanupAll());

  it('survives a stage it has never heard of', async () => {
    const future = { ...oldBackendRow(), stage: 'SOMETHING_LATER' };
    const service = { listSources: async () => ({ items: [unrelated(), future], limit: 20, offset: 0, hasMore: false }) };
    const view = await renderComponent(<DraftImports token="t" storage={null} lifecycle={service as never} />);
    await settle();
    expect(view.find(`draft-${OTHER}`)).not.toBeNull();
  });
});

describe('new frontend against the deployed backend', () => {
  afterEach(() => cleanupAll());

  it('does not crash, and keeps unrelated imports visible', async () => {
    const service = { listSources: async () => ({ items: [unrelated(), oldBackendRow()], limit: 20, offset: 0, hasMore: false }) };
    const view = await renderComponent(<DraftImports token="t" storage={null} lifecycle={service as never} />);
    await settle();
    expect(view.find(`draft-${OTHER}`)).not.toBeNull();
    expect(view.find(`draft-${SOURCE}`)).not.toBeNull();
  });

  it('labels the old ACTIVE stage as the old build did, not as something new', async () => {
    const service = { listSources: async () => ({ items: [oldBackendRow()], limit: 20, offset: 0, hasMore: false }) };
    const view = await renderComponent(<DraftImports token="t" storage={null} lifecycle={service as never} />);
    await settle();
    expect(view.get(`draft-stage-${SOURCE}`).textContent).toBe('Importing');
  });

  it('exposes no action for it, forbidden or otherwise', async () => {
    const service = { listSources: async () => ({ items: [oldBackendRow()], limit: 20, offset: 0, hasMore: false }) };
    const view = await renderComponent(<DraftImports token="t" storage={null} lifecycle={service as never} />);
    await settle();
    // No link, exactly as today. Unreachable is the PRE-EXISTING behaviour;
    // the new frontend does not invent a route the old backend cannot serve.
    expect(view.find(`draft-resume-${SOURCE}`)).toBeNull();
  });
});
