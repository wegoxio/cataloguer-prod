import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes, randomUUID } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  ImportSourceStorageService,
  SOURCE_RETENTION_DAYS,
  assertKeyBelongsTo,
  isSourceExpired,
} from '../import-source-storage.service';
import { FakeS3, S3Error } from '../__fixtures__/s3-fake';

/**
 * The private-storage contract, proven end to end against a deterministic fake.
 *
 * Import sources are tenant documents — prices, costs, supplier terms, customer
 * names. The asset bucket is publicly readable by design, so almost every
 * property here is really the same property stated twelve ways: bytes that
 * belong to one organization must never become reachable by anyone else, and
 * the failure mode must always be "unavailable" rather than "readable".
 *
 * Credentials are generated per run rather than written down. Presigning needs
 * *some* key material, but none of it is a real credential and none of it is
 * committed, printed or asserted on.
 */

const SOURCE_BUCKET = 'cataloguer-import-sources';
const PUBLIC_ASSET_BUCKET = 'cataloguer-staging-images';

/** Throwaway key material, never a real credential and never logged. */
function ephemeralCredentials(): Record<string, string> {
  return {
    IMPORT_SOURCE_ACCESS_KEY_ID: randomBytes(10).toString('hex'),
    IMPORT_SOURCE_SECRET_ACCESS_KEY: randomBytes(20).toString('hex'),
  };
}

