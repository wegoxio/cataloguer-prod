import { isLoopback, pgTestsEnabled } from '../../test/pg-harness';

/**
 * The disposable-Postgres harness may only ever reach a real loopback target.
 *
 * The hazard this guards is a hostname that merely LOOKS local: `127.example.com`
 * begins with "127." but resolves wherever its owner points it, so a
 * string-prefix test would let a remote database be created, migrated and
 * dropped by the test suite. Classification is therefore by IP, not by text.
 *
 * These are pure function tests: nothing connects to a database.
 */

describe('pg-harness isLoopback', () => {
  it('accepts the real loopback names and addresses', () => {
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('LOCALHOST')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('[::1]')).toBe(true);
    expect(isLoopback('127.0.0.1')).toBe(true);
    // The whole 127.0.0.0/8 block is loopback, not just .0.1
    expect(isLoopback('127.0.0.2')).toBe(true);
    expect(isLoopback('127.1.2.3')).toBe(true);
    expect(isLoopback('127.255.255.254')).toBe(true);
  });

  it('rejects hostnames that merely start with "127."', () => {
    expect(isLoopback('127.example.com')).toBe(false);
    expect(isLoopback('127.0.0.1.evil.test')).toBe(false);
    expect(isLoopback('127.attacker.internal')).toBe(false);
  });

  it('rejects remote hosts, near-miss addresses and malformed input', () => {
    expect(isLoopback('db.example.supabase.co')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('192.168.1.1')).toBe(false);
    expect(isLoopback('128.0.0.1')).toBe(false);
    expect(isLoopback('0.0.0.0')).toBe(false);
    // Not an IPv4 literal, so never loopback however it is spelled
    expect(isLoopback('2130706433')).toBe(false);
    expect(isLoopback('0x7f000001')).toBe(false);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback(undefined as unknown as string)).toBe(false);
  });

  it('does not treat an IPv6 loopback-mapped IPv4 string as loopback', () => {
    // net.isIP reports these as IPv6, so the IPv4 branch never runs and the
    // harness stays conservative rather than guessing at mapped forms.
    expect(isLoopback('::ffff:127.0.0.1')).toBe(false);
  });
});

describe('pg-harness gate', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('stays disabled without the explicit opt-in', () => {
    delete process.env.ALLOW_PG_DISPOSABLE_TESTS;
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@localhost:5432/postgres';
    expect(pgTestsEnabled()).toEqual({ enabled: false, reason: 'ALLOW_PG_DISPOSABLE_TESTS!=1' });
  });

  it('stays disabled when the target is not loopback, even with the opt-in', () => {
    process.env.ALLOW_PG_DISPOSABLE_TESTS = '1';
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@127.example.com:5432/postgres';
    expect(pgTestsEnabled().enabled).toBe(false);
    expect(pgTestsEnabled().reason).toBe('TEST_DATABASE_URL host is not loopback');
  });

  it('enables only with the opt-in AND a genuine loopback target', () => {
    process.env.ALLOW_PG_DISPOSABLE_TESTS = '1';
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/postgres';
    expect(pgTestsEnabled()).toEqual({ enabled: true, reason: 'ok' });
  });
});
