/**
 * Who performed an audited action.
 *
 * One definition, used by every service that writes audit entries. It was
 * previously re-declared inline in seven services, so adding a field for the
 * log would have meant finding every copy (review feedback on PR #211).
 *
 * `store` is optional because platform-level actors have none; services that
 * scope by tenant read it, the audit trail itself only needs id and email.
 */
export interface Actor {
  id: string;
  email: string;
  store?: { id: string } | null;
}
