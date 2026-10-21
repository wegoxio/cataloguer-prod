/**
 * The panel's capability model (P5-A2 family 2 companion).
 *
 * AUTHORITY COMES FROM ONE PLACE: the TenantScope the backend resolved for
 * this request, delivered by `GET /auth/me`. Managed-tenant state in the
 * browser only decides which `X-Managed-*` headers are sent; it NEVER grants
 * anything in the UI. There is deliberately no fallback here — while the
 * resolved scope is absent, loading, stale or failed, every capability is
 * false and controls stay hidden.
 *
 * These predicates mirror the server's helpers so the panel stops offering
 * actions the API will refuse. They are not enforcement: the backend remains
 * the only thing standing between an actor and another tenant's data.
 */

export interface SessionScope {
  /** A genuine platform actor. */
  platform: boolean;
  /** The resolved role name. */
  role: string;
  /** The company in context; null only for the platform owner acting globally. */
  organizationId: string | null;
  /** The single branch in context, when the actor is narrowed to one. */
  storeId: string | null;
  /** Branches this actor may act on. */
  allowedStoreIds: string[];
}

const PLATFORM_ROLE = 'SUPER_ADMIN';
const ORGANIZATION_ROLE = 'ORGANIZATION_MANAGER';
const STORE_ADMIN_ROLE = 'ADMIN';

const isNullableId = (value: unknown): boolean =>
  value === null || (typeof value === 'string' && value.length > 0);

/**
 * Validates the `scope` block of a `/auth/me` response.
 *
 * Returns null on ANY mismatch — a partially-understood scope is treated as no
 * scope at all, which grants nothing. The result is kept separate from the
 * session user; scope is never merged into that object.
 */
export function parseSessionScope(raw: unknown): SessionScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.platform !== 'boolean') return null;
  if (typeof candidate.role !== 'string' || candidate.role.length === 0) return null;
  if (!isNullableId(candidate.organizationId)) return null;
  if (!isNullableId(candidate.storeId)) return null;
  if (!Array.isArray(candidate.allowedStoreIds)) return null;
  if (candidate.allowedStoreIds.some((id) => typeof id !== 'string' || id.length === 0)) return null;
  return {
    platform: candidate.platform,
    role: candidate.role,
    organizationId: candidate.organizationId as string | null,
    storeId: candidate.storeId as string | null,
    allowedStoreIds: [...(candidate.allowedStoreIds as string[])],
  };
}

type MaybeScope = SessionScope | null | undefined;

/** Roles that speak for a whole company when they are not narrowed. */
const holdsOrganizationAuthority = (scope: SessionScope): boolean =>
  scope.role === ORGANIZATION_ROLE || (scope.platform === true && scope.role === PLATFORM_ROLE);

const hasOrganization = (scope: SessionScope): boolean =>
  typeof scope.organizationId === 'string' && scope.organizationId.length > 0;

/** The branch the actor selected, or null when it speaks for the company. */
const narrowedTo = (scope: SessionScope): string | null =>
  typeof scope.storeId === 'string' && scope.storeId.length > 0 ? scope.storeId : null;

const allowsStore = (scope: SessionScope, storeId: unknown): boolean =>
  typeof storeId === 'string' && storeId.length > 0 && scope.allowedStoreIds.includes(storeId);

/**
 * The platform owner acting globally — no company, no branch.
 *
 * Absence of a store is NOT the test: a SUPER_ADMIN working inside a managed
 * organization is legitimately store-less and is not the platform owner.
 */
export function isUnscopedPlatformOwner(scope: MaybeScope): boolean {
  if (!scope) return false;
  return (
    scope.platform === true &&
    scope.role === PLATFORM_ROLE &&
    scope.organizationId === null &&
    scope.storeId === null
  );
}

/**
 * The platform owner working INSIDE a client organization ("Manage company").
 *
 * This is deliberately a separate question from `isUnscopedPlatformOwner`:
 * the moment the backend resolves a managed-organization scope the actor stops
 * being unscoped, so unscoped-ness cannot be used to ask "am I currently
 * managing a tenant?" — that test would answer false exactly when the answer
 * should be true. Browser managed-tenant storage supplies the labels for that
 * mode; only this predicate says whether the mode is real.
 */
