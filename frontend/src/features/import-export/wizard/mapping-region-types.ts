/**
 * The one shape the mapping region and its callers share.
 *
 * Kept apart from `mapping-region.tsx` so a module that only needs the type
 * does not pull a client component — and, specifically, so the field list can
 * be imported by a server-rendered route without dragging React in behind it.
 */
export interface FieldOption {
  value: string;
  label: string;
  /** Fields the import cannot run without are marked, not hidden. */
  required?: boolean;
  /**
   * One sentence saying what this field IS.
   *
   * Carried on the option rather than written beside each place a target is
   * shown, so the mapping editor, the recommendations and the plan summary can
   * never explain the same field two different ways.
   */
  help?: string;
}
