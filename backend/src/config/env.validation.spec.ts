import 'reflect-metadata'; // class-transformer/-validator decorators need it loaded
import { validate } from './env.validation';

/**
 * The import-hardening limits are validated at boot (#172). A present-but-bad
 * value must fail-closed rather than silently degrade the protection.
 */
describe('env.validation — import upload limits', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    JWT_ACCESS_SECRET: 's',
    JWT_REFRESH_SECRET: 's',
  };

  it('applies the documented defaults when the vars are absent', () => {
    const cfg = validate({ ...base });
    expect(cfg.MAX_IMPORT_FILE_BYTES).toBe(5242880); // 5 MiB
    expect(cfg.IMPORT_CONCURRENCY_PERMITS).toBe(4);
  });

  it('accepts valid overrides and coerces the numeric strings from env', () => {
    const cfg = validate({ ...base, MAX_IMPORT_FILE_BYTES: '1048576', IMPORT_CONCURRENCY_PERMITS: '8' });
    expect(cfg.MAX_IMPORT_FILE_BYTES).toBe(1048576);
    expect(cfg.IMPORT_CONCURRENCY_PERMITS).toBe(8);
  });

  it('rejects a non-integer byte limit', () => {
    expect(() => validate({ ...base, MAX_IMPORT_FILE_BYTES: '1.5' })).toThrow();
    expect(() => validate({ ...base, MAX_IMPORT_FILE_BYTES: 'abc' })).toThrow();
  });

  it('rejects a byte limit below the floor and above the ceiling', () => {
    expect(() => validate({ ...base, MAX_IMPORT_FILE_BYTES: '1024' })).toThrow(); // < 64 KiB
    expect(() => validate({ ...base, MAX_IMPORT_FILE_BYTES: '52428800' })).toThrow(); // > 20 MiB
  });

  it('rejects zero, negative, and excessive permit counts', () => {
    expect(() => validate({ ...base, IMPORT_CONCURRENCY_PERMITS: '0' })).toThrow();
    expect(() => validate({ ...base, IMPORT_CONCURRENCY_PERMITS: '-1' })).toThrow();
    expect(() => validate({ ...base, IMPORT_CONCURRENCY_PERMITS: '13' })).toThrow(); // > 12
  });

  // #174: the storage URL allowlist anchors on STORAGE_PUBLIC_URL, so a
  // present-but-broken value must fail the boot, not silently reject every
  // image registration at runtime.
  describe('STORAGE_PUBLIC_URL', () => {
    it('accepts http(s) URLs, including localhost for dev', () => {
      expect(() => validate({ ...base, STORAGE_PUBLIC_URL: 'https://cdn.example.com' })).not.toThrow();
      expect(() => validate({ ...base, STORAGE_PUBLIC_URL: 'http://localhost:9000/bucket' })).not.toThrow();
    });

    it('allows the var to be absent or empty (storage-less environments fail closed at runtime)', () => {
      expect(() => validate({ ...base })).not.toThrow();
      expect(() => validate({ ...base, STORAGE_PUBLIC_URL: '' })).not.toThrow();
    });

    it('rejects garbage and non-http(s) schemes at boot', () => {
      expect(() => validate({ ...base, STORAGE_PUBLIC_URL: 'not a url' })).toThrow();
      expect(() => validate({ ...base, STORAGE_PUBLIC_URL: 'cdn.example.com' })).toThrow(); // no protocol
      expect(() => validate({ ...base, STORAGE_PUBLIC_URL: 'ftp://cdn.example.com' })).toThrow();
    });
  });

  // #181: the rate-limit mode is explicit, and the Redis vars are enforced only
  // in distributed-redis mode — present-but-ignored in memory mode so an
  // operator can preconfigure them and roll back the mode alone.
  describe('RATE_LIMIT_MODE and the Redis vars', () => {
    const REDISS = 'rediss://default:pw@apple-1.upstash.io:6379';

    it('defaults to memory mode when unset (test env)', () => {
      const cfg = validate({ ...base });
      expect(cfg.RATE_LIMIT_MODE).toBe('memory');
    });

    it('defaults to memory mode when unset in development', () => {
      const cfg = validate({ ...base, NODE_ENV: 'development' });
      expect(cfg.RATE_LIMIT_MODE).toBe('memory');
    });

    it('rejects an unknown RATE_LIMIT_MODE even in the absence of Redis vars', () => {
      expect(() => validate({ ...base, RATE_LIMIT_MODE: 'distributed' })).toThrow();
      expect(() => validate({ ...base, RATE_LIMIT_MODE: 'redis' })).toThrow();
    });

    // Production must choose the mode explicitly, so a scaled deployment can
    // never silently fall back to per-instance counters. NODE_ENV only gates
    // whether omission is allowed — it never selects the mode.
    describe('NODE_ENV=production requires an explicit mode', () => {
      const prod = { ...base, NODE_ENV: 'production' };

      it('fails validation when RATE_LIMIT_MODE is missing', () => {
        expect(() => validate({ ...prod })).toThrow();
      });

      it('accepts an explicit memory (approved rollback / single-instance)', () => {
        expect(() => validate({ ...prod, RATE_LIMIT_MODE: 'memory' })).not.toThrow();
        expect(validate({ ...prod, RATE_LIMIT_MODE: 'memory' }).RATE_LIMIT_MODE).toBe('memory');
      });

      it('accepts distributed-redis with a valid URL and prefix', () => {
        expect(() =>
          validate({
            ...prod,
            RATE_LIMIT_MODE: 'distributed-redis',
            REDIS_URL: REDISS,
            RATE_LIMIT_KEY_PREFIX: 'cataloguer:production:',
          }),
        ).not.toThrow();
      });

      it('rejects an invalid mode even in production', () => {
        expect(() => validate({ ...prod, RATE_LIMIT_MODE: 'redis' })).toThrow();
      });
    });

    describe('memory mode', () => {
      it('needs neither REDIS_URL nor RATE_LIMIT_KEY_PREFIX', () => {
        expect(() => validate({ ...base, RATE_LIMIT_MODE: 'memory' })).not.toThrow();
      });

      it('IGNORES present-but-invalid Redis vars (they are inert in memory mode)', () => {
        expect(() =>
          validate({
            ...base,
            RATE_LIMIT_MODE: 'memory',
            REDIS_URL: 'not-a-redis-url',
            RATE_LIMIT_KEY_PREFIX: 'NOT VALID!!',
          }),
        ).not.toThrow();
      });
    });

    describe('distributed-redis mode', () => {
      const dist = { ...base, RATE_LIMIT_MODE: 'distributed-redis' };

      it('accepts a valid rediss:// URL and a well-formed prefix', () => {
        expect(() =>
          validate({ ...dist, REDIS_URL: REDISS, RATE_LIMIT_KEY_PREFIX: 'cataloguer:staging:' }),
        ).not.toThrow();
      });

      it('requires REDIS_URL', () => {
        expect(() => validate({ ...dist, RATE_LIMIT_KEY_PREFIX: 'cataloguer:staging:' })).toThrow();
      });

      it('requires RATE_LIMIT_KEY_PREFIX', () => {
        expect(() => validate({ ...dist, REDIS_URL: REDISS })).toThrow();
      });

      it('rejects a plaintext redis:// URL to a non-loopback host (must be TLS)', () => {
        expect(() =>
          validate({
            ...dist,
            REDIS_URL: 'redis://apple-1.upstash.io:6379',
            RATE_LIMIT_KEY_PREFIX: 'cataloguer:staging:',
          }),
        ).toThrow();
      });

      it('allows plaintext redis:// only for a loopback host (local proof)', () => {
        expect(() =>
          validate({
            ...dist,
            REDIS_URL: 'redis://127.0.0.1:6379',
            RATE_LIMIT_KEY_PREFIX: 'cataloguer:test:',
          }),
        ).not.toThrow();
      });

      it('rejects a malformed prefix (uppercase, wildcard, or missing trailing colon)', () => {
        const url = REDISS;
        expect(() => validate({ ...dist, REDIS_URL: url, RATE_LIMIT_KEY_PREFIX: 'Cataloguer:staging:' })).toThrow();
        expect(() => validate({ ...dist, REDIS_URL: url, RATE_LIMIT_KEY_PREFIX: 'cataloguer:*:' })).toThrow();
        expect(() => validate({ ...dist, REDIS_URL: url, RATE_LIMIT_KEY_PREFIX: 'cataloguer:staging' })).toThrow();
      });
    });
  });
});
