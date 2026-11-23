'use client';

import React from 'react';
import Input from '../../../components/ui/input';
import Textarea from '../../../components/ui/textarea';
import Button from '../../../components/ui/button';
import { useT } from '../../../lib/i18n';
import { proposeLabel } from './group-as-family-modal';
import type { Product } from '../types/product.types';

/**
 * Creating a parent card from Add Item.
 *
 * The card is NEVER saved on its own. There is no request in this journey that
 * makes a childless parent, because a childless parent is not a card at all —
 * `isSellableShape`, the public projection and checkout every one of them treat
 * a product with no children as an ordinary sellable item, so a half-made card
 * is a live, buyable ghost. Name, children and labels are collected together
 * and sent as ONE `POST /products/families`.
 *
 * What the form does NOT ask for is as deliberate as what it does. A card has
 * no price of its own to charge, no stock, no SKU and no shops: its sorting
 * price and its status come from the children it is made of, its categories are
 * copied from them, and its shops are derived from theirs. Saying so is the
 * point — the fields are explained, not silently missing.
 */

export interface CreateParentCardFormProps {
  /** Standalone candidates, already filtered by the server. */
  candidates: Product[];
  onSearch: (term: string) => void;
  searching: boolean;
  onCancel: () => void;
  /** One atomic creation. Resolves with the new card's id. */
  onCreate: (input: {
    name: string;
    description?: string;
    metaTitle?: string;
    metaDescription?: string;
    members: { id: string; label: string }[];
  }) => Promise<string>;
}

export default function CreateParentCardForm({
  candidates,
  onSearch,
  searching,
  onCancel,
  onCreate,
}: CreateParentCardFormProps) {
  const t = useT();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [chosen, setChosen] = React.useState<Product[]>([]);
  const [labels, setLabels] = React.useState<Record<string, string>>({});
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [problem, setProblem] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Labels follow the card's name until somebody edits one.
  React.useEffect(() => {
    setLabels((current) => {
      const next = { ...current };
      for (const item of chosen) if (!touched[item.id]) next[item.id] = proposeLabel(item.name, name);
      return next;
    });
  }, [name, chosen, touched]);

  const toggle = (item: Product) =>
    setChosen((current) =>
      current.some((c) => c.id === item.id) ? current.filter((c) => c.id !== item.id) : [...current, item],
    );

  const members = chosen.map((item) => ({ id: item.id, label: (labels[item.id] ?? '').trim() }));
  const statuses = new Set(chosen.map((c) => c.status));
  const duplicateLabel = (() => {
    const seen = new Set<string>();
    return members.some((m) => {
      const key = m.label.toLowerCase();
      if (!m.label) return false;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
  })();

  const blocked = !name.trim()
    ? t('The card needs a name.')
    : chosen.length < 2
      ? t('Choose at least two items to be its children.')
      : statuses.size > 1
        ? t('These items are not all published or all draft. Align their status first.')
        : members.some((m) => !m.label)
          ? t('Every child needs a label.')
          : duplicateLabel
            ? t('Two children cannot show the same label.')
            : null;

  const lowest = [...chosen].sort((a, b) => Number(a.price ?? 0) - Number(b.price ?? 0))[0];

  const submit = async () => {
    if (blocked || submitting) return;
    setSubmitting(true);
    setProblem(null);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        metaTitle: undefined,
        metaDescription: undefined,
        members,
      });
    } catch (err: any) {
      setProblem(err?.message || t('This card could not be created.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="create-card-form">
      <Input
        label="Name for the card"
        data-testid="card-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Textarea
        label="Description"
        rows={3}
        data-testid="card-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="space-y-2 p-3 bg-slate-50 rounded-md border border-slate-100">
        <p className="text-[10px] font-semibold text-slate-500 uppercase">{t('Its child products')}</p>
        <p className="text-[11px] text-slate-500">
          {t('Only standalone items can become children. Each one keeps its own price, stock and shops.')}
        </p>
        <Input
          label="Search items"
          data-testid="card-child-search"
          onChange={(e) => onSearch(e.target.value)}
          placeholder="e.g. Camiseta"
        />
        {searching && <p className="text-[11px] text-slate-400">{t('Searching…')}</p>}
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-1">
          {candidates.map((item) => {
            const image = item.images
              ?.filter((candidate) => !candidate.archivedAt)
              .sort(
                (left, right) =>
                  Number(right.isPrimary) - Number(left.isPrimary) ||
                  (left.sortOrder ?? 0) - (right.sortOrder ?? 0),
              )[0];
            const selected = chosen.some((candidate) => candidate.id === item.id);
            return (
              <label
                key={item.id}
                className={`flex cursor-pointer select-none items-center gap-3 rounded-md border px-2 py-2 transition-colors ${
                  selected ? 'border-primary/30 bg-primary/5' : 'border-transparent hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  data-testid={`card-candidate-${item.id}`}
                  checked={selected}
                  onChange={() => toggle(item)}
                  className="rounded text-primary focus:ring-primary"
                />
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image.url} alt="" className="h-full w-full object-contain" />
                  ) : (
                    <span className="px-1 text-center text-[9px] font-medium text-slate-400">
                      {t('No Image')}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-800">{item.name}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                    {item.sku && <span>SKU: {item.sku}</span>}
                    <span>
                      {Number(item.price ?? 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
          {!searching && candidates.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-slate-500">{t('No matching products.')}</p>
          )}
        </div>
      </div>

      {chosen.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-700">{t('What each child shows in the selector')}</p>
          {chosen.map((item) => (
            <div key={item.id} className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-600 min-w-0 flex-1 truncate">{item.name}</span>
              <input
                aria-label={t('Label for {name}', { name: item.name } as never)}
                data-testid={`card-label-${item.id}`}
                className="border border-slate-200 rounded px-2 py-1 text-xs w-32 focus:outline-none focus:ring-1 focus:ring-primary"
                value={labels[item.id] ?? ''}
                onChange={(e) => {
                  setTouched((current) => ({ ...current, [item.id]: true }));
                  setLabels((current) => ({ ...current, [item.id]: e.target.value }));
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* What the card will be, before it is made. */}
      <div className="rounded bg-slate-50 p-3 space-y-1" data-testid="card-preview">
        <p className="text-xs text-slate-700">
          {t('The card is never sold. Every child you choose stays purchasable at its own price and stock.')}
        </p>
        <p className="text-xs text-slate-700" data-testid="card-preview-status">
          {chosen[0]?.status === 'PUBLISHED' ? t('The card will start Published.') : t('The card will start Draft.')}
        </p>
        <p className="text-xs text-slate-700">
          {t('It appears in the shops its children are in, and takes their categories.')}
        </p>
        {lowest && (
          <p className="text-[10px] text-slate-500" data-testid="card-preview-price">
            {t('It copies the lowest child price for sorting only; customers pay each child’s own price.')}
          </p>
        )}
        <p className="text-[10px] text-slate-500">
          {t('Nothing is saved until you confirm, and the card and its children are saved together.')}
        </p>
      </div>

      {(blocked || problem) && (
        <p className="text-xs text-danger" role="alert" data-testid="card-problem">
          {problem ?? blocked}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
        <Button type="button" variant="secondary" onClick={onCancel} data-testid="card-cancel">
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          onClick={submit}
          isLoading={submitting}
          disabled={blocked !== null}
          data-testid="card-create"
        >
          {t('Create the card')}
        </Button>
      </div>
    </div>
  );
}
