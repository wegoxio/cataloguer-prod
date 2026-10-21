import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ImportSourceStorageService } from '../import-source-storage.service';

/**
 * The signed ticket and the bucket's CORS policy must agree.
 *
 * They did not, and the failure mode was as bad as it gets: the ticket signed
 * `If-None-Match: *` for create-only semantics, so a browser had to send it —
 * but the bucket allowed only `Content-Type` and `Content-Length`, so the
 * preflight was refused and EVERY browser upload failed with an opaque
 * "Failed to fetch". No status, no body, nothing in the backend logs beyond a
 * successful ticket request.
 *
 * The Phase B provider gate did not catch it because CORS is enforced by
 * browsers, not by Node: the gate uploaded successfully from a script while the
 * product was unusable. A mocked fetch would not have caught it either, for the
 * same reason — the constraint lives at the provider, not in our code.
 *
 * So this test does the one thing that CAN be checked without a browser: it
 * derives the required header set from the SHIPPED ticket and asserts the
 * documented bucket policy covers it. The manifest is what the bucket is
 * configured from, so a header the ticket needs and the manifest omits is a
 * misconfigured bucket waiting to happen.
 *
 * The live browser-origin preflight itself is gate 1b in
 * `docs/aws-architecture.es.md`, run against the real bucket.
 */

const MANIFEST = path.join(__dirname, '..', '../../../../../docs/aws-architecture.es.md');

describe('the signed upload ticket and the bucket CORS policy agree', () => {
  const required = ImportSourceStorageService.REQUIRED_CORS_ALLOWED_HEADERS;

  it('the ticket returns exactly the headers declared as required', async () => {
    // A real ticket, from the shipped service, with deterministic credentials.
    const config = new ConfigService({
      IMPORT_SOURCE_BUCKET: 'test-bucket',
      IMPORT_SOURCE_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      IMPORT_SOURCE_ACCESS_KEY_ID: 'a'.repeat(32),
      IMPORT_SOURCE_SECRET_ACCESS_KEY: 'b'.repeat(64),
      IMPORT_SOURCE_BUCKET_PRIVATE: 'true',
    });
    const service = new ImportSourceStorageService(config);

    const ticket = await service.createUploadTicket(
      '11111111-1111-1111-1111-111111111111',
      'products.csv',
      'text/csv',
      577,
    );

    // Not a subset check in either direction — they must be the SAME set, so a
    // header added to one and forgotten in the other fails here.
    expect(Object.keys(ticket.headers).sort()).toEqual([...required].sort());
  });

  it('every required header is documented as CORS-allowed', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    const row = manifest.split('\n').find((line) => /^\|\s*Allowed headers/i.test(line));

    expect(row).toBeDefined();
    const missing = required.filter((header) => !new RegExp(`\`${header}\``, 'i').test(row as string));

    expect(missing).toEqual([]);
  });

  it('the manifest allows no header the ticket does not actually send', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    const row = manifest.split('\n').find((line) => /^\|\s*Allowed headers/i.test(line)) as string;
    const documented = [...row.matchAll(/`([A-Za-z-]+)`/g)].map((m) => m[1]);

    // A wider policy than the ticket needs is not a failure of the upload, but
    // it is a wider hole than the design calls for, and nobody would notice.
    const extra = documented.filter((h) => !required.some((r) => r.toLowerCase() === h.toLowerCase()));
    expect(extra).toEqual([]);
  });
});
