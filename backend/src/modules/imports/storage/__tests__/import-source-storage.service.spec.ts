import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImportSourceStorageService, assertKeyBelongsTo, safeExtension } from '../import-source-storage.service';

const config = (values: Record<string, string | undefined>): ConfigService =>
  ({ get: (k: string) => values[k] }) as unknown as ConfigService;

const CREDS = {
  IMPORT_SOURCE_ACCESS_KEY_ID: 'key',
  IMPORT_SOURCE_SECRET_ACCESS_KEY: 'secret',
};

/** The operator's explicit affirmation that the bucket is not public. */
const PRIVATE = { IMPORT_SOURCE_BUCKET_PRIVATE: 'true' };

describe('import source storage', () => {
  describe('private-by-configuration', () => {
    it('REFUSES to use the public asset bucket, because sources would become world-readable', () => {
      // The whole point of a separate bucket. Sharing STORAGE_BUCKET would
      // inherit its public read policy (ADR 006) and publish tenant documents.
      const svc = new ImportSourceStorageService(
        config({
          ...CREDS,
          ...PRIVATE,
          STORAGE_BUCKET: 'cataloguer-images',
          IMPORT_SOURCE_BUCKET: 'cataloguer-images',
        }),
      );
      expect(svc.isConfigured).toBe(false);
      expect(svc.configurationProblem()).toMatch(/must not be the public asset bucket/i);
    });

    it('is unconfigured when the import bucket is missing', () => {
      const svc = new ImportSourceStorageService(config({ ...CREDS, ...PRIVATE, STORAGE_BUCKET: 'assets' }));
      expect(svc.isConfigured).toBe(false);
      expect(svc.configurationProblem()).toMatch(/IMPORT_SOURCE_BUCKET is not set/);
    });

    it('is unconfigured without credentials', () => {
      const svc = new ImportSourceStorageService(
        config({ ...PRIVATE, STORAGE_BUCKET: 'assets', IMPORT_SOURCE_BUCKET: 'private-imports' }),
      );
      expect(svc.isConfigured).toBe(false);
      expect(svc.configurationProblem()).toMatch(/credentials/i);
      expect(svc.configurationProblem()).toMatch(/IMPORT_SOURCE_ACCESS_KEY_ID/);
    });

    it('is unconfigured until the bucket is explicitly affirmed private', () => {
      // Nothing inside the process can observe whether a bucket has a public
      // development URL, and guessing wrong publishes tenant documents — so the
      // affirmation is required rather than inferred.
      const svc = new ImportSourceStorageService(
        config({ ...CREDS, STORAGE_BUCKET: 'assets', IMPORT_SOURCE_BUCKET: 'private-imports' }),
      );
      expect(svc.isConfigured).toBe(false);
      expect(svc.configurationProblem()).toMatch(/IMPORT_SOURCE_BUCKET_PRIVATE/);
    });

    it('is configured when the import bucket is separate and credentials exist', () => {
      const svc = new ImportSourceStorageService(
        config({ ...CREDS, ...PRIVATE, STORAGE_BUCKET: 'assets', IMPORT_SOURCE_BUCKET: 'private-imports' }),
      );
      expect(svc.isConfigured).toBe(true);
      expect(svc.configurationProblem()).toBeNull();
    });

    it('fails closed: a misconfigured service refuses to read rather than falling back', async () => {
      const svc = new ImportSourceStorageService(
        config({ ...CREDS, ...PRIVATE, STORAGE_BUCKET: 'assets', IMPORT_SOURCE_BUCKET: 'assets' }),
      );
      await expect(svc.read('imports/org-1/x.csv', 'org-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('never leaks bucket, endpoint or credentials in the tenant-facing message', async () => {
      const svc = new ImportSourceStorageService(
        config({
          ...CREDS,
          ...PRIVATE,
          STORAGE_BUCKET: 'assets',
          IMPORT_SOURCE_BUCKET: 'assets',
          STORAGE_ENDPOINT: 'https://secret.r2.example.com',
        }),
      );
      await expect(svc.read('imports/org-1/x.csv', 'org-1')).rejects.toThrow(/Imports are not available right now\./);
      await expect(svc.read('imports/org-1/x.csv', 'org-1')).rejects.not.toThrow(/secret|assets|r2/i);
    });
  });

  describe('server-minted keys', () => {
    const svc = new ImportSourceStorageService(
      config({ ...CREDS, ...PRIVATE, STORAGE_BUCKET: 'assets', IMPORT_SOURCE_BUCKET: 'private-imports' }),
    );

    it('scopes every key to the organization', () => {
      expect(svc.buildObjectKey('org-1', 'products.csv')).toMatch(/^imports\/org-1\/[0-9a-f-]{36}\.csv$/);
    });

    it('recomputes the extension from an allowlist instead of trusting the filename', () => {
      expect(safeExtension('a.csv')).toBe('.csv');
      expect(safeExtension('a.XLSX')).toBe('.xlsx');
      // Anything not allow-listed contributes no extension at all, so a name
      // cannot introduce a path segment or a surprising type.
      expect(safeExtension('a.php')).toBe('');
      expect(safeExtension('../../evil.sh')).toBe('');
      expect(safeExtension('noextension')).toBe('');
    });

    it('produces a distinct key per call', () => {
      expect(svc.buildObjectKey('org-1', 'x.csv')).not.toBe(svc.buildObjectKey('org-1', 'x.csv'));
    });
  });

  describe('tenant binding on read', () => {
    it('accepts a key that belongs to the caller', () => {
      expect(() => assertKeyBelongsTo('imports/org-1/abc.csv', 'org-1')).not.toThrow();
    });

    it("refuses another tenant's key", () => {
      expect(() => assertKeyBelongsTo('imports/org-2/abc.csv', 'org-1')).toThrow(ServiceUnavailableException);
    });

    it('refuses traversal inside an otherwise well-formed key', () => {
      expect(() => assertKeyBelongsTo('imports/org-1/../org-2/abc.csv', 'org-1')).toThrow();
    });

    it('refuses a key outside the imports prefix', () => {
      expect(() => assertKeyBelongsTo('assets/org-1/abc.csv', 'org-1')).toThrow();
    });
  });

  describe('content identity', () => {
    it('hashes content deterministically', () => {
      const a = ImportSourceStorageService.contentHash(Buffer.from('name,price\n1,2'));
      const b = ImportSourceStorageService.contentHash(Buffer.from('name,price\n1,2'));
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });

    it('distinguishes a one-byte change', () => {
      const a = ImportSourceStorageService.contentHash(Buffer.from('a'));
      const b = ImportSourceStorageService.contentHash(Buffer.from('b'));
      expect(a).not.toBe(b);
    });
  });
});