function makeService(overrides: Record<string, string | undefined> = {}): ImportSourceStorageService {
  const values: Record<string, string | undefined> = {
    ...ephemeralCredentials(),
    STORAGE_BUCKET: PUBLIC_ASSET_BUCKET,
    IMPORT_SOURCE_BUCKET: SOURCE_BUCKET,
    IMPORT_SOURCE_BUCKET_PRIVATE: 'true',
    STORAGE_REGION: 'auto',
    IMPORT_SOURCE_ENDPOINT: 'https://example-account.r2.cloudflarestorage.example',
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  return new ImportSourceStorageService(config);
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

let fake: FakeS3;

beforeEach(() => {
  fake = new FakeS3();
  // The service builds its own client; intercepting `send` keeps the production
  // wiring untouched while every request lands in the fake.
  jest.spyOn(S3Client.prototype, 'send').mockImplementation(function (this: S3Client, command: unknown) {
    return fake.send(command);
  } as never);
});

afterEach(() => jest.restoreAllMocks());

describe('refusing to operate on anything but a private bucket', () => {
  it('refuses when no import-source bucket is configured', () => {
    const svc = makeService({ IMPORT_SOURCE_BUCKET: undefined });
    expect(svc.isConfigured).toBe(false);
    expect(svc.configurationProblem()).toMatch(/IMPORT_SOURCE_BUCKET is not set/);
  });

  it('refuses when pointed at the public asset bucket', () => {
    // The failure this prevents is not a broken feature; it is publishing
    // someone's price list at a guessable URL.
    const svc = makeService({ IMPORT_SOURCE_BUCKET: PUBLIC_ASSET_BUCKET });
    expect(svc.isConfigured).toBe(false);
    expect(svc.configurationProblem()).toMatch(/must not be the public asset bucket/);
  });

  it('refuses a bucket that has not been explicitly affirmed private', () => {
    for (const value of [undefined, '', 'false', 'TRUE', 'yes', '1']) {
      const svc = makeService({ IMPORT_SOURCE_BUCKET_PRIVATE: value });
      expect(svc.isConfigured).toBe(false);
      expect(svc.configurationProblem()).toMatch(/IMPORT_SOURCE_BUCKET_PRIVATE must be set to "true"/);
    }
    // Only the exact affirmation opens the door.
    expect(makeService({ IMPORT_SOURCE_BUCKET_PRIVATE: 'true' }).isConfigured).toBe(true);
  });

  it('refuses without credentials, and never falls back to the public bucket', async () => {
    const svc = makeService({
      IMPORT_SOURCE_ACCESS_KEY_ID: undefined,
      IMPORT_SOURCE_SECRET_ACCESS_KEY: undefined,
    });
    expect(svc.isConfigured).toBe(false);
    await expect(svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1024)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Nothing was attempted anywhere — least of all against the asset bucket.
    expect(fake.calls).toHaveLength(0);
  });

  it('never borrows the asset-bucket credentials to reach the private bucket', async () => {
    // A shared token would mean one leak exposes both buckets, and would make
    // the access log unable to tell import traffic from product-photo traffic.
    // Asset credentials being present must not make imports available.
    const svc = makeService({
      IMPORT_SOURCE_ACCESS_KEY_ID: undefined,
      IMPORT_SOURCE_SECRET_ACCESS_KEY: undefined,
      STORAGE_ACCESS_KEY_ID: randomBytes(10).toString('hex'),
      STORAGE_SECRET_ACCESS_KEY: randomBytes(20).toString('hex'),
    });
    expect(svc.isConfigured).toBe(false);
    expect(svc.configurationProblem()).toMatch(/IMPORT_SOURCE_ACCESS_KEY_ID/);
    await expect(svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1024)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('tells the operator what is wrong but tells the tenant nothing', async () => {
    const svc = makeService({ IMPORT_SOURCE_BUCKET: undefined });
    await expect(svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1024)).rejects.toThrow(
      'Imports are not available right now.',
    );
    // The operator-facing text names the variable; the tenant-facing text must not.
    expect(svc.configurationProblem()).toContain('IMPORT_SOURCE_BUCKET');
  });
});

describe('1. tenant-scoped object keys', () => {
  it('mints keys under the requesting organization, never from the filename', () => {
    const svc = makeService();
    const key = svc.buildObjectKey(ORG_A, 'Q3 prices.csv');
    expect(key.startsWith(`imports/${ORG_A}/`)).toBe(true);
    expect(key).toMatch(/\.csv$/);
    // The original name contributes nothing but its extension: no spaces, no
    // path segments, no chance for a filename to steer the key.
    expect(key).not.toContain('prices');
    expect(key).not.toContain(' ');
  });

  it('gives a fresh key to every upload, so two uploads never collide', () => {
    const svc = makeService();
    const keys = new Set(Array.from({ length: 200 }, () => svc.buildObjectKey(ORG_A, 'same-name.csv')));
    expect(keys.size).toBe(200);
  });

  it('drops an unrecognised or dangerous extension rather than carrying it', () => {
    const svc = makeService();
    for (const name of ['payload.exe', 'sheet.ods', 'legacy.xls', 'x.csv.exe', '../../etc/passwd']) {
      const key = svc.buildObjectKey(ORG_A, name);
      expect(key.startsWith(`imports/${ORG_A}/`)).toBe(true);
      expect(key).not.toMatch(/\.(exe|ods|xls)$/);
      expect(key).not.toContain('..');
    }
  });
});

describe('2. immutable source hash', () => {
  it('is stable, content-addressed and sensitive to a single byte', () => {
    const bytes = Buffer.from('sku,price\nA-1,10.00\n');
    const hash = ImportSourceStorageService.contentHash(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ImportSourceStorageService.contentHash(Buffer.from(bytes))).toBe(hash);
    expect(ImportSourceStorageService.contentHash(Buffer.from('sku,price\nA-1,10.01\n'))).not.toBe(hash);
  });

  it('is independent of the key, so re-uploading the same file is recognisable', () => {
    // The same document uploaded twice gets two keys but one identity, which is
    // what lets the wizard say "you already imported this".
    const bytes = Buffer.from('a,b\n1,2\n');
    const svc = makeService();
    svc.buildObjectKey(ORG_A, 'first.csv');
    svc.buildObjectKey(ORG_B, 'second.csv');
    expect(ImportSourceStorageService.contentHash(bytes)).toBe(ImportSourceStorageService.contentHash(bytes));
  });
});

describe('3. signed upload and download', () => {
  it('returns a signed URL that carries no credential and no raw secret', async () => {
    const svc = makeService();
    const ticket = await svc.createUploadTicket(ORG_A, 'prices.csv', 'text/csv', 5 * 1024 * 1024);
    const url = new URL(ticket.url);

    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // The credential scope names the access key id, as SigV4 requires, but the
    // secret must never appear anywhere in the URL.
    const secret = (svc as unknown as { config: { get(k: string): string } }).config.get(
      'IMPORT_SOURCE_SECRET_ACCESS_KEY',
    );
    expect(ticket.url).not.toContain(secret);
  });

  it('signs a download URL for a derived artifact', async () => {
    const svc = makeService();
    const key = svc.buildArtifactKey(ORG_A, randomUUID(), 'report.csv');
    const url = await svc.createDownloadUrl(key, ORG_A, 'ARTIFACT');
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url).toContain(encodeURIComponent(key).replace(/%2F/g, '/'));
  });

  it('produces a different signature for a different key or content type', async () => {
    // Evidence that the signature actually covers what the ticket claims it
    // covers, rather than being a constant decoration on the URL.
    const svc = makeService();
    const a = await svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1000);
    const b = await svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1000);
    const c = await svc.createUploadTicket(ORG_A, 'a.xlsx', 'application/vnd.ms-excel', 1000);
    const sig = (t: { url: string }) => new URL(t.url).searchParams.get('X-Amz-Signature');
    expect(sig(a)).not.toBe(sig(b));
    expect(sig(a)).not.toBe(sig(c));
  });
});

