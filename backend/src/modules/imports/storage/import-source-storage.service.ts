import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'crypto';

/**
 * Private storage for tenant import sources.
 *
 * The catalogue asset bucket is publicly readable by design (ADR 006): a known
 * URL stays fetchable, which is correct for product photography and completely
 * wrong for a spreadsheet of someone's prices, customers and costs. So import
 * sources live in their own bucket and this service refuses to start if that
 * bucket is not demonstrably a different, private one.
 *
 * The refusal is deliberate and load-bearing. A misconfiguration here does not
 * degrade a feature — it publishes tenant documents — so the failure mode has
 * to be "imports are unavailable", never "imports work and are readable by
 * anyone who guesses a URL".
 *
 * Access is always a short-lived signed operation against a server-minted key.
 * Callers never learn the bucket, the endpoint or any credential, and a key is
 * never accepted from a request: it is derived from the organization and a
 * fresh UUID, so one tenant cannot name another tenant's object.
 */

const SIGNED_URL_TTL_SECONDS = 300;

/**
 * How long an uploaded source stays readable.
 *
 * A bucket lifecycle rule enforces the same 90 days, but a lifecycle rule is
 * eventually consistent and runs on the provider's schedule. The application
 * refuses an over-age source on its own clock so "expired" is a guarantee we
 * make rather than one we hope the provider has already applied.
 */
export const SOURCE_RETENTION_DAYS = 90;

/**
 * Uploaded sources and the artifacts derived from them are different things
 * with different lifetimes: the customer's original document expires in 90
 * days, while the report explaining what was done to their catalogue has to
 * outlive it. Keeping them under separate prefixes lets one lifecycle rule
 * expire sources without touching reports, and lets a read for one refuse a key
 * belonging to the other.
 */
export type ObjectScope = 'SOURCE' | 'ARTIFACT';

const SCOPE_PREFIX: Record<ObjectScope, string> = {
  SOURCE: 'imports',
  ARTIFACT: 'import-artifacts',
};

export interface SourceUploadTicket {
  /** Server-minted object key. The caller echoes it back on registration. */
  objectKey: string;
  url: string;
  headers: Record<string, string>;
  maxBytes: number;
  expiresInSeconds: number;
}

@Injectable()
export class ImportSourceStorageService {
  private readonly logger = new Logger(ImportSourceStorageService.name);
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {}

  private get bucket(): string {
    return this.config.get<string>('IMPORT_SOURCE_BUCKET') || '';
  }

  private get assetBucket(): string {
    return this.config.get<string>('STORAGE_BUCKET') || '';
  }

  /**
   * Whether the operator has explicitly affirmed the bucket is private.
   *
   * Nothing observable from inside the process proves a bucket has no public
   * development URL, and the consequence of guessing wrong is publishing tenant
   * documents. So the affirmation is required, explicit, and exact: any value
   * other than `true` — including absent, empty, or "false" — leaves imports
   * unavailable.
   */
  private get privacyAffirmed(): boolean {
    return String(this.config.get<string>('IMPORT_SOURCE_BUCKET_PRIVATE') ?? '').trim() === 'true';
  }

  /**
   * Configured, provably separate from the public asset bucket, and affirmed
   * private.
   *
   * Sharing the asset bucket would inherit its public read policy, so the same
   * name is treated as a configuration error rather than a shortcut.
   */
  get isConfigured(): boolean {
    return this.configurationProblem() === null;
  }

  /** Why imports are unavailable, in operator terms. Never surfaced to tenants. */
  configurationProblem(): string | null {
    if (!this.bucket) return 'IMPORT_SOURCE_BUCKET is not set.';
    if (this.assetBucket && this.bucket === this.assetBucket) {
      return 'IMPORT_SOURCE_BUCKET must not be the public asset bucket (STORAGE_BUCKET); import sources would become publicly readable.';
    }
    if (!this.privacyAffirmed) {
      return 'IMPORT_SOURCE_BUCKET_PRIVATE must be set to "true" to affirm the import-source bucket has no public access or development URL.';
    }
    if (!this.credentials) {
      return 'Import source storage credentials (IMPORT_SOURCE_ACCESS_KEY_ID / IMPORT_SOURCE_SECRET_ACCESS_KEY) are not configured.';
    }
    return null;
  }

