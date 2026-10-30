import { BadRequestException } from '@nestjs/common';

/**
 * Phase 6 — the FAIL-CLOSED parse layer for `/public` query strings.
 *
 * Until now the controller parsed with bare `parseInt`/`parseFloat`/equality,
 * so a typo silently changed meaning: `?hasSalePrice=yes` filtered as false,
 * `?limit=abc` fed NaN downstream, an unknown `?sortBy=` column reached the
 * ORM as a 500, and a misspelled parameter was ignored entirely — the caller
 * got a confident page that answered a different question than they asked.
 *
 * Every request is now parsed HERE, before any query construction, and every
 * defect is a stable, machine-readable 400:
 *
 *   { statusCode: 400, error: 'Bad Request', code, param, message }
 *
 * where `code` is one of `unknown_parameter`, `repeated_parameter`,
 * `malformed_value` or `unsupported_sort`. Codes are contract; messages are
 * for humans and may be reworded.
 *
 * What stays UNCHANGED is deliberate: absent parameters keep their v1
 * defaults, and out-of-RANGE page/limit values keep their v1 clamping —
 * `?limit=5000` still serves 100, because v1 did. Only inputs whose meaning
 * v1 silently guessed at are refused.
 */

export type PublicQueryErrorCode =
  | 'unknown_parameter'
  | 'repeated_parameter'
  | 'malformed_value'
  | 'unsupported_sort'
  | 'unknown_specification';

export class PublicQueryError extends BadRequestException {
  constructor(code: PublicQueryErrorCode, param: string, message: string) {
    super({ statusCode: 400, error: 'Bad Request', code, param, message });
  }
}

/** The only columns a public consumer may sort products by. */
export const PUBLIC_PRODUCT_SORTS = ['createdAt', 'price', 'name'] as const;
/** The only columns a public consumer may sort categories by. */
export const PUBLIC_CATEGORY_SORTS = ['sortOrder', 'name', 'createdAt'] as const;

const PRODUCT_PARAMS = new Set([
  'page',
  'limit',
  'sortBy',
  'sortDirection',
  'locale',
  'minPrice',
  'maxPrice',
  'hasSalePrice',
  'search',
  'mfgCode',
  'categorySlug',
  'inStock',
  'channel',
  'group',
]);
// `spec.<key>` parameters are recognized by prefix; see specFilters().
const SPEC_PREFIX = 'spec.';
const CATEGORY_PARAMS = new Set(['page', 'limit', 'sortBy', 'sortDirection', 'locale', 'channel', 'placement', 'group']);
const SEARCH_PARAMS = new Set(['q', 'limit', 'locale', 'channel']);

// BCP-47-shaped: `es`, `en-US`, `es-419`. Anything else is a typo, not a
// preference the fallback chain should quietly reinterpret.
const LOCALE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
// Slugs are generated lowercase-kebab; a value that cannot be a slug gets a
// 400 naming the defect instead of a 404 implying the catalogue was searched.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One raw query value as a scalar string. Express hands repeated parameters
 * back as arrays and bracketed ones as objects; both mean the request says two
 * things at once (or something that is not a value), so both are refused —
 * silently picking one interpretation is how callers end up trusting a page
 * that answered a different question.
 */
function scalar(query: Record<string, unknown>, param: string): string | undefined {
  const value = query[param];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new PublicQueryError('repeated_parameter', param, `The ${param} parameter may only be given once`);
  }
  if (typeof value !== 'string') {
    throw new PublicQueryError('malformed_value', param, `The ${param} parameter must be a single value`);
  }
  return value;
}

function positiveInt(query: Record<string, unknown>, param: string): number | undefined {
  const raw = scalar(query, param);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new PublicQueryError('malformed_value', param, `The ${param} parameter must be a whole number`);
  }
  return parseInt(raw, 10);
}

function decimal(query: Record<string, unknown>, param: string): number | undefined {
  const raw = scalar(query, param);
  if (raw === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new PublicQueryError('malformed_value', param, `The ${param} parameter must be a number`);
  }
  return parseFloat(raw);
}

function boolean(query: Record<string, unknown>, param: string): boolean | undefined {
  const raw = scalar(query, param);
  if (raw === undefined) return undefined;
  if (raw !== 'true' && raw !== 'false') {
    throw new PublicQueryError('malformed_value', param, `The ${param} parameter must be "true" or "false"`);
  }
  return raw === 'true';
}

