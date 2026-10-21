/**
 * Guesses which rows of an import are the same model in different versions.
 *
 * Supplier files list every colour as its own row — "Lounge Chair Walter Green",
 * "Lounge Chair Walter Brown" — with nothing saying they belong together. The
 * shared leading words are the model; what is left over is the version.
 *
 * Nothing here writes anything: it proposes, and the user confirms.
 *
 * Shared words alone are not enough. Run against a real 830-item furniture
 * catalogue, the structural rule alone collected 30 unrelated models under the
 * brand "ROLF BENZ". So a proposal is only offered when every leftover reads
 * like a colour or a size; `proposeGroups` returns the rest marked unconfident
 * for callers that want to show them, and `confidentGroups` is what the import
 * actually offers.
 */

export interface ProposedMember {
  /** Index into the rows array the caller passed in. */
  row: number;
  name: string;
  /** What the website's selector would show, e.g. "Green". */
  label: string;
}

export interface GroupProposal {
  /** The shared leading words — the model name. */
  name: string;
  members: ProposedMember[];
  /** True when every leftover looks like a colour or size we recognise. */
  confident: boolean;
}

/** Leftovers that read like a version rather than a different product. */
const VERSION_WORDS = new Set([
  // colours (es)
  'negro',
  'negra',
  'blanco',
  'blanca',
  'rojo',
  'roja',
  'azul',
  'verde',
  'amarillo',
  'amarilla',
  'gris',
  'marron',
  'marrón',
  'beige',
  'crema',
  'rosa',
  'rosado',
  'morado',
  'violeta',
  'naranja',
  'dorado',
  'plateado',
  'celeste',
  'turquesa',
  'natural',
  'roble',
  'nogal',
  'haya',
  // colours (en)
  'black',
  'white',
  'red',
  'blue',
  'green',
  'yellow',
  'grey',
  'gray',
  'brown',
  'beige',
  'cream',
  'pink',
  'purple',
  'orange',
  'gold',
  'silver',
  'navy',
  'oak',
  'walnut',
  'teak',
  // sizes
  'xs',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'xxxl',
  'pequeno',
  'pequeño',
  'mediano',
  'grande',
  'chico',
  'small',
  'medium',
  'large',
  'mini',
  'maxi',
]);

const MIN_PREFIX_WORDS = 2;
const MAX_LABEL_WORDS = 2;
const MIN_MEMBERS = 2;

const words = (name: string) => name.trim().split(/\s+/).filter(Boolean);

const norm = (word: string) => word.toLowerCase().replace(/[.,;:()/-]/g, '');

/**
 * Leftovers that read like a size even though no word list could hold them:
 * dimensions (160x200, 80x80x40), measures (90 cm, 120mm), seat counts
 * (2 plazas, 3P). Bare numbers stay out — "Desk Pro 120 / 140" reads as a
 * model line as often as a size.
 */
