'use client';

import React from 'react';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import { canManageCatalogue, type SessionScope } from '../../../lib/permissions';
import {
  catalogueDetailService,
  type EffectiveFieldValue,
  type FieldDefinition,
  type FieldValue,
} from '../services/catalogue-detail.service';

export interface SpecificationRow {
  definition: FieldDefinition;
  /** The answer in force, and where it came from. Absent = unanswered. */
  effective: EffectiveFieldValue | null;
}

/**
 * Groups the rows the way the form shows them (P5-W4, capability 1).
 *
 * Group order is the order the first field of each group declares, which is
 * the company's own `sortOrder` — not alphabetical, because a specification
 * sheet reads in the order somebody chose. Ungrouped fields come last under an
 * explicit heading rather than being silently dropped or filed under "".
 */
export function groupSpecifications(rows: SpecificationRow[]): { group: string | null; rows: SpecificationRow[] }[] {
  const buckets = new Map<string, { group: string | null; rows: SpecificationRow[] }>();
  for (const row of rows) {
    const key = row.definition.group ?? ' ungrouped';
    const bucket = buckets.get(key) ?? { group: row.definition.group ?? null, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  const ordered = Array.from(buckets.values());
  // Ungrouped last; everything else keeps insertion order.
  return [...ordered.filter((b) => b.group !== null), ...ordered.filter((b) => b.group === null)];
}

/**
 * Which fields apply to THIS product, given its family role (P5-W4).
 *
 * A PARENT-only field is not a question a child can answer, and a CHILD-only
 * field is meaningless on a standalone item or a family card. Showing them
 * anyway would offer an edit the server refuses — the panel's job is to stop
 * asking questions the API will not accept, never to become the rule itself.
 */
export function applicableTo(definition: FieldDefinition, role: 'PARENT' | 'CHILD' | 'STANDALONE'): boolean {
  if (definition.applicability === 'BOTH') return true;
  if (definition.applicability === 'PARENT') return role === 'PARENT' || role === 'STANDALONE';
  return role === 'CHILD';
}

/** How a stored value reads in the form. */
export function displayValue(row: SpecificationRow, t: (s: string) => string): string {
  const value = row.effective?.value ?? null;
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? t('Yes') : t('No');
  return row.definition.unit ? `${value} ${row.definition.unit}` : String(value);
}

export interface ProductSpecificationsPanelProps {
  productId: string;
  /** PARENT = has children, CHILD = has a parent, STANDALONE = neither. */
  role: 'PARENT' | 'CHILD' | 'STANDALONE';
  accessToken: string | null;
  /** The RESOLVED scope. Authority is derived from it and from nothing else. */
  scope: SessionScope | null | undefined;
  definitions: FieldDefinition[];
  effective: EffectiveFieldValue[];
  onChanged?: () => void;
}

/**
 * Specification groups, with effective inherited and overridden values
 * (P5-W4, capability 1).
 *
 * THE POINT OF THIS PANEL is that a value shown on a child may not be the
 * child's own. Phase 2 resolves inheritance per read, so a form that merely
 * printed the number would let somebody "edit" a value belonging to the family
 * parent and be surprised when the parent changed underneath it. Every row
 * therefore says where its answer came from: an inherited row offers
 * "Override" rather than "Edit", and a row the product answered itself offers
 * "Clear", which restores the parent's answer instead of blanking the field.
 *
 * AUTHORITY comes from the resolved TenantScope through `canManageCatalogue`,
 * and the handlers re-check it. Hiding a control is not enforcement: a control
 * can be reached by other means, so the handler refuses too, and the server
 * refuses regardless of both.
 */
export default function ProductSpecificationsPanel({
  productId,
  role,
  accessToken,
  scope,
  definitions,
  effective,
  onChanged,
}: ProductSpecificationsPanelProps) {
  const t = useT();
  const toast = useToast();
  const canManage = canManageCatalogue(scope);
  const [editing, setEditing] = React.useState<{ definitionId: string; value: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const effectiveById = React.useMemo(
    () => new Map(effective.map((entry) => [entry.definitionId, entry] as const)),
    [effective],
  );

  const rows: SpecificationRow[] = React.useMemo(
    () =>
      definitions
        .filter((definition) => !definition.archivedAt)
        .filter((definition) => applicableTo(definition, role))
        .map((definition) => ({ definition, effective: effectiveById.get(definition.id) ?? null })),
    [definitions, effectiveById, role],
  );

  const groups = React.useMemo(() => groupSpecifications(rows), [rows]);

  const save = async (definition: FieldDefinition, raw: string) => {
    // The handler asks the same question the control did. A hidden control is
    // not a closed door.
    if (!canManage || !accessToken) {
      toast.error(t('You do not have permission to do this.'));
      return;
    }
    setBusy(true);
    try {
      const value: FieldValue = definition.type === 'BOOLEAN' ? raw === 'true' : raw.trim() === '' ? null : raw.trim();
      if (value === null) {
        await catalogueDetailService.clearFieldValue(accessToken, productId, definition.id);
      } else {
        await catalogueDetailService.setFieldValue(accessToken, productId, definition.id, value);
      }
      setEditing(null);
      toast.success(t('Specification saved'));
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not save the specification'));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (definition: FieldDefinition) => {
    if (!canManage || !accessToken) {
      toast.error(t('You do not have permission to do this.'));
      return;
    }
    setBusy(true);
    try {
      await catalogueDetailService.clearFieldValue(accessToken, productId, definition.id);
      toast.success(t('This product answer was removed'));
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not remove the answer'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-6" data-testid="specifications-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h3 className="text-sm font-bold text-slate-800">{t('Specifications')}</h3>
        {role === 'CHILD' && <Badge variant="info">{t('Child product')}</Badge>}
      </div>
      <p className="text-xs text-slate-500 mb-4">
        {role === 'CHILD'
          ? t(
              'A value marked "From the parent product" is answered once on the parent and used by every child. Overriding it here answers for this child only.',
            )
          : t(
              'Grouped as this company defined them. An empty value means nobody has answered yet — absence is a fact, never a guess.',
            )}
      </p>

      {groups.length === 0 && (
        <p className="text-xs text-slate-400">{t('This company has not defined any specification fields yet.')}</p>
      )}

      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.group ?? 'ungrouped'} data-testid={`spec-group-${group.group ?? 'ungrouped'}`}>
            <p className="text-[10px] font-semibold text-slate-500 uppercase mb-2">
              {group.group ?? t('Other specifications')}
            </p>
            <ul className="divide-y divide-slate-100 border border-slate-100 rounded-md">
              {group.rows.map((row) => {
                const inherited = row.effective?.source === 'INHERITED';
                const answeredHere = row.effective?.source === 'DIRECT';
                const isEditing = editing?.definitionId === row.definition.id;
                const overrideBlocked = inherited && !row.definition.childOverrideAllowed;
                return (
                  <li
                    key={row.definition.id}
                    className="px-3 py-2 flex items-center gap-3 flex-wrap"
                    data-testid={`spec-row-${row.definition.key}`}
                  >
                    <span className="text-xs font-medium text-slate-700 w-48 shrink-0">{row.definition.label}</span>
                    {isEditing ? (
                      <span className="flex items-center gap-2 flex-1">
                        {row.definition.type === 'SELECT' && row.definition.options ? (
                          <Select
                            aria-label={row.definition.label}
                            value={editing.value}
                            onChange={(e) => setEditing({ definitionId: row.definition.id, value: e.target.value })}
                          >
                            <option value="">{t('Not answered')}</option>
                            {row.definition.options.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </Select>
                        ) : row.definition.type === 'BOOLEAN' ? (
                          <Select
                            aria-label={row.definition.label}
                            value={editing.value}
                            onChange={(e) => setEditing({ definitionId: row.definition.id, value: e.target.value })}
                          >
                            <option value="">{t('Not answered')}</option>
                            <option value="true">{t('Yes')}</option>
                            <option value="false">{t('No')}</option>
                          </Select>
                        ) : (
                          <Input
                            aria-label={row.definition.label}
                            value={editing.value}
                            onChange={(e) => setEditing({ definitionId: row.definition.id, value: e.target.value })}
                          />
                        )}
                        <Button size="sm" isLoading={busy} onClick={() => save(row.definition, editing.value)}>
                          {t('Save')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          {t('Cancel')}
                        </Button>
                      </span>
                    ) : (
                      <>
                        <span className="text-xs text-slate-800 flex-1">{displayValue(row, t)}</span>
                        {inherited && (
                          <span data-testid={`spec-inherited-${row.definition.key}`}>
                            <Badge variant="neutral">{t('From the parent product')}</Badge>
                          </span>
                        )}
                        {answeredHere && role === 'CHILD' && (
                          <span data-testid={`spec-overridden-${row.definition.key}`}>
                            <Badge variant="info">{t('Answered for this child')}</Badge>
                          </span>
                        )}
                        {canManage && (
                          <span className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="secondary"
                              data-testid={`spec-edit-${row.definition.key}`}
                              disabled={overrideBlocked}
                              tooltip={
                                overrideBlocked
                                  ? t('This field is answered on the parent product and children may not override it.')
                                  : undefined
                              }
                              onClick={() =>
                                setEditing({
                                  definitionId: row.definition.id,
                                  value:
                                    row.effective?.value === null || row.effective?.value === undefined
                                      ? ''
                                      : String(row.effective.value),
                                })
                              }
                            >
                              {inherited ? t('Override') : t('Edit')}
                            </Button>
                            {answeredHere && (
                              <Button
                                size="sm"
                                variant="ghost"
                                data-testid={`spec-clear-${row.definition.key}`}
                                tooltip={t(
                                  'Remove the answer set here; the answer from the parent applies again if there is one.',
                                )}
                                onClick={() => clear(row.definition)}
                              >
                                {t('Clear')}
                              </Button>
                            )}
                          </span>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