export function isPlatformManagingOrganization(scope: MaybeScope): boolean {
  if (!scope) return false;
  return (
    scope.platform === true &&
    scope.role === PLATFORM_ROLE &&
    typeof scope.organizationId === 'string' &&
    scope.organizationId.length > 0
  );
}

/**
 * The branch whose settings and modules the panel should reflect.
 *
 * The resolved scope is authoritative. `legacyStoreId` — the store binding on
 * the session user — is consulted only for non-platform sessions that predate
 * scope resolution, and never to widen anything: it names the actor's own
 * branch, which its scope already allows.
 */
export function effectiveStoreId(scope: MaybeScope, legacyStoreId?: string | null): string | undefined {
  if (!scope) return undefined;
  if (typeof scope.storeId === 'string' && scope.storeId.length > 0) return scope.storeId;
  if (scope.platform === true) return undefined;
  return typeof legacyStoreId === 'string' && legacyStoreId.length > 0 ? legacyStoreId : undefined;
}

/**
 * Adding a branch is an organization-level act, so it is impossible from
 * inside one: a narrowed actor must leave branch context first.
 *
 * THE UNSCOPED PLATFORM OWNER IS REFUSED (corrected in P5-W5). It used to be
 * admitted unconditionally, which offered an action the server refuses: a
 * store MUST belong to a company (`StoresService.create` answers 400 "A store
 * must belong to an organization"), and an owner working globally has named
 * none. Onboarding a NEW client is a different act with its own surface — it
 * creates the company first — and it lives on the Clients page.
 */
export function canCreateStore(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (isUnscopedPlatformOwner(scope)) return false;
  return holdsOrganizationAuthority(scope) && hasOrganization(scope) && narrowedTo(scope) === null;
}

/** Renaming, archiving or restoring one branch (§12 gives ADMIN none of this). */
export function canManageStore(scope: MaybeScope, storeId: unknown): boolean {
  if (!scope) return false;
  if (isUnscopedPlatformOwner(scope)) return true;
  if (!holdsOrganizationAuthority(scope) || !hasOrganization(scope)) return false;
  if (!allowsStore(scope, storeId)) return false;
  const narrowed = narrowedTo(scope);
  return narrowed === null || narrowed === storeId;
}

/**
 * May the actor REMOVE a branch (#293)?
 *
 * Stricter than `canManageStore` in two ways, and both mirror the server's
 * `StoreRemovalService.assertMayRemove` exactly:
 *
 *   · an UNSCOPED platform owner is refused. Removal is a tenant operation —
 *     somebody closes one of THEIR company's branches — and an unscoped session
 *     represents no company. The owner enters the company first, or uses
 *     Recovery, which is where their own store lifecycle power lives;
 *   · a NARROWED actor is refused, Superadmin included, because removing the
 *     branch you are working inside would leave you scoped to a store you can
 *     no longer see.
 *
 * Offering a button the server will always refuse is worse than not offering
 * it, so the interface asks the same question the server does.
 */
export function canRemoveStore(scope: MaybeScope, storeId: unknown): boolean {
  if (!scope) return false;
  if (!hasOrganization(scope)) return false;
  if (narrowedTo(scope) !== null) return false;
  if (!allowsStore(scope, storeId)) return false;
  if (scope.role === ORGANIZATION_ROLE) return true;
  return scope.platform === true && scope.role === PLATFORM_ROLE;
}

/**
 * #294 — removing a COMPANY is the platform owner's act, and only when acting
 * globally: the inverse of `canRemoveStore`. A Superadmin who has entered a
 * company (or narrowed to a branch) is acting as that company, and a company
 * does not remove companies; every tenant role is refused. Mirrors the
 * server's `assertGlobalPlatform` on the removal routes line for line.
 */

