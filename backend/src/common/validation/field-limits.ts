/**
 * THE BOUNDS THAT MORE THAN ONE ROUTE HAS TO AGREE ON.
 *
 * A new route that re-declares a field re-declares its limits, and the two
 * copies then drift silently — the newer one accepting a value the older one
 * has always refused. #276 added a nested onboarding body that restates an
 * organization, a store and a user, so the numbers live here and both routes
 * import them.
 *
 * Every value is at or below the column it is written to. All six columns
 * involved are `varchar(255)`: `organizations.name`, `stores.name`,
 * `stores.website_url`, `users.email`, `users.first_name` / `last_name` and
 * `users.company`.
 *
 * TWO KNOWN DIVERGENCES, deliberately left alone, both pre-existing and both in
 * the same direction — a DTO that permits more than its column holds, so an
 * over-long value becomes a database error instead of a 400:
 *
 *   `CreateStoreDto.websiteUrl`                    `@MaxLength(300)`
 *   `CreateOrganizationAdministratorDto.email`     `@MaxLength(320)`
 *
 * Onboarding uses the columns' real bounds rather than inheriting those, so it
 * is NARROWER than the legacy routes on exactly those two fields and identical
 * everywhere else. Tightening the legacy routes is a separate change with its
 * own compatibility question, and #276 is not the place to answer it.
 */

/**
 * `users.email`, and the only bound `@IsEmail()` would not have applied anyway:
 * class-validator caps an address at 254 and its local part at 64, so 254 is
 * where the two agree and where the column still holds. Narrower than
 * `CreateOrganizationAdministratorDto`'s 320 — see above.
 */
export const EMAIL_MAX = 254;

/** `users.first_name` / `last_name` — the same 100 every user-creating route uses. */
export const PERSON_NAME_MAX = 100;

/** `users.company`, and an organization's display name. */
export const COMPANY_NAME_MAX = 200;

/** `stores.name` — the same 100 `CreateStoreDto` uses. */
export const STORE_NAME_MAX = 100;

/** `stores.website_url`. Narrower than `CreateStoreDto`'s 300 — see above. */
export const WEBSITE_URL_MAX = 255;
