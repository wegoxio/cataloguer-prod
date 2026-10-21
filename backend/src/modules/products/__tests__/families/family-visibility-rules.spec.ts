import {
  FamilyMemberRefusal,
  assertBranchesKeepLiveChildVisible,
  assertParentCanHostLiveChild,
} from '../../families/family-membership';

/**
 * THE TWO RULES THAT KEEP AN ATTACHED ITEM ON THE WEBSITE.
 *
 * A child never lists on its own, so attaching hands its whole visibility to
 * the parent. These are the pure rules; the service spec covers where they sit
 * in the transaction and the pg spec covers the rows they read.
 */
const live = { id: 'child', name: 'Salsa Agridulce', status: 'PUBLISHED', archivedAt: null };
const draftChild = { ...live, status: 'DRAFT' };
const archivedChild = { ...live, archivedAt: new Date('2026-09-01') };

describe('assertParentCanHostLiveChild', () => {
  it('refuses a published child under a draft parent, naming both and the consequence', () => {
    try {
      assertParentCanHostLiveChild({ name: 'Alioli', status: 'DRAFT', archivedAt: null }, live);
      fail('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(FamilyMemberRefusal);
      const refusal = err as FamilyMemberRefusal;
      // The reader must learn which item, which parent, and what would happen.
      expect(refusal.message).toContain('"Alioli" is draft');
      expect(refusal.message).toContain('"Salsa Agridulce"');
      expect(refusal.message).toContain('would remove it from the website');
      // The structured id is what a preflight uses to point at the culprit.
      expect(refusal.productId).toBe('child');
    }
  });

  it('refuses a published child under an archived parent, and says archived', () => {
    expect(() =>
      assertParentCanHostLiveChild({ name: 'Alioli', status: 'PUBLISHED', archivedAt: new Date('2026-09-01') }, live),
    ).toThrow(/is archived/);
  });

  it('allows a published child under a published parent', () => {
    expect(() =>
      assertParentCanHostLiveChild({ name: 'Alioli', status: 'PUBLISHED', archivedAt: null }, live),
    ).not.toThrow();
  });

  it('allows a DRAFT child under a draft parent: it shows nowhere already', () => {
    expect(() =>
      assertParentCanHostLiveChild({ name: 'Alioli', status: 'DRAFT', archivedAt: null }, draftChild),
    ).not.toThrow();
  });

  it('allows an archived child, published or not: archived shows nowhere either', () => {
    expect(() =>
      assertParentCanHostLiveChild({ name: 'Alioli', status: 'DRAFT', archivedAt: null }, archivedChild),
    ).not.toThrow();
  });
});

describe('assertBranchesKeepLiveChildVisible', () => {
  const parent = { name: 'Alioli' };

  it('refuses when the parent is hidden in a branch the child is published in', () => {
    try {
      assertBranchesKeepLiveChildVisible(parent, live, [{ id: 's1', name: 'Centro' }]);
      fail('expected a refusal');
    } catch (err) {
      const refusal = err as FamilyMemberRefusal;
      expect(refusal).toBeInstanceOf(FamilyMemberRefusal);
      expect(refusal.message).toContain('"Centro"');
      expect(refusal.message).toContain('"Salsa Agridulce"');
      expect(refusal.message).toContain('that branch');
      expect(refusal.productId).toBe('child');
    }
  });

  it('names EVERY offending branch, so the reader does not discover them one at a time', () => {
    try {
      assertBranchesKeepLiveChildVisible(parent, live, [
        { id: 's2', name: 'Las Mercedes' },
        { id: 's1', name: 'Centro' },
      ]);
      fail('expected a refusal');
    } catch (err) {
      const message = (err as FamilyMemberRefusal).message;
      expect(message).toContain('"Centro"');
      expect(message).toContain('"Las Mercedes"');
      expect(message).toContain('those branches');
      // Ordered by id, so the same two branches read the same way every time.
      expect(message.indexOf('"Centro"')).toBeLessThan(message.indexOf('"Las Mercedes"'));
    }
  });

  it('allows when no branch would hide the child', () => {
    expect(() => assertBranchesKeepLiveChildVisible(parent, live, [])).not.toThrow();
  });

  it('allows a draft child however many branches hide the parent', () => {
    expect(() => assertBranchesKeepLiveChildVisible(parent, draftChild, [{ id: 's1', name: 'Centro' }])).not.toThrow();
  });
});