describe('4. expiry', () => {
  it('signs uploads for minutes, not hours', async () => {
    const svc = makeService();
    const ticket = await svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1000);
    expect(ticket.expiresInSeconds).toBe(300);
    expect(Number(new URL(ticket.url).searchParams.get('X-Amz-Expires'))).toBe(300);
  });

  it('signs downloads for the same short window', async () => {
    const svc = makeService();
    const url = await svc.createDownloadUrl(`imports/${ORG_A}/${randomUUID()}.csv`, ORG_A, 'SOURCE');
    expect(Number(new URL(url).searchParams.get('X-Amz-Expires'))).toBe(300);
  });
});

describe('5. content-length and content-type constraints', () => {
  it('binds both into the signature and hands them back as required headers', async () => {
    const svc = makeService();
    const maxBytes = 2 * 1024 * 1024;
    const ticket = await svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', maxBytes);

    const signedHeaders = new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signedHeaders).toContain('content-length');
    expect(signedHeaders).toContain('content-type');

    expect(ticket.headers['Content-Length']).toBe(String(maxBytes));
    expect(ticket.headers['Content-Type']).toBe('text/csv');
    expect(ticket.maxBytes).toBe(maxBytes);
  });

  it('hands back EVERY header it signed, so the request the browser sends is the request we signed', async () => {
    // Derived from the URL rather than listed here, so adding a signed header
    // to the command without handing it to the client fails immediately.
    //
    // This is not hypothetical. `IfNoneMatch: '*'` puts `if-none-match` into
    // the signature, it was absent from `headers`, and against the real bucket
    // EVERY upload answered 403 — Content-Type alone 403, Content-Type plus
    // If-None-Match 200. A deterministic store cannot catch it: with no signing
    // key it accepts whatever arrives, so both sides of the fake agreed.
    const svc = makeService();
    const ticket = await svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1024);

    const signed = (new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders') ?? '')
      .split(';')
      .filter((header) => header !== 'host');
    const given = Object.keys(ticket.headers).map((header) => header.toLowerCase());

    const missing = signed.filter((header) => !given.includes(header));
    expect(missing).toEqual([]);
  });

  it('makes the upload create-only, and says so in the headers it returns', async () => {
    const svc = makeService();
    const ticket = await svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1024);

    // A signed URL that silently replaced an object would turn a leaked or
    // replayed ticket into a way to swap the bytes underneath a plan somebody
    // already reviewed and approved.
    expect(new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders')).toContain('if-none-match');
    expect(ticket.headers['If-None-Match']).toBe('*');
  });

  it('the store refuses a body larger than the signed length', async () => {
    // Proving the limit is enforced by the store, not merely advertised by us.
    const key = `imports/${ORG_A}/${randomUUID()}.csv`;
    await expect(
      fake.send(
        new PutObjectCommand({
          Bucket: SOURCE_BUCKET,
          Key: key,
          Body: Buffer.alloc(2048),
          ContentLength: 1024,
        }),
      ),
    ).rejects.toMatchObject({ name: 'EntityTooLarge' });
    expect(fake.has(SOURCE_BUCKET, key)).toBe(false);
  });
});

