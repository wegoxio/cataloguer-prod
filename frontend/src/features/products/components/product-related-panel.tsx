'use client';

import React from 'react';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import { canManageCatalogue, type SessionScope } from '../../../lib/permissions';
import { apiFetch } from '../../../lib/api-client';
import {
  RELATION_TYPES,
  catalogueDetailService,
  type RelatedProduct,
  type RelationType,
} from '../services/catalogue-detail.service';

export interface RelationCandidate {
  id: string;
  name: string;
  sku?: string | null;
}

/**
 * Which products may be offered as a target (P5-W4, capability 2).
 *
 * A product cannot suggest itself — the server refuses it with an explicit
 * code — and offering a target already linked would produce a duplicate the
 * unique index refuses. Filtering both here keeps the picker honest rather
 * than making the operator discover the rule from an error.
 */
export function relationCandidates(
  results: RelationCandidate[],
  productId: string,
  existing: RelatedProduct[],
): RelationCandidate[] {
  const taken = new Set(existing.map((relation) => relation.targetProductId));
  return results.filter((candidate) => candidate.id !== productId && !taken.has(candidate.id));
}

export interface ProductRelatedPanelProps {
  productId: string;
  accessToken: string | null;
  scope: SessionScope | null | undefined;
  relations: RelatedProduct[];
  onChanged?: () => void;
}

/**
 * Related products: accessories, similar items, replacements
 * (P5-W4, capability 2).
 *
 * DIRECTED, NOT SYMMETRIC (Phase 3). "This chair suggests that cushion" and
 * "this cushion suggests that chair" are two different merchandising
 * statements, so the mirror edge is an explicit opt-in and never inferred.
 *
 * The picker searches the caller's OWN catalogue through the ordinary
 * organization-scoped product listing, so a foreign product can never be
 * offered; the server refuses a foreign target as a 404 regardless, which is
 * what keeps this endpoint from becoming a probe for another company's
 * catalogue.
 */
export default function ProductRelatedPanel({
  productId,
  accessToken,
  scope,
  relations,
  onChanged,
}: ProductRelatedPanelProps) {
  const t = useT();
  const toast = useToast();
  const canManage = canManageCatalogue(scope);
  const [busy, setBusy] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [results, setResults] = React.useState<RelationCandidate[]>([]);
  const [type, setType] = React.useState<RelationType>('RELATED');
  const [reciprocal, setReciprocal] = React.useState(false);

  React.useEffect(() => {
    if (!accessToken || !canManage || search.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch(`/products?search=${encodeURIComponent(search.trim())}&limit=10`, { method: 'GET', token: accessToken })
        .then((response) => setResults(response?.items ?? response?.data?.items ?? []))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [accessToken, canManage, search]);

  const candidates = React.useMemo(
    () => relationCandidates(results, productId, relations),
    [results, productId, relations],
  );

  const ordered = React.useMemo(
    () => [...relations].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
    [relations],
  );

  const guard = (): boolean => {
    if (!canManage || !accessToken) {
      toast.error(t('You do not have permission to do this.'));
      return false;
    }
    return true;
  };

  const add = async (candidate: RelationCandidate) => {
    if (!guard()) return;
    setBusy(true);
    try {
      await catalogueDetailService.createRelation(accessToken as string, productId, {
        targetProductId: candidate.id,
        type,
        sortOrder: ordered.length,
        reciprocal,
      });
      toast.success(t('Suggestion added'));
      setSearch('');
      setResults([]);
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not add the suggestion'));
    } finally {
      setBusy(false);
    }
  };

  const move = async (relation: RelatedProduct, direction: -1 | 1) => {
    if (!guard()) return;
    const index = ordered.findIndex((row) => row.id === relation.id);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    setBusy(true);
    try {
      await catalogueDetailService.updateRelation(accessToken as string, productId, ordered[index].id, {
        sortOrder: target,
      });
      await catalogueDetailService.updateRelation(accessToken as string, productId, ordered[target].id, {
        sortOrder: index,
      });
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not reorder the suggestions'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (relation: RelatedProduct) => {
    if (!guard()) return;
    setBusy(true);
    try {
      await catalogueDetailService.removeRelation(accessToken as string, productId, relation.id);
      toast.success(t('Suggestion removed'));
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not remove the suggestion'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-6" data-testid="related-panel">
      <h3 className="text-sm font-bold text-slate-800 mb-1">{t('Related products')}</h3>
      <p className="text-xs text-slate-500 mb-4">
        {t(
          'What the website offers alongside this item. Each suggestion points one way; tick "also the other way round" to state the mirror as well. Only targets a visitor may actually see are ever shown.',
        )}
      </p>

      {ordered.length === 0 ? (
        <p className="text-xs text-slate-400">{t('No suggestions yet.')}</p>
      ) : (
        <ul className="divide-y divide-slate-100 border border-slate-100 rounded-md mb-4">
          {ordered.map((relation, index) => (
            <li key={relation.id} className="px-3 py-2 flex items-center gap-3 flex-wrap" data-testid={`relation-${relation.id}`}>
              <span className="text-xs font-medium text-slate-700 flex-1 min-w-0 truncate">
                {relation.targetName || relation.targetProductId}
              </span>
              <Badge variant="neutral">{relation.type}</Badge>
              {canManage && (
                <span className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0 || busy}
                    data-testid={`relation-up-${relation.id}`}
                    onClick={() => move(relation, -1)}
                  >
                    {t('Up')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === ordered.length - 1 || busy}
                    data-testid={`relation-down-${relation.id}`}
                    onClick={() => move(relation, 1)}
                  >
                    {t('Down')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    data-testid={`relation-remove-${relation.id}`}
                    onClick={() => remove(relation)}
                  >
                    {t('Remove')}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="space-y-2" data-testid="relation-picker">
          <div className="flex items-end gap-2 flex-wrap">
            <Select
              label={t('Kind of suggestion')}
              aria-label={t('Kind of suggestion')}
              value={type}
              onChange={(e) => setType(e.target.value as RelationType)}
              className="max-w-[200px]"
            >
              {RELATION_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 pb-2">
              <input type="checkbox" checked={reciprocal} onChange={(e) => setReciprocal(e.target.checked)} />
              {t('Also the other way round')}
            </label>
          </div>
          <Input
            placeholder={t('Search items by name, SKU or manufacturer code...')}
            aria-label={t('Search items by name, SKU or manufacturer code...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {candidates.length > 0 && (
            <ul className="border border-slate-100 rounded-md divide-y divide-slate-100 max-h-48 overflow-y-auto">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50"
                    data-testid={`relation-candidate-${candidate.id}`}
                    disabled={busy}
                    onClick={() => add(candidate)}
                  >
                    {candidate.name}
                    {candidate.sku && <span className="text-xs text-slate-400 ml-2">{candidate.sku}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
