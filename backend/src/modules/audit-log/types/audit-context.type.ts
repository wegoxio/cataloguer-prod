/**
 * Whose data an audited action touched (P0-13, required since P5-A1).
 *
 * `organizationId` is deliberately non-optional: every material audit write
 * must state the AFFECTED RESOURCE's organization, derived from that resource
 * itself — never from the acting user's scope. A null value is legitimate in
 * exactly two situations, and nowhere else:
 *
 *  1. PLATFORM STATEMENT — the resource is genuinely platform-level (global
 *     settings). Written as an explicit `{ organizationId: null }` literal.
 *  2. ORGANIZATION-LESS RESOURCE — the affected resource itself carries no
 *     owner (a platform-class user, an org-less library asset): the resource's
 *     own null binding IS its ownership truth.
 *
 * An organization-less store (or any other broken ownership link on a
 * schema-nullable relation) is a CONTAINED DATA ANOMALY, never valid platform
 * ownership: tenant-domain mutations whose ownership cannot be derived are
 * REFUSED before mutating (supplier operations resolve and validate their
 * store AND its organization first; billing refuses a missing store or
 * organization). Where a read-path fallback still surfaces an anomalous null,
 * the row stays INVISIBLE to every tenant view (the listing filter matches
 * stored context exactly) and signals data repair — it is never treated as
 * platform scope.
 */
export interface AuditContext {
  organizationId: string | null;
  storeId?: string | null;
}

/**
 * Extracts the primary key from a MikroORM entity, an unpopulated reference
 * proxy, or a raw id — the three shapes a relation field can carry at an
 * audit call site. Returns null for absent relations.
 */
export function refId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}