describe('6. no overwrite', () => {
  it('signs a create-only upload, so a replayed ticket cannot swap the bytes', async () => {
    const svc = makeService();
    const ticket = await svc.createUploadTicket(ORG_A, 'a.csv', 'text/csv', 1024);

    const original = Buffer.from('sku,price\nA-1,10.00\n');
    await fake.send(
      new PutObjectCommand({
        Bucket: SOURCE_BUCKET,
        Key: ticket.objectKey,
        Body: original,
        ContentLength: 1024,
        IfNoneMatch: '*',
      }),
    );

    // The same ticket, replayed with different content. An approved plan was
    // reviewed against the original bytes; letting them be replaced silently
    // would make the approval meaningless.
    await expect(
      fake.send(
        new PutObjectCommand({
          Bucket: SOURCE_BUCKET,
          Key: ticket.objectKey,
          Body: Buffer.from('sku,price\nA-1,0.01\n'),
          ContentLength: 1024,
          IfNoneMatch: '*',
        }),
      ),
    ).rejects.toBeInstanceOf(S3Error);

    expect(fake.get(SOURCE_BUCKET, ticket.objectKey)!.body.equals(original)).toBe(true);
  });
});

describe('7. read-back verification', () => {
  it('returns exactly the bytes that were stored, hash included', async () => {
    const svc = makeService();
    const bytes = Buffer.from('sku,name,price\nA-1,Widget,10.00\nA-2,Gadget,12.50\n');
    const key = svc.buildObjectKey(ORG_A, 'prices.csv');
    fake.seed(SOURCE_BUCKET, key, bytes);

    const readBack = await svc.read(key, ORG_A);
    expect(readBack.equals(bytes)).toBe(true);
    expect(ImportSourceStorageService.contentHash(readBack)).toBe(ImportSourceStorageService.contentHash(bytes));
  });

  it('reassembles a body that arrives in several chunks', async () => {
    // The real client streams; a read that only ever saw one chunk would be a
    // read that silently truncates large sources.
    const svc = makeService();
    const big = Buffer.concat(Array.from({ length: 64 }, (_, i) => Buffer.alloc(1024, i)));
    const key = svc.buildObjectKey(ORG_A, 'big.csv');
    fake.seed(SOURCE_BUCKET, key, big);
    const readBack = await svc.read(key, ORG_A);
    expect(readBack.length).toBe(big.length);
    expect(readBack.equals(big)).toBe(true);
  });
});

