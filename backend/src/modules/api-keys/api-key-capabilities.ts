import { SetMetadata } from '@nestjs/common';

/**
 * Phase 6 — what an API key is ALLOWED to do, not merely who it is.
 *
 * One ApiKeyGuard protects the whole `/public` controller, so before this
 * existed every catalogue key could also place orders and validate discounts
 * for its store. A key handed to a website for reading was a key that could
 * buy. Capabilities split that authority into exactly the three surfaces the
 * controller actually serves — nothing speculative:
 *
 *   CATALOGUE_READ    the documented catalogue GET endpoints plus store identity
 *   ORDER_CREATE      POST /public/orders
 *   DISCOUNT_VALIDATE POST /public/validate-discount
 *
 * The set is CLOSED: the database refuses unknown literals with a CHECK
 * constraint, and the service normalizes and deduplicates before writing.
 * No capability implies another — a key that orders but cannot read would be
 * strange, but the guard will not invent the read for it.
 */
export const API_KEY_CAPABILITIES = ['CATALOGUE_READ', 'ORDER_CREATE', 'DISCOUNT_VALIDATE'] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

/**
 * Existing rows predate the concept and were issued when a key meant full
 * authority; the migration stamps them with all three so NOTHING a customer
 * integration does today changes. New issuance defaults to the read-only set.
 */
export const LEGACY_FULL_CAPABILITIES: ApiKeyCapability[] = [...API_KEY_CAPABILITIES];
export const DEFAULT_NEW_KEY_CAPABILITIES: ApiKeyCapability[] = ['CATALOGUE_READ'];

export const isApiKeyCapability = (value: string): value is ApiKeyCapability =>
  (API_KEY_CAPABILITIES as readonly string[]).includes(value);

/**
 * Normalizes caller input: rejects unknown literals loudly (the caller made a
 * typo or is probing), deduplicates, and returns a stable canonical order so
 * two equal grants always serialize identically.
 */
export function normalizeCapabilities(requested: string[]): ApiKeyCapability[] {
  const unknown = requested.filter((value) => !isApiKeyCapability(value));
  if (unknown.length) {
    throw new Error(`Unknown API key capability: ${unknown.sort().join(', ')}`);
  }
  return API_KEY_CAPABILITIES.filter((capability) => requested.includes(capability));
}

/**
 * Route metadata the guard enforces. Every route on the public controller MUST
 * declare exactly one required capability; the guard fails closed on a route
 * that carries none, and a structural test enumerates the controller to prove
 * no route ships unclassified.
 */
export const API_KEY_CAPABILITY_METADATA = 'api-key:required-capability';

export const RequireApiCapability = (capability: ApiKeyCapability) =>
  SetMetadata(API_KEY_CAPABILITY_METADATA, capability);
