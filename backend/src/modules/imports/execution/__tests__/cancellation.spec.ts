import { CancellationToken, describeRunOutcome, isResumable, type RunOutcome } from '../cancellation';

/**
 * Stopping a run that is already writing.
 *
 * The whole design rests on being blunt that cancelling does not undo anything,
 * and on never leaving the person unable to find out what landed.
 */

describe('asking a run to stop', () => {
  it('is not stopping yet — the worker decides where', () => {
    // Polled rather than pushed, because the worker is the only thing that
    // knows where it is. An interrupt delivered at an arbitrary moment would
    // arrive mid-unit as often as not.
    const token = new CancellationToken();
    expect(token.shouldStop('BETWEEN_BATCHES').stop).toBe(false);
    token.request('Ana');
    expect(token.requested).toBe(true);
    expect(token.stopped).toBe(false);
  });

  it('stops at either safe boundary', () => {
    // Between units as well as between batches, so a cancel during a long
    // batch does not have to wait for the whole batch.
    const token = new CancellationToken();
    token.request('Ana');
    expect(token.shouldStop('BETWEEN_BATCHES').stop).toBe(true);
    expect(token.shouldStop('BETWEEN_UNITS').stop).toBe(true);
  });

  it('says plainly that what was imported was KEPT', () => {
    // The most important sentence in the feature. Someone who believes
    // cancelling undoes the run will not check their catalogue.
    const token = new CancellationToken();
    token.request('Ana');
    expect(token.shouldStop('BETWEEN_BATCHES').reason).toMatch(/kept/i);
    expect(token.shouldStop('BETWEEN_BATCHES').reason).toContain('Ana');
  });

  it('is still comprehensible when nobody is named', () => {
    const token = new CancellationToken();
    token.request('');
    expect(token.shouldStop('BETWEEN_BATCHES').reason).toMatch(/Stopped at your request/);
  });

  it('says WHICH boundary stopped it, because that decides what landed', () => {
    // Between batches means the last batch is whole; between units means it
    // committed fewer rows than it planned. An operator reconciling a
    // catalogue needs to know which.
    const token = new CancellationToken();
    token.request('Ana');
    expect(token.shouldStop('BETWEEN_BATCHES').reason).toMatch(/last batch was completed in full/);
    expect(token.shouldStop('BETWEEN_UNITS').reason).toMatch(/stopped part-way/);
  });

  it('ignores a second request rather than rewriting who asked', () => {
    const token = new CancellationToken();
    expect(token.request('Ana')).toBe(true);
    expect(token.request('Beto')).toBe(false);
    expect(token.cancelledBy).toBe('Ana');
  });

  it('records that it actually stopped, separately from having been asked', () => {
    // "Asked to stop" and "has stopped" are different facts, and the report
    // needs the second one.
    const token = new CancellationToken();
    token.request('Ana');
    expect(token.stopped).toBe(false);
    token.markStopped();
    expect(token.stopped).toBe(true);
  });
});

describe('how a run is described afterwards', () => {
  const progress = { batchesCommitted: 4, batchesPlanned: 10 };

  it('treats a partial run as real work, not as a failure', () => {
    // Calling it "failed" would tell the person to redo all of it, including
    // the four batches that are correct.
    const text = describeRunOutcome('PARTIALLY_COMPLETED', progress);
    expect(text).toContain('4 of 10');
    expect(text).toContain('does not need repeating');
    expect(text).not.toMatch(/fail/i);
  });

  it('says a cancelled run was not undone', () => {
    const text = describeRunOutcome('CANCELLED', progress);
    expect(text).toMatch(/kept/i);
    expect(text).toMatch(/does not undo/i);
  });

  it('says what an error left behind is still correct', () => {
    const text = describeRunOutcome('FAILED', progress);
    expect(text).toContain('4 of 10');
    expect(text).toMatch(/correct/);
  });

  it('offers resumption when a worker vanished', () => {
    // The checkpoints are the truth about what landed; missing logs are not
    // evidence of anything.
    expect(describeRunOutcome('ABANDONED', progress)).toMatch(/resumed from where it stopped/);
  });

  it('claims completeness only when it is complete', () => {
    const text = describeRunOutcome('COMPLETED', { batchesCommitted: 10, batchesPlanned: 10 });
    expect(text).toMatch(/Every batch was applied/);
  });

  it('always names how far it got, whatever happened', () => {
    // "I do not know what happened to rows 400–600" is the one answer an
    // import must never give.
    const outcomes: RunOutcome[] = ['PARTIALLY_COMPLETED', 'CANCELLED', 'FAILED', 'ABANDONED'];
    for (const outcome of outcomes) {
      expect(describeRunOutcome(outcome, progress)).toContain('4 of 10');
    }
  });
});

describe('which runs may be continued', () => {
  it('resumes a run that stopped without being asked to', () => {
    expect(isResumable('PARTIALLY_COMPLETED')).toBe(true);
    expect(isResumable('ABANDONED')).toBe(true);
    expect(isResumable('FAILED')).toBe(true);
  });

  it('does NOT quietly resume a run somebody cancelled', () => {
    // They stopped it on purpose. Continuing later would be the opposite of
    // what they asked for; starting a fresh run is the explicit act.
    expect(isResumable('CANCELLED')).toBe(false);
  });

  it('does not resume a run that finished', () => {
    expect(isResumable('COMPLETED')).toBe(false);
  });
});