describe('8. cross-tenant refusal', () => {
  it("refuses another organization's key before any network call", async () => {
    const svc = makeService();
    const keyOfA = svc.buildObjectKey(ORG_A, 'prices.csv');
    fake.seed(SOURCE_BUCKET, keyOfA, Buffer.from('secret,data\n'));

    await expect(svc.read(keyOfA, ORG_B)).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The decisive assertion: the request never left the process, so no audit
    // trail elsewhere has to be trusted to have caught it.
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses traversal and prefix-confusion attempts on the tenant segment', () => {
    const almost = [
      `imports/${ORG_B}/../${ORG_A}/x.csv`,
      `imports/${ORG_A}x/x.csv`,
      `imports/${ORG_A}`,
      `imports//x.csv`,
      `../imports/${ORG_A}/x.csv`,
      `IMPORTS/${ORG_A}/x.csv`,
    ];
    for (const key of almost) {
      expect(() => assertKeyBelongsTo(key, ORG_A)).toThrow(ServiceUnavailableException);
    }
    expect(() => assertKeyBelongsTo(`imports/${ORG_A}/ok.csv`, ORG_A)).not.toThrow();
  });

  it('refuses a delete aimed at another tenant', async () => {
    const svc = makeService();
    const keyOfA = svc.buildObjectKey(ORG_A, 'prices.csv');
    fake.seed(SOURCE_BUCKET, keyOfA, Buffer.from('x'));
    await expect(svc.delete(keyOfA, ORG_B)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fake.has(SOURCE_BUCKET, keyOfA)).toBe(true);
  });

  it('refuses a signed download minted for another tenant', async () => {
    const svc = makeService();
    const keyOfA = svc.buildObjectKey(ORG_A, 'prices.csv');
    await expect(svc.createDownloadUrl(keyOfA, ORG_B, 'SOURCE')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('9. expired source refusal', () => {
  const uploadedAt = new Date('2026-01-01T00:00:00.000Z');
  const dayAfter = (days: number) => new Date(uploadedAt.getTime() + days * 24 * 60 * 60 * 1000);

  it('treats the retention window as ninety days', () => {
    expect(SOURCE_RETENTION_DAYS).toBe(90);
    expect(isSourceExpired(uploadedAt, dayAfter(89))).toBe(false);
    expect(isSourceExpired(uploadedAt, dayAfter(90))).toBe(false);
    expect(isSourceExpired(uploadedAt, dayAfter(91))).toBe(true);
  });

  it('refuses an over-age source on our own clock, not the provider lifecycle', async () => {
    // The lifecycle rule runs on the provider's schedule. If the application
    // waited for it, a source could stay readable for days past its stated
    // retention — so the refusal happens here, before the fetch.
    const svc = makeService();
    const key = svc.buildObjectKey(ORG_A, 'old.csv');
    fake.seed(SOURCE_BUCKET, key, Buffer.from('still,here\n'));

    await expect(svc.read(key, ORG_A, { uploadedAt, now: dayAfter(120) })).rejects.toThrow(
      /no longer available. Upload it again/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('still reads a source inside the window', async () => {
    const svc = makeService();
    const key = svc.buildObjectKey(ORG_A, 'recent.csv');
    fake.seed(SOURCE_BUCKET, key, Buffer.from('fresh\n'));
    await expect(svc.read(key, ORG_A, { uploadedAt, now: dayAfter(30) })).resolves.toBeInstanceOf(Buffer);
  });

  it('does not apply source retention to a derived artifact', async () => {
    // A report has to outlive the document it describes: it is the record of
    // what was changed in the customer's catalogue.
    const svc = makeService();
    const key = svc.buildArtifactKey(ORG_A, randomUUID(), 'report.csv');
    fake.seed(SOURCE_BUCKET, key, Buffer.from('row,outcome\n1,created\n'));
    await expect(svc.read(key, ORG_A, { scope: 'ARTIFACT', uploadedAt, now: dayAfter(400) })).resolves.toBeInstanceOf(
      Buffer,
    );
  });
});

describe('10. deletion after retention', () => {
  it('removes the object and leaves nothing else behind', async () => {
    const svc = makeService();
    const mine = svc.buildObjectKey(ORG_A, 'a.csv');
    const theirs = svc.buildObjectKey(ORG_B, 'b.csv');
    fake.seed(SOURCE_BUCKET, mine, Buffer.from('a'));
    fake.seed(SOURCE_BUCKET, theirs, Buffer.from('b'));

    await svc.delete(mine, ORG_A);

    expect(fake.has(SOURCE_BUCKET, mine)).toBe(false);
    expect(fake.has(SOURCE_BUCKET, theirs)).toBe(true);
  });

  it('is idempotent, so a repeated cleanup is not an error', async () => {
    const svc = makeService();
    const key = svc.buildObjectKey(ORG_A, 'a.csv');
    fake.seed(SOURCE_BUCKET, key, Buffer.from('a'));
    await svc.delete(key, ORG_A);
    await expect(svc.delete(key, ORG_A)).resolves.toBeUndefined();
  });
});

describe('11. failed upload cleanup', () => {
  it('removes bytes from an upload that was never registered', async () => {
    // A ticket that is signed and abandoned leaves a copy of a customer's
    // document that nothing references — which is precisely why it has to be
    // removed deliberately rather than left for a lifecycle rule.
    const svc = makeService();
    const ticket = await svc.createUploadTicket(ORG_A, 'abandoned.csv', 'text/csv', 1024);
    fake.seed(SOURCE_BUCKET, ticket.objectKey, Buffer.from('half,written\n'));

    await expect(svc.cleanupAbandonedUpload(ticket.objectKey, ORG_A)).resolves.toBe(true);
    expect(fake.has(SOURCE_BUCKET, ticket.objectKey)).toBe(false);
  });

  it('never turns a failed cleanup into a second failure for the caller', async () => {
    // Cleanup runs on paths already handling an earlier error. Reporting
    // "the import failed and so did the tidy-up" helps nobody.
    const svc = makeService();
    const key = svc.buildObjectKey(ORG_A, 'a.csv');
    jest.spyOn(S3Client.prototype, 'send').mockImplementation((() => {
      throw new S3Error('InternalError', 500, 'We encountered an internal error.');
    }) as never);

    await expect(svc.cleanupAbandonedUpload(key, ORG_A)).resolves.toBe(false);
  });

  it('still refuses to clean up another tenant', async () => {
    const svc = makeService();
    const keyOfA = svc.buildObjectKey(ORG_A, 'a.csv');
    fake.seed(SOURCE_BUCKET, keyOfA, Buffer.from('a'));
    await expect(svc.cleanupAbandonedUpload(keyOfA, ORG_B)).resolves.toBe(false);
    expect(fake.has(SOURCE_BUCKET, keyOfA)).toBe(true);
  });
});

describe('12. source versus derived-artifact separation', () => {
  it('mints the two under different prefixes', () => {
    const svc = makeService();
    const source = svc.buildObjectKey(ORG_A, 'prices.csv');
    const artifact = svc.buildArtifactKey(ORG_A, randomUUID(), 'report.csv');
    expect(source.startsWith(`imports/${ORG_A}/`)).toBe(true);
    expect(artifact.startsWith(`import-artifacts/${ORG_A}/`)).toBe(true);
    expect(artifact.startsWith('imports/')).toBe(false);
  });

  it('refuses to read a source through the artifact path and the reverse', async () => {
    // Reading a source as though it were a report is how a 90-day expiry
    // quietly becomes permanent retention of a customer's document.
    const svc = makeService();
    const source = svc.buildObjectKey(ORG_A, 'prices.csv');
    const artifact = svc.buildArtifactKey(ORG_A, randomUUID(), 'report.csv');
    fake.seed(SOURCE_BUCKET, source, Buffer.from('a'));
    fake.seed(SOURCE_BUCKET, artifact, Buffer.from('b'));

    await expect(svc.read(source, ORG_A, { scope: 'ARTIFACT' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.read(artifact, ORG_A, { scope: 'SOURCE' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fake.calls).toHaveLength(0);
  });

  it('confines an artifact key to its own execution folder', () => {
    const svc = makeService();
    const executionId = randomUUID();
    const key = svc.buildArtifactKey(ORG_A, executionId, 'report.csv');
    expect(key).toContain(`/${executionId}/`);
    expect(key).not.toContain('..');
  });

  it('only allows report-shaped extensions on artifacts', () => {
    const svc = makeService();
    const key = svc.buildArtifactKey(ORG_A, randomUUID(), 'report.xlsm');
    expect(key).not.toMatch(/\.xlsm$/);
  });
});
