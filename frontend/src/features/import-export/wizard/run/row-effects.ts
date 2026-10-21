import type { RowEffects } from '../api/lifecycle.service';

/**
 * What a row did, in the words the downloadable report uses.
 *
 * These phrases are not this file's to invent. They are fixed by
 * `backend/test/fixtures/row-effect-phrases.json`, which the server's report
 * and this module are both tested against, so a person comparing the screen to
 * the spreadsheet sees the same sentence in both places.
 *
 * That matters because of what went wrong: a run reported six rows CREATED
 * while listing none of them in the shop it was scoped to and filing none of
 * them under a category. Every silence here is therefore spelled out. A row
 * that did not do something says which something and why not, and a row from
 * before the server recorded effects says "not recorded" rather than borrowing
 * the words for "nothing to do".
 */

export interface DescribedEffects {
  product: string;
  store: string;
  categories: string;
  stock: string;
}

const NOT_RECORDED: DescribedEffects = {
  product: 'not recorded',
  store: 'not recorded',
  categories: 'not recorded',
  stock: 'not recorded',
};

export function describeEffects(effects: RowEffects | null | undefined): DescribedEffects {
  // A row imported before the run recorded its effects. It has no answer, and
  // inventing one — "not requested" for everything — would state as fact
  // something this run never observed.
  if (!effects) return { ...NOT_RECORDED };

  return {
    product: effects.product ? word(effects.product.state) : 'not recorded',
    store: describeStore(effects.storeAssociation),
    categories: describeCategories(effects.categories),
    stock: describeStock(effects.inventory),
  };
}

function describeStore(store: RowEffects['storeAssociation']): string {
  if (!store) return 'not recorded';
  if (store.state === 'NOT_REQUESTED') return 'not requested';
  // "(unpublished)" is unconditional because an import never publishes. Saying
  // it every time is what stops somebody assuming the products went live.
  const named = store.storeName ? ` in ${store.storeName}` : '';
  return `${word(store.state)}${named} (unpublished)`;
}

function describeCategories(categories: RowEffects['categories']): string {
  if (!categories) return 'not recorded';
  if (categories.state === 'NOT_REQUESTED') return 'not requested';

  // Created and reused are reported separately because they are different
  // events. A run that quietly created a category tree nobody asked for looks
  // identical to one that filed products under existing categories, unless the
  // report distinguishes them.
  const parts: string[] = [];
  if (categories.created?.length) parts.push(`created: ${categories.created.join('; ')}`);
  if (categories.reused?.length) parts.push(`reused: ${categories.reused.join('; ')}`);
  if (categories.blocked?.length) parts.push(`not applied: ${categories.blocked.join('; ')}`);
  return parts.length ? parts.join(' | ') : word(categories.state);
}

function describeStock(inventory: RowEffects['inventory']): string {
  if (!inventory) return 'not recorded';
  if (inventory.state === 'NOT_REQUESTED') return 'not requested';
  // A declared zero is a deliberate non-event and is reported as one. Rendering
  // it as blank would make "the file said zero" indistinguishable from "the
  // file said nothing".
  if (inventory.state === 'ZERO_NO_MOVEMENT') return 'no stock movement (zero)';
  if (inventory.state === 'CREATED') {
    const kind = inventory.locationKind ? ` (${inventory.locationKind.toLowerCase()})` : '';
    return `${inventory.quantity ?? 0} to ${inventory.locationName ?? 'the chosen location'}${kind}`;
  }
  return word(inventory.state);
}

/**
 * `ZERO_NO_MOVEMENT` is a name for programmers. Nobody reading a report should
 * have to translate it, and an unknown state from a newer server still renders
 * as something readable rather than blank.
 */
function word(state: string): string {
  return state.toLowerCase().replace(/_/g, ' ');
}
