'use client';

import React from 'react';
import type { RelationshipOptions } from '../api/lifecycle.service';
import type { RelationshipDecisions } from './relationships-step';

/**
 * What the plan will do, in words, beside the button that approves it.
 *
 * An approval attests to a plan hash, and the relationship decisions are inside
 * that hash — so the person approving is attesting to a custody location, a
 * shop listing and a category rule whether or not they can see them. They could
 * not: the decisions were made two steps earlier and never restated. Somebody
 * approving a plan should be able to read what they are approving without
 * scrolling back through a form they filled in ten minutes ago.
 *
 * Names, not identifiers. A location id proves nothing to a person and invites
 * nobody to notice it is the wrong branch.
 */
export function RelationshipSummary({
  decisions,
  options,
}: {
  decisions: RelationshipDecisions;
  options: RelationshipOptions | null;
}) {
  const destination = options?.stockDestinations.find((d) => d.id === decisions.inventory?.defaultLocationId);
  const listedIn = (decisions.stores?.storeIds ?? [])
    .map((id) => options?.stores.find((s) => s.id === id)?.name ?? null)
    .filter((name): name is string => Boolean(name));

  const lines: { key: string; text: string }[] = [];

  if (decisions.inventory?.defaultLocationId) {
    lines.push({
      key: 'stock',
      text: destination
        ? `Stock will be held at ${destination.name}${
            destination.kind === 'WAREHOUSE' ? ' (warehouse)' : ' (shop custody)'
          }. Only rows with a positive quantity move stock.`
        : 'Stock will be held at the location you chose.',
    });
  } else {
    lines.push({ key: 'stock', text: 'No stock destination — this import moves no stock.' });
  }

  lines.push({
    key: 'stores',
    text: listedIn.length
      ? `Products will be listed in ${listedIn.join(', ')} as drafts. They are not published and not visible to customers.`
      : 'Products will not be listed in any shop.',
  });

  lines.push({
    key: 'categories',
    text: decisions.categories
      ? decisions.categories.createMissing
        ? 'Categories will be assigned, and any that do not exist yet will be created.'
        : 'Categories will be assigned. Nothing new will be created.'
      : 'No categories will be assigned.',
  });

  return (
    <div className="mt-2 rounded border border-slate-200 bg-white p-2 text-xs" data-testid="relationship-summary">
      <p className="font-semibold text-slate-800">What this import will do</p>
      <ul className="mt-1 space-y-0.5 text-slate-700">
        {lines.map((line) => (
          <li key={line.key} data-testid={`summary-${line.key}`}>
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