  /**
   * Credentials for the import bucket ALONE.
   *
   * There is deliberately no fallback to the asset-bucket credentials. A shared
   * token would mean one leak exposes both buckets, and would make the access
   * log unable to tell import traffic from product-photo traffic — so an absent
   * import credential leaves imports unavailable rather than quietly borrowing
   * the credential that can also read a public bucket.
   */
  private get credentials(): { accessKeyId: string; secretAccessKey: string } | null {
    const accessKeyId = this.config.get<string>('IMPORT_SOURCE_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('IMPORT_SOURCE_SECRET_ACCESS_KEY');
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
  }

  private getClient(): S3Client {
    const problem = this.configurationProblem();
    if (problem) {
      this.logger.error(`Import source storage unavailable: ${problem}`);
      throw new ServiceUnavailableException('Imports are not available right now.');
    }
    if (!this.client) {
      // The endpoint may be shared with asset storage — it identifies the
      // account, not the bucket, and reveals nothing the token does not already
      // imply. The credentials may not be.
      const endpoint = this.config.get<string>('IMPORT_SOURCE_ENDPOINT') || this.config.get<string>('STORAGE_ENDPOINT');
      this.client = new S3Client({
        region: this.config.get<string>('STORAGE_REGION') || 'auto',
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        credentials: this.credentials!,
      });
    }
    return this.client;
  }

  /**
   * Key layout: `{prefix}/{organizationId}/{uuid}{ext}`.
   *
   * The organization segment makes a stray object attributable and lets a
   * lifecycle rule expire a tenant's sources without touching anyone else's.
   * The extension is recomputed from an allowlist rather than taken from the
   * upload, so a filename cannot introduce a path segment or a surprising type.
   */
  buildObjectKey(organizationId: string, fileName: string): string {
    const ext = safeExtension(fileName);
    return `${SCOPE_PREFIX.SOURCE}/${organizationId}/${randomUUID()}${ext}`;
  }

  /** Key for something the import PRODUCED, which outlives the source. */
  buildArtifactKey(organizationId: string, executionId: string, suffix: string): string {
    const ext = safeArtifactExtension(suffix);
    return `${SCOPE_PREFIX.ARTIFACT}/${organizationId}/${executionId}/${randomUUID()}${ext}`;
  }

  async createUploadTicket(
    organizationId: string,
    fileName: string,
    contentType: string,
    maxBytes: number,
  ): Promise<SourceUploadTicket> {
    const client = this.getClient();
    const objectKey = this.buildObjectKey(organizationId, fileName);

    // Content-Length and Content-Type are signed in, so the browser cannot
    // exceed the size or change the declared type without breaking the
    // signature. The bytes are still verified server-side on registration —
    // a declared type is not evidence.
    //
    // IfNoneMatch makes the PUT create-only. Keys are UUID-minted so a
    // collision is already implausible, but a signed URL that would silently
    // replace an object is a different shape of risk: it turns a leaked or
    // replayed ticket into a way to swap the bytes underneath a plan that was
    // already reviewed and approved against the original.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
      ContentLength: maxBytes,
      IfNoneMatch: '*',
    });

    // `signableHeaders` is not decoration. Without it the SDK signs
    // `content-length;host;if-none-match` and drops `content-type` entirely —
    // so the ticket would advertise a type constraint that the signature never
    // bound, and any declared type would have been accepted. `unhoistableHeaders`
    // then keeps both as real headers instead of query parameters, so the
    // browser has to send the values it was signed for.
    const url = await getSignedUrl(client, command, {
      expiresIn: SIGNED_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
      unhoistableHeaders: new Set(['content-type', 'content-length']),
    });