/**
 * #295 G2 — removing a SUPPLIER is the organization act supplier identity
 * already is: an Organization Manager, or a Superadmin managing the company,
 * speaking for the whole company. Mirrors `SupplierRemovalService.assertMayRemove`
 * line for line; every branch role and every narrowed actor is refused, and so
 * is an unscoped owner, whose own power is restoration in Recovery.
 */

/**
 * #295 G2 — removing a DISCOUNT CODE. A branch ADMIN may still create and edit
 * its own branch's codes (`canManageDiscounts`), but removal is the
 * organization-wide act in every slice, so this is `canRemoveStore`'s rule:
 * an organization administrator, not narrowed, on a branch the scope allows.
 * Mirrors `DiscountRemovalService.assertMayRemove`.
 */

/**
 * Website content and pop-ups. Narrowing binds here too — the branch selector
 * restricts what may be touched, it is not a display filter.
 */

/**
 * May this branch be NAMED as the target of a store-level operation (P5-A2
 * family 3)? Mirrors the server's `resolveScopedStoreTarget`.
 *
 * Every store-level surface in this family — including an API credential — names its branch explicitly
 * instead of letting the server infer one from the actor's own binding. This
 * predicate answers whether a given branch is nameable:
 *
 *   unscoped platform owner ....... no (it must enter a company first)
 *   un-narrowed organization actor  any branch its scope allows
 *   narrowed actor ................ exactly the branch it selected
 *
 * It deliberately asks nothing about the ROLE: which surfaces exist is decided
 * by the capability guarding that surface, this decides only which branch a
 * permitted actor may point at. A missing or empty target is never nameable,
 * so the panel refuses instead of sending a request the server would answer
 * with 400.
 */
export function canActOnAllowedStore(scope: MaybeScope, storeId: unknown): boolean {
  if (!scope) return false;
  if (!hasOrganization(scope)) return false;
  if (typeof storeId !== 'string' || storeId.length === 0) return false;
  const narrowed = narrowedTo(scope);
  if (narrowed !== null) return narrowed === storeId;
  return allowsStore(scope, storeId);
}

/**
 * May the actor administer one branch's API credentials?
 *
 * The surface uses the server matrix `@Roles('SUPER_ADMIN',
 * 'ORGANIZATION_MANAGER', 'ADMIN')` plus `requireOrganizationScope`, so they
 * so the manager that
 * runs the company holds it for every branch it may name; a branch admin holds
 * it for the branch its scope resolved.
 *
 * This answers WHO, never WHICH BRANCH. Every store-targeted action must ALSO
 * pass `canActOnAllowedStore` for the target it is about to name — at the
 * rendered control and again in the handler. A VIEWER or EDITOR never gains
 * these actions merely because a branch id matches.
 *
 * The unscoped platform owner is refused: branch services are tenant data, so
 * it must enter a company first — handling requests is a separate surface.
 */
export function canAdministerBranchServices(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (!hasOrganization(scope)) return false;
  if (holdsOrganizationAuthority(scope)) return true;
  return scope.role === STORE_ADMIN_ROLE && narrowedTo(scope) !== null;
}

/** Roles the assets controller admits at all; VIEWER is not one of them. */

/**
 * May the actor OPEN the asset bank (`GET /assets`)?
 *
 * The route carries the controller's role list — which excludes VIEWER — and
 * then requires an organization outright, answering 403 without one. So the
 * page must not render or fetch for a VIEWER, nor for the unscoped platform
 * owner: neither would receive a list, and issuing the request anyway only
 * produces a console error and an empty page that reads like "your company has
 * no files".
 */

/**
 * May the actor RENAME a library file (`PATCH /assets/:id`)?
 *
 * The route carries the controller's role list and requires an organization,
 * exactly like the listing: a display name is a label inside the company's own
 * library, and changing it never changes the stored file or anything using it.
 * Deliberately the same question as `canViewAssetBank`, named for what it gates.
 */