function sort<T extends string>(
  query: Record<string, unknown>,
  allowed: readonly T[],
): { sortBy?: T; sortDirection?: 'asc' | 'desc' } {
  const sortBy = scalar(query, 'sortBy');
  if (sortBy !== undefined && !(allowed as readonly string[]).includes(sortBy)) {
    throw new PublicQueryError('unsupported_sort', 'sortBy', `sortBy must be one of: ${allowed.join(', ')}`);
  }
  const sortDirection = scalar(query, 'sortDirection');
  if (sortDirection !== undefined && sortDirection !== 'asc' && sortDirection !== 'desc') {
    throw new PublicQueryError('malformed_value', 'sortDirection', 'sortDirection must be "asc" or "desc"');
  }
  return { sortBy: sortBy as T | undefined, sortDirection };
}

function locale(query: Record<string, unknown>): string | undefined {
  const raw = scalar(query, 'locale');
  if (raw === undefined) return undefined;
  if (!LOCALE_RE.test(raw)) {
    throw new PublicQueryError('malformed_value', 'locale', 'locale must be a language tag such as "es" or "en-US"');
  }
  return raw;
}

function rejectUnknown(query: Record<string, unknown>, supported: ReadonlySet<string>, allowSpecs = false): void {
  for (const key of Object.keys(query)) {
    if (allowSpecs && key.startsWith(SPEC_PREFIX)) continue;
    if (!supported.has(key)) {
      throw new PublicQueryError('unknown_parameter', key, `Unsupported query parameter: ${key}`);
    }
  }
}

/**
 * A free-text term (`search`, `mfgCode`). Bounded at 2–80 characters: one
 * character matches half the catalogue and answers nothing, and an unbounded
 * term is an ILIKE pattern of arbitrary cost.
 */
function term(query: Record<string, unknown>, param: string): string | undefined {
  const raw = scalar(query, param);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length < 2 || trimmed.length > 80) {
    throw new PublicQueryError('malformed_value', param, `The ${param} parameter must be 2 to 80 characters`);
  }
  return trimmed;
}

function categorySlug(query: Record<string, unknown>): string | undefined {
  const raw = scalar(query, 'categorySlug');
  if (raw === undefined) return undefined;
  if (raw.length > 200 || !SLUG_RE.test(raw)) {
    throw new PublicQueryError('malformed_value', 'categorySlug', 'categorySlug must be a slug such as "sillas"');
  }
  return raw;
}

function key(query: Record<string, unknown>, param: string): string | undefined {
  const raw = scalar(query, param);
  if (raw === undefined) return undefined;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) || raw.length > 80) {
    throw new PublicQueryError('malformed_value', param, `${param} must be a lowercase key such as "retail"`);
  }
  return raw;
}

function placement(query: Record<string, unknown>): 'HOME' | 'CATALOG' | 'NAVIGATION' | undefined {
  const raw = scalar(query, 'placement');
  if (raw === undefined) return undefined;
  if (!['HOME', 'CATALOG', 'NAVIGATION'].includes(raw)) {
    throw new PublicQueryError('malformed_value', 'placement', 'placement must be HOME, CATALOG or NAVIGATION');
  }
  return raw as 'HOME' | 'CATALOG' | 'NAVIGATION';
}

/**
 * `spec.<key>=<value>` filters. The KEY vocabulary is decided later against
 * the channel's activated, filterable, public specifications (the service
 * refuses anything else with `unknown_specification`); here only the SHAPE is
 * enforced. Repeating the SAME key is the one place repetition is meaningful —
 * the values OR together — so spec parameters are exempt from the
 * repeated-parameter rule that scalars carry.
 */
function specFilters(query: Record<string, unknown>): Record<string, string[]> | undefined {
  const specs: Record<string, string[]> = {};
  for (const key of Object.keys(query)) {
    if (!key.startsWith(SPEC_PREFIX)) continue;
    const specKey = key.slice(SPEC_PREFIX.length);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(specKey)) {
      throw new PublicQueryError(
        'malformed_value',
        key,
        'Specification keys are short identifiers, e.g. spec.material',
      );
    }
    const value = query[key];
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) {
        throw new PublicQueryError('malformed_value', key, `Each ${key} value must be 1 to 200 characters`);
      }
    }
    specs[specKey] = values as string[];
  }
  return Object.keys(specs).length ? specs : undefined;
}

