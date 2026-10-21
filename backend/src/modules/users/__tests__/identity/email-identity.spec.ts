import { canonicalEmail, sameEmailIdentity, CANONICAL_EMAIL_SQL } from '../../identity/email-identity';

/**
 * ONE DEFINITION OF "THE SAME EMAIL IDENTITY" (#291 correction 3).
 *
 * The rule used to be answered in three alphabets at once — the unique index
 * compared raw bytes, the migration's guards compared `lower(email)`, and the
 * application compared whatever the caller typed. These pin the single rule
 * every one of them now defers to, including the shape of the SQL expression,
 * because a lookup that drifted from the index would miss exactly the rows the
 * index calls duplicates.
 */
describe('#291 · the email identity rule', () => {
  it('folds case, because no sign-in form has ever been case-sensitive', () => {
    expect(canonicalEmail('Person@Example.Com')).toBe('person@example.com');
    expect(canonicalEmail('PERSON@EXAMPLE.COM')).toBe('person@example.com');
  });

  it('trims surrounding whitespace, which is a paste artefact and not an address', () => {
    expect(canonicalEmail('  person@example.com \n')).toBe('person@example.com');
  });

  it('changes NOTHING else — no dot-stripping, no +tag folding', () => {
    // Those are guesses about someone else's mail server, and a wrong guess
    // merges two genuinely different people into one identity.
    expect(canonicalEmail('first.last+catalog@example.com')).toBe('first.last+catalog@example.com');
    expect(canonicalEmail('a_b-c@sub.example.co.uk')).toBe('a_b-c@sub.example.co.uk');
  });

  it('treats case variants as ONE identity', () => {
    expect(sameEmailIdentity('Person@Example.com', 'person@example.com')).toBe(true);
    expect(sameEmailIdentity(' PERSON@example.com ', 'person@example.com')).toBe(true);
  });

  it('and genuinely different addresses as two', () => {
    expect(sameEmailIdentity('person@example.com', 'persen@example.com')).toBe(false);
    expect(sameEmailIdentity('person@example.com', 'person.@example.com')).toBe(false);
    expect(sameEmailIdentity('person+a@example.com', 'person@example.com')).toBe(false);
  });

  it('the SQL expression matches the one the unique index is built on', () => {
    // `users_email_active_unique` is `unique (lower(email)) where removed_at
    // is null`. If this constant ever said something else, a lookup would
    // answer "free" for an address the index would refuse.
    expect(CANONICAL_EMAIL_SQL).toBe('lower(email)');
  });
});
