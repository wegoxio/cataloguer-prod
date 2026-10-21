import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { resolveUploadContentType, UNSUPPORTED_UPLOAD_TYPE_MESSAGE } from './policy/storage-url.policy';

// Hard server-side cap. Enforced by signing the exact Content-Length into
// the presigned PUT: uploading a different size breaks the signature.
// (R2 does not support presigned POST policies — see ADR 006.)
export const MAX_IMAGE_BYTES = 600 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 300;

export interface UploadTicket {
  path: string;
  /** Where the browser PUTs the file body */
  url: string;
  /** Headers the browser must send exactly (they are part of the signature) */
  headers: Record<string, string>;
  publicUrl: string;
  maxBytes: number;
}

/**
 * S3-compatible object storage (ADR 006): works with Cloudflare R2 (set
 * STORAGE_ENDPOINT) and AWS S3 (leave it empty). The bucket must exist and
 * be publicly readable at STORAGE_PUBLIC_URL.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  constructor(private readonly configService: ConfigService) {}

  private get bucket(): string {
    return this.configService.get<string>('STORAGE_BUCKET') || '';
  }

  private get publicBaseUrl(): string {
    return (this.configService.get<string>('STORAGE_PUBLIC_URL') || '').replace(/\/+$/, '');
  }

  get isConfigured(): boolean {
    return Boolean(
      this.bucket &&
      this.publicBaseUrl &&
      this.configService.get<string>('STORAGE_ACCESS_KEY_ID') &&
      this.configService.get<string>('STORAGE_SECRET_ACCESS_KEY'),
    );
  }

  private getClient(): S3Client {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Storage is not configured (STORAGE_BUCKET / STORAGE_PUBLIC_URL / STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY missing)',
      );
    }
    if (!this.client) {
      const endpoint = this.configService.get<string>('STORAGE_ENDPOINT'); // set for R2, omit for AWS S3
      this.client = new S3Client({
        region: this.configService.get<string>('STORAGE_REGION') || 'auto',
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        credentials: {
          accessKeyId: this.configService.get<string>('STORAGE_ACCESS_KEY_ID')!,
          secretAccessKey: this.configService.get<string>('STORAGE_SECRET_ACCESS_KEY')!,
        },
      });
    }
    return this.client;
  }

  /**
   * Mints a short-lived presigned PUT for exactly `sizeBytes` bytes of an
   * image. Content-Length and Content-Type are signed: the browser cannot
   * upload a bigger file or a non-image without invalidating the URL.
   */
  /**
   * Ticket for a store asset (brand images, videos, PDFs). Extensions come
   * from a strict whitelist with canonical Content-Types (#174): an unknown
   * extension is a 400, never application/octet-stream.
   */
  async createAssetTicket(storeId: string, extension: string | undefined, sizeBytes: number): Promise<UploadTicket> {
    const resolved = resolveUploadContentType(extension, ['image', 'video', 'file']);
    if (!resolved) {
      throw new BadRequestException(UNSUPPORTED_UPLOAD_TYPE_MESSAGE);
    }
    const max =
      resolved.kind === 'video' ? MAX_VIDEO_BYTES : resolved.kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > max) {
      throw new BadRequestException(`File size must be between 1 and ${max} bytes (got ${sizeBytes})`);
    }
    return this.signPut(`assets/${storeId}/${randomUUID()}.${resolved.extension}`, resolved.contentType, sizeBytes);
  }

  async createUploadTicket(productId: string, extension: string | undefined, sizeBytes: number): Promise<UploadTicket> {
    // Product photos are images only; the browser optimizes to WebP, hence the default.
    const resolved = resolveUploadContentType(extension, ['image'], 'webp');
    if (!resolved) {
      throw new BadRequestException(UNSUPPORTED_UPLOAD_TYPE_MESSAGE);
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_IMAGE_BYTES) {
      throw new BadRequestException(`Image size must be between 1 and ${MAX_IMAGE_BYTES} bytes (got ${sizeBytes})`);
    }

    const path = `products/${productId}/${randomUUID()}.${resolved.extension}`;
    return this.signPut(path, resolved.contentType, sizeBytes);
  }

  private async signPut(path: string, contentType: string, sizeBytes: number): Promise<UploadTicket> {
    const client = this.getClient();
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        ContentType: contentType,
        ContentLength: sizeBytes,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        // Keep these as signed *headers* so the upload must match them
        unhoistableHeaders: new Set(['content-type', 'content-length']),
      });

      return {
        path,
        url,
        headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) },
        publicUrl: `${this.publicBaseUrl}/${path}`,
        maxBytes: MAX_IMAGE_BYTES,
      };
    } catch (err: any) {
      this.logger.error(`Failed to presign upload: ${err?.message}`);
      throw new ServiceUnavailableException('Could not create an upload URL');
    }
  }
}
