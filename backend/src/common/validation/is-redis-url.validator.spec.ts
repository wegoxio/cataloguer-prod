import { IsRedisUrlConstraint } from './is-redis-url.validator';

/**
 * #181: REDIS_URL is validated by parsing (not regex alone), so control-char
 * tricks the URL parser would silently strip cannot slip through, and a
 * non-loopback host is forced onto TLS.
 */
describe('IsRedisUrlConstraint', () => {
  const c = new IsRedisUrlConstraint();
  const ok = (v: unknown) => expect(c.validate(v)).toBe(true);
  const no = (v: unknown) => expect(c.validate(v)).toBe(false);

  it('accepts a rediss:// URL with credentials to a remote host', () => {
    ok('rediss://default:secretpass@apple-12345.upstash.io:6379');
  });

  it('accepts plaintext redis:// only for loopback hosts', () => {
    ok('redis://127.0.0.1:6379');
    ok('redis://localhost:6379/0');
    ok('redis://[::1]:6379');
  });

  it('rejects plaintext redis:// to a non-loopback host (TLS required)', () => {
    no('redis://apple-12345.upstash.io:6379');
    no('redis://user@remote.example:6379');
  });

  it('rejects wrong or missing schemes', () => {
    no('http://example.com');
    no('rediss:example.com'); // no host authority
    no('not-a-url');
  });

  it('rejects an empty host', () => {
    no('redis://');
    no('rediss://');
  });

  it('rejects whitespace/control characters the URL parser would strip', () => {
    // A raw newline inside the host: new URL() would silently strip it to "h".
    no('rediss://h\n:6379');
    no('rediss://h\t:6379');
    no('redis://ho st:6379');
    no('  rediss://host:6379  ');
  });

  it('rejects non-strings and over-long values', () => {
    no(undefined);
    no(123);
    no('rediss://' + 'a'.repeat(600) + ':6379');
  });

  it('returns a constant, value-free message (no credentials leaked)', () => {
    // The message is static — it never interpolates the rejected value, so it
    // cannot carry userinfo/credentials (an '@' authority marker).
    const msg = c.defaultMessage();
    expect(msg).not.toContain('@');
    expect(msg.toLowerCase()).toContain('redis_url');
  });
});