/**
 * May the actor upload into the asset bank at all (D-7)?
 *
 * This is VISIBILITY only, and it is not sufficient on its own: the bank an
 * upload lands in is a store, so the chosen branch must additionally pass
 * `canActOnAllowedStore`. Offering the control never authorizes an arbitrary
 * target — that conflation is exactly what the server stopped accepting when
 * `req.user?.store?.id || 'platform'` handed the platform bank to every
 * store-less actor.
 *
 * The unscoped platform owner keeps the platform bank (the registration
 * authority is `platform` for it, and only for it); an organization actor
 * needs at least one branch it can name, and a narrowed one already has it.
 */

/**
 * May the actor DELETE a file from the shared bank?
 *
 * Mirrors the server's `isOrganizationAdministrator`, which is the runtime gate
 * on `DELETE /assets/:id` and `POST /assets/:id/detach-and-delete` — NOT their
 * `@Roles` list. The difference matters twice, and reading the role list alone
 * would have got both wrong:
 *
 *   ADMIN appears in `@Roles` and is REFUSED by the predicate — the library is
 *   shared company-wide, so a branch admin deleting a file would remove it from
 *   every sibling branch, with no archive to undo it;
 *   a NARROWED manager or managed owner is refused too — `storeId` must be
 *   exactly null, because a narrowed actor is acting as a branch.
 *
 * Uploading, viewing and using files stay open to branch admins.
 */

/**
 * Catalogue authority (P5-A2 family 4).
 *
 * Three different server matrices govern the catalogue, and they must not be
 * collapsed into one capability — doing so would hand a branch admin the
 * import workflow, or hand it organization-wide bulk mutations:
 *
 *   CATALOGUE_ROLES ......... product and photo writes, and export
 *   ORGANIZATION_WIDE_ROLES . bulk mutations and the import workflow
 *
 * Every route in both groups scopes by ORGANIZATION (`assertProductInOrganization`
 * and friends), and the platform owner acting globally passes those assertions,
 * so the shape below mirrors that: role list, then either global platform or a
 * company in scope. Narrowing is not consulted, because those routes do not
 * consult it — the one exception is store assignment, which has its own
 * predicate below.
 */
const CATALOGUE_ROLES = [PLATFORM_ROLE, ORGANIZATION_ROLE, STORE_ADMIN_ROLE];
const ORGANIZATION_WIDE_ROLES = [PLATFORM_ROLE, ORGANIZATION_ROLE];

const holdsCatalogueRole = (scope: SessionScope, roles: string[]): boolean => {
  if (!roles.includes(scope.role)) return false;
  if (isUnscopedPlatformOwner(scope)) return true;
  return hasOrganization(scope);
};

/**
 * May the actor create and EDIT catalogue items — products, families,
 * categories, and the photos on them (D-4.5)?
 *
 * ADR 014 gives ORGANIZATION_MANAGER this in full inside its own organization;
 * ADMIN keeps it for its company's catalogue; EDITOR and VIEWER read only.
 * This replaces the family-3 `canManageProductPhotos`, which mirrored a backend
 * that did not yet admit the manager: products and their photos now share one
 * server matrix, so they share one capability.
 *
 * ORDINARY EDITING ONLY. Archive, restore and permanent delete were part of
 * this capability and are now `canArchiveCatalogueItem` below — the server
 * split them in P5-A2 canonical family 7, and a panel that still offered them
 * here would show a branch admin three buttons the API answers with 403.
 */
export function canManageCatalogue(scope: MaybeScope): boolean {
  if (!scope) return false;
  return holdsCatalogueRole(scope, CATALOGUE_ROLES);
}

/**
 * May the actor ARCHIVE, RESTORE or PERMANENTLY DELETE a catalogue item
 * (P5-A2 canonical family 7)?
 *
 * Mirrors the server's `isOrganizationAdministrator`, which is the runtime gate
 * on `PATCH /products/:id/archive`, `PATCH /products/:id/restore`,
 * `DELETE /products/:id` and their bulk counterparts — NOT their `@Roles` list.
 * Reading the role list alone would get both of these wrong:
 *
 *   ADMIN appears in `@Roles` and is REFUSED by the predicate — a product is
 *   shared by every store in the company, so a branch admin archiving one
 *   takes it away from its siblings;
 *   a NARROWED manager or managed owner is refused too — `storeId` must be
 *   exactly null, because a narrowed actor is acting as a branch.
 *
 * Deliberately identical in shape to `canDeleteBankFile`: same server
 * predicate, same reasoning about shared organization-owned records.
 */
