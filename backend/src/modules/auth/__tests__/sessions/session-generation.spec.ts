import { AUTH_GENERATION_CLAIM, authGenerationOf, tokenGenerationIsCurrent } from '../../sessions/session-generation';

/**
 * THE ONE COMPARISON THE SESSION BOUNDARY RESTS ON (#291).
 *
 * Every access token carries the generation its subject held when it was
 * minted, and the guard refuses the request unless that number still matches.
 * The comparison lives alone in one function precisely so it can be pinned
 * here: there is no second place to weaken, and every way of weakening it that
 * a reviewer might not notice has a case below.
 */
describe('#291 · the authentication generation comparison', () => {
  it('accepts a token whose generation is the account’s current one', () => {
    expect(tokenGenerationIsCurrent({ [AUTH_GENERATION_CLAIM]: 4 }, 4)).toBe(true);
  });

  it('refuses a token from a PREVIOUS generation — the removal case', () => {
    // The account was removed (or its sessions ended some other way), which
    // advanced the number. The token is otherwise perfectly valid.
    expect(tokenGenerationIsCurrent({ [AUTH_GENERATION_CLAIM]: 1 }, 2)).toBe(false);
  });

  it('refuses it FOREVER — restoration does not lower the number, so this never flips back', () => {
    // Restoration makes the row visible again and changes nothing here. The
    // only way the comparison passes again is a token minted afterwards.
    for (const current of [2, 3, 99]) {
      expect(tokenGenerationIsCurrent({ [AUTH_GENERATION_CLAIM]: 1 }, current)).toBe(false);
    }
  });

  it('refuses a token from a LATER generation than the account holds', () => {
    // It cannot legitimately exist. Accepting it would mean trusting a claim
    // over the record it describes, which is the whole failure mode here.
    expect(tokenGenerationIsCurrent({ [AUTH_GENERATION_CLAIM]: 5 }, 4)).toBe(false);
  });

  /**
   * THE EXPLICIT COMPATIBILITY RULE, stated as tests because it is the one
   * decision someone would be tempted to soften "for the deployment".
   *
   * A token minted before the claim existed carries nothing to compare. The
   * tempting reading — "no claim means generation 1" — would revive exactly
   * the tokens this exists to kill: a person removed by this revision sits at
   * 2, and their pre-deployment token would claim 1 and be honoured for the
   * rest of its life. It is refused, and the browser's untouched refresh
   * cookie pays the cost with one silent renewal.
   */
  it('refuses a token with NO generation claim', () => {
    expect(tokenGenerationIsCurrent({}, 1)).toBe(false);
    expect(tokenGenerationIsCurrent({ sub: 'user-1' } as never, 1)).toBe(false);
  });

  it('refuses null and undefined payloads rather than treating them as a match', () => {
    expect(tokenGenerationIsCurrent(null, 1)).toBe(false);
    expect(tokenGenerationIsCurrent(undefined, 1)).toBe(false);
  });

  it('refuses a non-integer claim rather than coercing it', () => {
    // `'1'` is not `1`. A loose comparison would accept a shape the signer
    // never produces, on a technicality.
    for (const claimed of ['1', 1.5, true, null, [1], { valueOf: () => 1 }]) {
      expect(tokenGenerationIsCurrent({ [AUTH_GENERATION_CLAIM]: claimed } as never, 1)).toBe(false);
    }
  });

  it('refuses when the ACCOUNT’s generation is unreadable — fails closed, not open', () => {
    // A row that somehow answers with no generation is a broken record, and a
    // broken record must not authenticate anybody.
    for (const current of [undefined, null, '1', NaN]) {
      expect(tokenGenerationIsCurrent({ [AUTH_GENERATION_CLAIM]: 1 }, current)).toBe(false);
    }
  });

  describe('the generation stamped into a new token', () => {
    it('is the account’s own', () => {
      expect(authGenerationOf({ authGeneration: 7 })).toBe(7);
    });

    it('falls back to the column default only when the row carries nothing', () => {
      // Every row has `auth_generation not null default 1`, so this is the
      // shape of an in-memory entity built before a load — never a real row.
      expect(authGenerationOf({})).toBe(1);
      expect(authGenerationOf(null)).toBe(1);
      expect(authGenerationOf(undefined)).toBe(1);
    });

    it('round-trips: a token minted from a row is current against that row', () => {
      const row = { authGeneration: 12 };
      expect(tokenGenerationIsCurrent({ [AUTH_GENERATION_CLAIM]: authGenerationOf(row) }, row.authGeneration)).toBe(
        true,
      );
    });
  });
});
