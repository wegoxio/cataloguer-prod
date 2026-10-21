import { parseRevalidationTargets } from './revalidation-targets';

const target = (overrides: Record<string, unknown> = {}) => ({
  name: 'designhof',
  url: 'https://www.designhof.com/api/cataloguer/revalidate',
  secret: 'a'.repeat(32),
  ...overrides,
});

describe('revalidation target configuration', () => {
  it('accepts independent targets and preserves no secret outside each target', () => {
    expect(parseRevalidationTargets(JSON.stringify([target(), target({ name: 'client-two', url: 'https://two.example/revalidate', secret: 'b'.repeat(40) })]), true)).toEqual([
      target(),
      target({ name: 'client-two', url: 'https://two.example/revalidate', secret: 'b'.repeat(40) }),
    ]);
  });

  it('allows local HTTP only outside production', () => {
    const raw = JSON.stringify([target({ url: 'http://localhost:3002/api/cataloguer/revalidate' })]);
    expect(parseRevalidationTargets(raw, false)).toHaveLength(1);
    expect(() => parseRevalidationTargets(raw, true)).toThrow('must use HTTPS');
  });

  it.each([
    ['malformed JSON', '{'],
    ['empty list', '[]'],
    ['duplicate names', JSON.stringify([target(), target({ url: 'https://two.example/revalidate' })])],
    ['short secret', JSON.stringify([target({ secret: 'short' })])],
    ['credentials in URL', JSON.stringify([target({ url: 'https://user:pass@example.com/revalidate' })])],
    ['unknown property', JSON.stringify([{ ...target(), storeId: 'leak' }])],
  ])('rejects %s', (_label, raw) => expect(() => parseRevalidationTargets(raw, true)).toThrow());
});
