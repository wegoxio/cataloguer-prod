import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isAllowedProductImageUrl,
  ProductImageUrlContext,
  STORAGE_URL_REJECTION_MESSAGE,
} from './storage-url.policy';

/**
 * The single DI entry point for the #174 storage URL policy. Reads the
 * configured public base once per call from ConfigService (validated at boot)
 * and delegates every rule to the pure functions in storage-url.policy.ts.
 *
 * Every rejection — foreign tenant, wrong host, bad extension, malformed —
 * throws the SAME user-safe 400, so a foreign reference is indistinguishable
 * from an invalid one (no existence oracle). With no STORAGE_PUBLIC_URL
 * configured the policy fails closed: nothing legitimate can exist because
 * upload tickets cannot be minted either.
 */
@Injectable()
export class StorageUrlPolicyService {
  constructor(private readonly configService: ConfigService) {}

  private get publicBaseUrl(): string {
    return (this.configService.get<string>('STORAGE_PUBLIC_URL') || '').replace(/\/+$/, '');
  }

  private static reject(): never {
    throw new BadRequestException(STORAGE_URL_REJECTION_MESSAGE);
  }

  assertProductImageUrl(url: unknown, ctx: ProductImageUrlContext): void {
    if (!isAllowedProductImageUrl(url, this.publicBaseUrl, ctx)) StorageUrlPolicyService.reject();
  }

  /** Non-throwing variant for imports: keeps allowed URLs, counts the rest. */
  filterProductImageUrls(urls: string[], ctx: ProductImageUrlContext): { allowed: string[]; skipped: number } {
    const allowed = urls.filter((url) => isAllowedProductImageUrl(url, this.publicBaseUrl, ctx));
    return { allowed, skipped: urls.length - allowed.length };
  }
}