/** A path slug (`/products/:slug`, `/categories/:slug/products`). */
export function parsePublicSlug(raw: string, param: string): string {
  if (raw.length > 200 || !SLUG_RE.test(raw)) {
    throw new PublicQueryError('malformed_value', param, `The ${param} must be a slug such as "silla-nordica"`);
  }
  return raw;
}

/** A `?locale=` given alone (the by-slug routes take no other parameters). */
export function parsePublicLocaleQuery(query: Record<string, unknown>): { locale?: string } {
  rejectUnknown(query, new Set(['locale']));
  return { locale: locale(query) };
}

/** A product detail is public only inside the channel requested by the site. */
export function parsePublicProductDetailQuery(query: Record<string, unknown>): { locale?: string; channel?: string } {
  rejectUnknown(query, new Set(['locale', 'channel']));
  return { locale: locale(query), channel: key(query, 'channel') };
}

export interface PublicCategoriesQuery {
  page?: number;
  limit?: number;
  sortBy?: (typeof PUBLIC_CATEGORY_SORTS)[number];
  sortDirection?: 'asc' | 'desc';
  locale?: string;
  channel?: string;
  placement?: 'HOME' | 'CATALOG' | 'NAVIGATION';
  group?: string;
}

export function parsePublicCategoriesQuery(query: Record<string, unknown>): PublicCategoriesQuery {
  rejectUnknown(query, CATEGORY_PARAMS);
  return {
    page: positiveInt(query, 'page'),
    limit: positiveInt(query, 'limit'),
    ...sort(query, PUBLIC_CATEGORY_SORTS),
    locale: locale(query),
    channel: key(query, 'channel'),
    placement: placement(query),
    group: key(query, 'group'),
  };
}

export interface PublicProductsQuery {
  page?: number;
  limit?: number;
  sortBy?: (typeof PUBLIC_PRODUCT_SORTS)[number];
  sortDirection?: 'asc' | 'desc';
  locale?: string;
  minPrice?: number;
  maxPrice?: number;
  hasSalePrice?: boolean;
  search?: string;
  mfgCode?: string;
  categorySlug?: string;
  inStock?: boolean;
  specs?: Record<string, string[]>;
  channel?: string;
  group?: string;
}

export interface PublicProductSearchQuery {
  search: string;
  limit: number;
  locale?: string;
  channel?: string;
}

/** Compact typeahead contract used by storefront search boxes. */
export function parsePublicProductSearchQuery(query: Record<string, unknown>): PublicProductSearchQuery {
  rejectUnknown(query, SEARCH_PARAMS);
  const search = term(query, 'q');
  if (!search) {
    throw new PublicQueryError('malformed_value', 'q', 'The q parameter is required');
  }
  const limit = positiveInt(query, 'limit') ?? 8;
  if (limit < 1 || limit > 20) {
    throw new PublicQueryError('malformed_value', 'limit', 'limit must be between 1 and 20');
  }
  return { search, limit, locale: locale(query), channel: key(query, 'channel') };
}

export function parsePublicProductsQuery(query: Record<string, unknown>): PublicProductsQuery {
  rejectUnknown(query, PRODUCT_PARAMS, true);
  return {
    page: positiveInt(query, 'page'),
    limit: positiveInt(query, 'limit'),
    ...sort(query, PUBLIC_PRODUCT_SORTS),
    locale: locale(query),
    minPrice: decimal(query, 'minPrice'),
    maxPrice: decimal(query, 'maxPrice'),
    hasSalePrice: boolean(query, 'hasSalePrice'),
    search: term(query, 'search'),
    // The manufacturer's reference is its OWN parameter (governing decision
    // 18 / Phase 6 D1): never merged into `search`, never echoed in the DTO.
    mfgCode: term(query, 'mfgCode'),
    categorySlug: categorySlug(query),
    inStock: boolean(query, 'inStock'),
    specs: specFilters(query),
    channel: key(query, 'channel'),
    group: key(query, 'group'),
  };
}