export function canArchiveCatalogueItem(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (!hasOrganization(scope)) return false;
  if (narrowedTo(scope) !== null) return false;
  if (scope.role === ORGANIZATION_ROLE) return true;
  return scope.platform === true && scope.role === PLATFORM_ROLE;
}

/**
 * May the actor run a BULK mutation over the catalogue (D-4.1)?
 *
 * Deliberately narrower than `canManageCatalogue`. The bulk services receive an
 * organization id and no store filter, so one call reaches every product of the
 * company — including products the caller's own branch does not carry. Under
 * the P5-A0 rule for shared organization-owned data that belongs to the
 * platform owner and the organization manager; ADMIN keeps per-product edits.
 */
export function canBulkMutateCatalogue(scope: MaybeScope): boolean {
  if (!scope) return false;
  return holdsCatalogueRole(scope, ORGANIZATION_WIDE_ROLES);
}

/**
 * May the actor bulk-reassign products to stores (D-4.2)?
 *
 * Narrower again: re-linking products to branches is an organization-wide act,
 * so a NARROWED actor is refused — exactly as `PATCH /products/:id` already
 * refuses `storeIds` from an actor working inside one branch, and as the bulk
 * route now refuses it explicitly.
 */
export function canBulkAssignStores(scope: MaybeScope): boolean {
  if (!canBulkMutateCatalogue(scope)) return false;
  return narrowedTo(scope as SessionScope) === null;
}

/**
 * May the actor run the catalogue IMPORT workflow — preview, commit, history
 * (D-4.3)?
 *
 * One organization-wide administrative act seen at three moments: a commit
 * rewrites catalogue data far beyond any single branch, and exposing only part
 * of the workflow to a branch admin would be misleading. Kept separate from
 * `canExportCatalogue` on purpose, so export access can never imply import.
 */
export function canRunCatalogueImport(scope: MaybeScope): boolean {
  if (!scope) return false;
  return holdsCatalogueRole(scope, ORGANIZATION_WIDE_ROLES);
}

/**
 * May the actor export the catalogue (D-4.3)?
 *
 * Read-only, and returns the caller's own organization catalogue — which ADMIN
 * already reads in the panel — so ADMIN keeps it and the manager gains it.
 */
export function canExportCatalogue(scope: MaybeScope): boolean {
  if (!scope) return false;
  return holdsCatalogueRole(scope, CATALOGUE_ROLES);
}

/**
 * SUPPLIER AUTHORITY (P5-D1).
 *
 * Three capabilities, because the server has three different answers. Suppliers
 * became ORGANIZATION-owned: the old panel had no gating at all and the sidebar
 * used `adminOnly` (SUPER_ADMIN | ADMIN), which would now hide from
 * ORGANIZATION_MANAGER the surface ADR 014 grants it in full.
 */

/**
 * May the actor SEE the supplier surface at all?
 *
 * The visibility question, and the one the sidebar asks. Suppliers are shared
 * by the whole company, so a narrowed actor still sees them; ADMIN selects from
 * them for its own store's orders. The unscoped platform owner has no company
 * and therefore no supplier list.
 */

/**
 * May the actor CREATE, EDIT or MERGE a supplier's identity?
 *
 * Mirrors the server's `isOrganizationAdministrator`, which is the runtime gate
 * in `SuppliersService` — NOT its `@Roles` list. A supplier is shared by every
 * branch, so registering or renaming one changes what the siblings buy from:
 * ADMIN appears in `@Roles` and is refused, and a NARROWED manager is refused
 * because it is acting as a branch.
 */