    // EVERY signed header is handed back, `If-None-Match` included.
    //
    // `IfNoneMatch: '*'` above puts `if-none-match` into the signature, so a
    // client that does not send it is not sending the request that was signed,
    // and R2 answers 403 — on every upload, not in some edge case. The local
    // suite could not see this: a deterministic object store holds no signing
    // key and accepts whatever arrives, so the ticket looked complete from both
    // sides of the fake. The real provider refused it on the first try, which
    // is exactly what the mandatory pre-publication gate exists to catch.
    //
    // Measured against the real bucket: Content-Type alone → 403;
    // Content-Type plus If-None-Match → 200.
    return {
      objectKey,
      url,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(maxBytes),
        'If-None-Match': '*',
      },
      maxBytes,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    };
  }

  /**
   * The header names a BROWSER must be allowed to send on the signed PUT.
   *
   * This exists because the bucket's CORS policy and this ticket have to agree,
   * and once they did not: the policy allowed `Content-Type` and
   * `Content-Length`, the ticket also required `If-None-Match`, and every
   * browser upload died in the preflight with an opaque "Failed to fetch". The
   * server-side gate could not see it — CORS is enforced by browsers, not by
   * Node — so the provider gate passed while the product was unusable.
   *
   * Anything added to the returned `headers` above must appear here, and the
   * bucket policy is derived from this list rather than maintained beside it.
   */
  static readonly REQUIRED_CORS_ALLOWED_HEADERS = ['Content-Type', 'Content-Length', 'If-None-Match'] as const;

  /**
   * A short-lived signed URL to read one object back.
   *
   * Used for downloadable reports, where streaming megabytes through the
   * serving container would be pointless. The scope is explicit so an artifact
   * download cannot be pointed at a source document by editing a key.
   */
  async createDownloadUrl(objectKey: string, expectedOrganizationId: string, scope: ObjectScope): Promise<string> {
    assertKeyBelongsTo(objectKey, expectedOrganizationId, scope);
    const client = this.getClient();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }), {
      expiresIn: SIGNED_URL_TTL_SECONDS,
    });
  }

  /**
   * Read an object back for analysis or execution.
   *
   * `expectedOrganizationId` is checked against the key's own tenant segment
   * before any network call: the key is server-minted, so a mismatch means a
   * caller supplied someone else's identifier and the right answer is to refuse
   * rather than to fetch and hope a later check catches it.
   *
   * `uploadedAt`, when given, is checked against the retention window for the
   * same reason — an over-age source is refused on our clock rather than on the
   * provider's lifecycle schedule.
   */
  async read(
    objectKey: string,
    expectedOrganizationId: string,
    options: { scope?: ObjectScope; uploadedAt?: Date; now?: Date } = {},
  ): Promise<Buffer> {
    const scope = options.scope ?? 'SOURCE';
    assertKeyBelongsTo(objectKey, expectedOrganizationId, scope);
    if (scope === 'SOURCE' && options.uploadedAt && isSourceExpired(options.uploadedAt, options.now)) {
      throw new ServiceUnavailableException(
        `This file was uploaded more than ${SOURCE_RETENTION_DAYS} days ago and is no longer available. Upload it again to continue.`,
      );
    }
    const client = this.getClient();
    const out = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    const body = out.Body as unknown as AsyncIterable<Uint8Array> | undefined;
    if (!body) throw new ServiceUnavailableException('The uploaded file could not be read.');
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async delete(objectKey: string, expectedOrganizationId: string, scope: ObjectScope = 'SOURCE'): Promise<void> {
    assertKeyBelongsTo(objectKey, expectedOrganizationId, scope);
    const client = this.getClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  /**
   * Drop an object whose upload was issued but never registered.
   *
   * A ticket that is signed and then abandoned — the tab closed, the upload
   * failed halfway, the user changed their mind — leaves bytes in the bucket
   * that no row references. Nothing downstream would ever look at them, which
   * is exactly why they must be removed deliberately: an unreferenced copy of a
   * customer's price list is still a copy of a customer's price list.
   *
   * Cleanup never propagates a failure. It runs on paths that are already
   * handling an earlier error, and turning "the import failed" into "the import
   * failed and so did the tidy-up" helps nobody; the lifecycle rule is the
   * backstop.
   */
  async cleanupAbandonedUpload(objectKey: string, expectedOrganizationId: string): Promise<boolean> {
    try {
      await this.delete(objectKey, expectedOrganizationId, 'SOURCE');
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not remove abandoned upload ${redactKey(objectKey)}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return false;
    }
  }

  /** Immutable content identity, recorded on the source row and never recomputed differently. */
  static contentHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }
}

const ALLOWED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xlsm']);
const ALLOWED_ARTIFACT_EXTENSIONS = new Set(['.csv', '.json', '.txt']);

export function safeExtension(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  return ALLOWED_EXTENSIONS.has(ext) ? ext : '';
}

function safeArtifactExtension(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  return ALLOWED_ARTIFACT_EXTENSIONS.has(ext) ? ext : '';
}

/**
 * A key is only usable by the tenant whose segment it carries, in the scope it
 * was minted for.
 *
 * Both halves matter. The tenant segment stops one organization reaching
 * another's object; the scope prefix stops a source document being fetched
 * through a code path that believes it is handling a derived report — which is
 * how a 90-day expiry quietly becomes permanent retention.
 */
export function assertKeyBelongsTo(objectKey: string, organizationId: string, scope: ObjectScope = 'SOURCE'): void {
  const expected = `${SCOPE_PREFIX[scope]}/${organizationId}/`;
  if (!objectKey.startsWith(expected) || objectKey.includes('..')) {
    throw new ServiceUnavailableException('The uploaded file could not be read.');
  }
}

/** Whether an uploaded source has passed the retention window. */
export function isSourceExpired(uploadedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - uploadedAt.getTime();
  return ageMs > SOURCE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/** Keep the tenant segment out of warning logs; the UUID is enough to trace one object. */
function redactKey(objectKey: string): string {
  const parts = objectKey.split('/');
  return parts.length >= 3 ? `${parts[0]}/…/${parts[parts.length - 1]}` : objectKey;
}