const MEASUREMENT_PATTERNS = [
  /^\d+([.,]\d+)?(\s*x\s*\d+([.,]\d+)?){1,2}$/i,
  /^\d+([.,]\d+)?\s*(cm|mm|m|in|inch|")$/i,
  /^\d+\s*(p|pl|plazas?|puestos?|seats?)$/i,
];

const isMeasurement = (label: string): boolean => {
  const flat = label.trim().toLowerCase();
  return MEASUREMENT_PATTERNS.some((pattern) => pattern.test(flat));
};

const isKnownVocabulary = (label: string): boolean => label.split(/\s+/).every((word) => VERSION_WORDS.has(norm(word)));

/**
 * SKUs as a second witness: WALT-GRN / WALT-BRN — one stem, different
 * letter-bearing suffixes — is strong proof the rows are one model, whatever
 * the names say. Purely numeric suffixes (PRO-120 / PRO-140) do NOT count:
 * sequential codes read as a model line as often as sizes.
 */
function skusConfirmFamily(skus: Array<string | null | undefined>): boolean {
  const clean = skus.map((sku) => (sku ?? '').trim().toUpperCase());
  if (clean.length < MIN_MEMBERS || clean.some((sku) => !sku)) return false;

  let stem = clean[0];
  for (const sku of clean) {
    while (stem && !sku.startsWith(stem)) stem = stem.slice(0, -1);
  }
  // Cut the stem back to a delimiter boundary so "WALT-G" cannot count
  const boundary = Math.max(stem.lastIndexOf('-'), stem.lastIndexOf('_'), stem.lastIndexOf('/'), stem.lastIndexOf('.'));
  if (boundary >= 0) stem = stem.slice(0, boundary + 1);
  if (stem.replace(/[-_/.]/g, '').length < 3) return false;

  const suffixes = clean.map((sku) => sku.slice(stem.length));
  const distinct = new Set(suffixes);
  return distinct.size === clean.length && suffixes.every((suffix) => /[A-Z]/.test(suffix));
}

/** A row offered to the detector: the name decides, the SKU corroborates. */
export interface GroupingItem {
  name: string;
  sku?: string | null;
}

/** Phase-2 signals fed by the caller: what this company taught us. */
export interface GroupingOptions {
  /** Version words learned from accepted groups (already normalized). */
  learnedWords?: Iterable<string>;
  /** Signatures (normalizeGroupName) of suggestions the company said No to. */
  dismissedSignatures?: Iterable<string>;
}

/** The stable identity of a suggestion — dismissals key on this. */
export function normalizeGroupName(name: string): string {
  return words(name).map(norm).join(' ');
}

/**
 * Proposes variant groups for a batch of item names.
 *
 * A candidate needs at least two rows sharing at least two leading words, each
 * with a short leftover. The longest shared prefix wins, so "Chair Walter Wide
 * Green" groups with "Chair Walter Wide Brown" rather than with every Walter.
 *
 * Confidence comes from three independent signals: the leftover reads like a
 * known colour/size, like a measurement, or the group's SKUs share a stem.
 * A fourth is the file itself: a leftover repeated under several different
 * models ("Terra" on five sofas) is that supplier's own vocabulary.
 */
export function proposeGroups(items: Array<string | GroupingItem>, options?: GroupingOptions): GroupProposal[] {
  const learned = new Set(Array.from(options?.learnedWords ?? [], (word) => norm(word)));
  const dismissed = new Set(options?.dismissedSignatures ?? []);
  const knows = (label: string) =>
    isKnownVocabulary(label) || label.split(/\s+/).every((word) => learned.has(norm(word)));

  const rows = items.map((item, row) => {
    const name = typeof item === 'string' ? item : item.name;
    const sku = typeof item === 'string' ? null : (item.sku ?? null);
    return { row, name, sku, parts: words(name) };
  });

  // prefix (lowercased, joined) -> rows that start with it and keep a short tail
  const buckets = new Map<string, { row: number; name: string; label: string; prefixWords: number }[]>();
  for (const item of rows) {
    const maxPrefix = item.parts.length - 1;
    for (let take = MIN_PREFIX_WORDS; take <= maxPrefix; take += 1) {
      const tail = item.parts.slice(take);
      if (tail.length < 1 || tail.length > MAX_LABEL_WORDS) continue;
      const key = item.parts.slice(0, take).map(norm).join(' ');
      const entry = { row: item.row, name: item.name, label: tail.join(' '), prefixWords: take };
      const existing = buckets.get(key);
      if (existing) existing.push(entry);
      else buckets.set(key, [entry]);
    }
  }

  // Most specific prefixes first; a row can only join one group
  const ordered = Array.from(buckets.entries()).sort((a, b) => {
    const byWords = b[1][0].prefixWords - a[1][0].prefixWords;
    return byWords !== 0 ? byWords : b[1].length - a[1].length;
  });

  const claimed = new Set<number>();
  const proposals: GroupProposal[] = [];
  for (const [, entries] of ordered) {
    const free = entries.filter((e) => !claimed.has(e.row));
    if (free.length < MIN_MEMBERS) continue;
    // Two rows with the same leftover are duplicates, not two versions
    const labels = new Set(free.map((e) => norm(e.label)));
    if (labels.size < free.length) continue;

    const prefixWords = free[0].prefixWords;
    const source = rows.find((r) => r.row === free[0].row)!;
    const memberSkus = free.map((e) => rows.find((r) => r.row === e.row)!.sku);
    proposals.push({
      name: source.parts.slice(0, prefixWords).join(' '),
      members: free.map(({ row, name, label }) => ({ row, name, label })),
      confident: free.every((e) => knows(e.label) || isMeasurement(e.label)) || skusConfirmFamily(memberSkus),
    });
    free.forEach((e) => claimed.add(e.row));
  }

  // A dismissed suggestion stays dismissed: same model name, no more nagging
  const kept = dismissed.size
    ? proposals.filter((proposal) => !dismissed.has(normalizeGroupName(proposal.name)))
    : proposals;

  return kept.sort((a, b) => b.members.length - a.members.length);
}

/** The proposals safe enough to put in front of a user. */
export function confidentGroups(items: Array<string | GroupingItem>, options?: GroupingOptions): GroupProposal[] {
  return proposeGroups(items, options).filter((g) => g.confident);
}