/**
 * May the actor work on supplier ORDERS — create, import, map lines, set status?
 *
 * Branch-shaped rather than organization-shaped: ADMIN keeps its own store's
 * orders, and a narrowed actor is held to the branch it selected. Deliberately
 * broader than `canManageSupplierIdentity` and narrower than nothing: the
 * unscoped platform owner is refused because orders are tenant data.
 */

/**
 * Commerce authority (P5-A2 family 5): customer orders, invoices and discount
 * codes. Three matrices again, because the server has three.
 *
 * All of them refuse the UNSCOPED platform owner: orders, invoices and codes
 * are tenant data, and the owner's future dashboard shows aggregate commercial
 * metrics — client counts, plan distribution — never a tenant's customers
 * (D-5.1). It must enter a managed company to work on them.
 */
const COMMERCE_ROLES = [PLATFORM_ROLE, ORGANIZATION_ROLE, STORE_ADMIN_ROLE, 'EDITOR'];
const DISCOUNT_ROLES = [PLATFORM_ROLE, ORGANIZATION_ROLE, STORE_ADMIN_ROLE];

const holdsCommerceRole = (scope: SessionScope, roles: string[]): boolean =>
  roles.includes(scope.role) && hasOrganization(scope);

/**
 * May the actor work on customer orders — list, read, create,
 * edit, change status (D-5.2)?
 *
 * EDITOR keeps its existing contract and is simply bound to its resolved
 * branch; VIEWER holds none of it, as before.
 */
export function canManageOrders(scope: MaybeScope): boolean {
  if (!scope) return false;
  return holdsCommerceRole(scope, COMMERCE_ROLES);
}

/** May the actor administer a branch's discount codes (D-5.3)? EDITOR may not. */
export function canManageDiscounts(scope: MaybeScope): boolean {
  if (!scope) return false;
  return holdsCommerceRole(scope, DISCOUNT_ROLES);
}

/**
 * Staffing and reporting authority (P5-A2 families 6 and 7).
 */
const STAFFING_ROLES = [PLATFORM_ROLE, ORGANIZATION_ROLE, STORE_ADMIN_ROLE];

/**
 * May the actor work on the team — list, invite, change roles, deactivate,
 * reactivate, reset passwords (family 6)?
 *
 * ADR 014 gives ORGANIZATION_MANAGER the staffing surface of its own company.
 * The company is required, so an unscoped platform owner is refused: staffing a
 * client is a tenant mutation, and it must enter that company first.
 */
export function canManageTeam(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (!STAFFING_ROLES.includes(scope.role)) return false;
  return hasOrganization(scope);
}

/**
 * May the actor move a person between branches (D-6.2)?
 *
 * Narrower than `canManageTeam`: assignment is organization authority, so a
 * branch ADMIN is refused. A narrowed actor may still assign, but only INTO the
 * branch it selected — the target is checked separately with
 * `canActOnAllowedStore`.
 */
export function canAssignUserStore(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (!ORGANIZATION_WIDE_ROLES.includes(scope.role)) return false;
  return hasOrganization(scope);
}

/**
 * May the actor read reports (family 7)?
 *
 * Reports are store-shaped in SQL, so branch isolation is real: organization
 * authority sees the company, ADMIN its own branch. EDITOR and VIEWER hold
 * none of it — the route previously carried no role list at all, which admits
 * every authenticated role.
 */
export function canViewReports(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (!STAFFING_ROLES.includes(scope.role)) return false;
  return hasOrganization(scope);
}

/**
 * May the actor see the company-wide catalogue metrics (family 7, option A)?
 *
 * These counts are organization-wide BY CONSTRUCTION — a category belongs to
 * the company, an image has no branch at all, and a draft product usually
 * carries no branch link — so they are not filtered per branch. Rather than
 * redefine the numbers, the surface belongs to UN-NARROWED organization
 * authority; a narrowed actor leaves branch context to see it, and ADMIN reads
 * genuine branch figures in Reports instead.
 */
export function canViewOrganizationMetrics(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (!ORGANIZATION_WIDE_ROLES.includes(scope.role)) return false;
  if (!hasOrganization(scope)) return false;
  return narrowedTo(scope) === null;
}

