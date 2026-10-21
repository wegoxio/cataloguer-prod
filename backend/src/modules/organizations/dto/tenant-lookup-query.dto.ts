import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * A BOUNDED, SEARCHABLE TENANT LOOKUP — the shape a selector may ask for.
 *
 * `GET /organizations` and `GET /organizations/:id/stores` both answer with
 * EVERY row: no page, no limit, no search. That is tolerable for the screens
 * that manage a handful of companies one at a time, and it is not tolerable for
 * a platform-wide selector, whose cost grows with the whole customer base.
 *
 * Neither list is bounded by anything the product enforces:
 *
 *   - Organizations have no ceiling at all. Nothing in the model, the plans or
 *     the billing policy caps how many client companies exist.
 *   - Stores are capped PER PLAN by `PLANS[].maxWebsites` — but `CORPORATIVO`
 *     sets it to `null`, and `OrganizationPlanPolicy.assertWebsiteSlot` returns
 *     immediately when it is null. One corporate client may hold unlimited
 *     branches, so "the plan bounds it" is false for exactly the clients most
 *     likely to have many.
 *
 * So the ceiling is stated HERE, by the endpoint, and the caller cannot raise
 * it past `TENANT_LOOKUP_MAX_LIMIT`. `total` travels with the answer so a
 * selector can say "20 of 137" instead of silently pretending 20 is all there
 * is — a truncated list that looks complete is how an operator concludes a
 * company does not exist.
 */
export const TENANT_LOOKUP_MAX_LIMIT = 50;
export const TENANT_LOOKUP_DEFAULT_LIMIT = 20;

export class TenantLookupQueryDto {
  /**
   * Matched against the name, case-insensitively. Bounded at the same 200
   * characters every other free-text filter uses; a search term is not a place
   * to send a payload.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TENANT_LOOKUP_MAX_LIMIT)
  limit?: number;
}

/** What a lookup answers with: the bounded slice, and how big the whole is. */
export interface TenantLookupPage {
  items: { id: string; name: string }[];
  total: number;
  limit: number;
  /** `total` exceeds what was returned — the caller must narrow, not scroll. */
  truncated: boolean;
}