/**
 * A Cataloguer subscription belongs to a client ORGANIZATION. The unscoped
 * platform owner is not a paying tenant: it keeps the minimal placeholder, not
 * an organization card, and the future global dashboard is a separate surface.
 */
export function canViewSubscription(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (isUnscopedPlatformOwner(scope)) return false;
  return holdsOrganizationAuthority(scope) && hasOrganization(scope);
}

/**
 * Audit history, mirroring the published listing contract: the platform owner
 * sees everything, an un-narrowed organization actor sees its company, and a
 * narrowed or store-bound actor sees the one branch its scope allows.
 */
export function canViewAuditLog(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (isUnscopedPlatformOwner(scope)) return true;
  if (!hasOrganization(scope)) return false;
  const narrowed = narrowedTo(scope);
  if (narrowed === null) return holdsOrganizationAuthority(scope);
  const admittedRole =
    scope.role === PLATFORM_ROLE || scope.role === ORGANIZATION_ROLE || scope.role === STORE_ADMIN_ROLE;
  return admittedRole && allowsStore(scope, narrowed);
}

/**
 * May the actor READ operational inventory — the quantity breakdown, the
 * movements behind it, and the reconciliation warnings (Phase 8, D1)?
 *
 * Every role that administers a branch or a company may read its own numbers.
 * EDITOR and VIEWER hold no inventory surface at all, matching the routes:
 * the panel asks the same question the server will.
 */
export function canViewInventory(scope: MaybeScope): boolean {
  if (!scope) return false;
  if (!hasOrganization(scope)) return false;
  return [PLATFORM_ROLE, ORGANIZATION_ROLE, STORE_ADMIN_ROLE].includes(scope.role);
}

/**
 * May the actor RECOUNT — state what is physically on a shelf?
 *
 * The one command a branch administrator holds (ADR 013 §20), because a
 * recount names a target rather than applying a delta: repeating it converges,
 * so it cannot silently accumulate. The server still pins WHICH shelf.
 */
export function canRecountInventory(scope: MaybeScope): boolean {
  return canViewInventory(scope);
}

/**
 * May the actor issue the ORGANIZATION-wide inventory commands — adjust
 * condition and sellability, reassign misfiled stock, distribute a family's
 * stock, and run transfers between locations (ADR 014)?
 *
 * A branch administrator may not: these cross branches, and a role bound to
 * one branch has no standing over another's stock. Hiding the controls is
 * courtesy; the server refuses them regardless.
 */
export function canCommandInventory(scope: MaybeScope): boolean {
  if (!scope) return false;
  return holdsCatalogueRole(scope, ORGANIZATION_WIDE_ROLES);
}

/**
 * May the actor ARCHIVE or RESTORE a library file (`PATCH /assets/:id/archive`
 * and `…/restore`)?
 *
 * Mirrors the server's `isOrganizationAdministrator` on those routes, the same
 * predicate that governs deleting a library entry and archiving a category: an
 * archived file leaves the pickers of EVERY branch at once, so a branch-bound
 * actor may not decide it. Distinct from `canDeleteBankFile` in name because
 * archiving is reversible and deletion of the entry is not — the UI must keep
 * the two actions apart even though today they ask the same question.
 */

/**
 * May the actor ORGANISE the library (ADR 030 §3): see the collections,
 * create one, and add or remove a file's memberships?
 *
 * The same answer as opening the library: `GET/POST /assets/collections` and
 * `POST /assets/collections/memberships` carry the library's role list, and a
 * company must be in context. Placing a file is reversible and is what an
 * upload by branch staff needs, so a branch admin and an editor may.
 */

/**
 * May the actor CHANGE THE SHARED STRUCTURE (ADR 030 §3): rename, move or
 * delete a collection?
 *
 * `PATCH` and `DELETE /assets/collections/:id` additionally require
 * `isOrganizationAdministrator` — the predicate archive and removal use — so
 * the answer is exactly the one for deleting a bank file: an organization
 * manager, or the platform owner managing a company; a branch-bound admin and
 * a manager narrowed to a branch are refused.
 */
