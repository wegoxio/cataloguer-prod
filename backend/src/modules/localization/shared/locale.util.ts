/**
 * Locale identity and the deterministic Spanish-first fallback (P5-W2).
 *
 * ONE normalizer and ONE resolver, because a value written one way and looked
 * up another simply never matches: a translation stored as `PT_br` and asked
 * for as `pt-BR` would silently fall back to Spanish and look like a missing
 * translation rather than a casing mismatch.
 */

/**
 * The canonical written form of a locale tag, or null when the input is not
 * one.
 *
 * Accepts `language[-Script][-REGION]` with the separator written either way
 * (`pt_BR` and `pt-br` are the same tag) and returns BCP 47 canonical casing:
 * lowercase language, Titlecase script, UPPERCASE region, or a three-digit
 * UN M.49 region kept as digits.
 *
 * Everything else is REFUSED rather than coerced. A malformed tag is a caller
 * mistake, and guessing at one ("en-US-posix-x-lvariant" → "en"?) would make
 * two different requests silently mean the same thing.
 */
export function normalizeLocale(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '' || trimmed.length > 20) return null;

  const parts = trimmed.replace(/_/g, '-').split('-');
  if (parts.length === 0 || parts.length > 3) return null;

  const [languageRaw, ...rest] = parts;
  if (!/^[A-Za-z]{2,3}$/.test(languageRaw)) return null;
  const out = [languageRaw.toLowerCase()];

  let index = 0;
  if (rest.length > index && /^[A-Za-z]{4}$/.test(rest[index])) {
    const script = rest[index];
    out.push(script[0].toUpperCase() + script.slice(1).toLowerCase());
    index += 1;
  }
  if (rest.length > index && /^([A-Za-z]{2}|[0-9]{3})$/.test(rest[index])) {
    const region = rest[index];
    out.push(/^[0-9]{3}$/.test(region) ? region : region.toUpperCase());
    index += 1;
  }
  // Anything left over is a subtag this contract does not model.
  if (index !== rest.length) return null;
  return out.join('-');
}

/** The language half of a normalized tag: `pt-BR` → `pt`. */
export function localeLanguage(normalized: string): string {
  return normalized.split('-')[0];
}

/** The four localizable text fields, named once. */
export const LOCALIZED_TEXT_FIELDS = ['name', 'description', 'metaTitle', 'metaDescription'] as const;
export type LocalizedTextField = (typeof LOCALIZED_TEXT_FIELDS)[number];

export type LocalizedText = Partial<Record<LocalizedTextField, string | null>>;

/** One stored translation row, reduced to what resolution needs. */
export interface LocaleVariant extends LocalizedText {
  locale: string;
}

/**
 * What a resolution decided, per field and as a whole.
 *
 * `locale` is the locale the returned COPY is in, and it is the honest answer
 * rather than the requested one: asking for `de` and receiving Spanish must
 * say `es`, or a consumer caches Spanish under a German key.
 */
export interface ResolvedLocalizedText {
  locale: string;
  name: string;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
}

/**
 * THE FALLBACK, stated once and applied everywhere.
 *
 *   1. the requested locale, when it is well-formed AND a stored translation
 *      supplies the field;
 *   2. failing an exact tag, the same LANGUAGE — `pt-BR` accepts a `pt`
 *      translation, because a regional request is a preference, not a
 *      different language;
 *   3. the CANONICAL value, which is the base column, written in the
 *      organization's `default_content_locale` (`es` by decision 13);
 *   4. and when the canonical value of an OPTIONAL field is absent, the field
 *      stays absent. That is the documented final step: absence is a fact
 *      about the catalogue, and borrowing another language's description to
 *      fill it would publish text the reader did not ask for and the owner
 *      never approved for that field. `name` is NOT NULL, so step 4 is
 *      unreachable for it.
 *
 * PARTIAL TRANSLATIONS ARE NORMAL. Each field is resolved on its own, so a
 * row translating only `name` yields a translated name beside the canonical
 * description — and never suppresses the product.
 *
 * A translation row whose locale EQUALS the canonical locale is ignored
 * outright: the base columns are the canonical copy, and admitting a second
 * one would make "which Spanish is the real Spanish" a question.
 */
export function resolveLocalizedText(params: {
  canonicalLocale: string;
  canonical: { name: string; description?: string | null; metaTitle?: string | null; metaDescription?: string | null };
  variants?: LocaleVariant[];
  requested?: string | null;
}): ResolvedLocalizedText {
  const canonicalLocale = normalizeLocale(params.canonicalLocale) ?? 'es';
  const canonical: ResolvedLocalizedText = {
    locale: canonicalLocale,
    name: params.canonical.name,
    description: params.canonical.description ?? null,
    metaTitle: params.canonical.metaTitle ?? null,
    metaDescription: params.canonical.metaDescription ?? null,
  };

  const requested = normalizeLocale(params.requested ?? null);
  // No request, a malformed request, or a request for the canonical locale
  // itself: the canonical copy, byte-for-byte what this API always returned.
  if (requested === null || requested === canonicalLocale) return canonical;

  const usable = (params.variants ?? []).filter((variant) => {
    const normalized = normalizeLocale(variant.locale);
    return normalized !== null && normalized !== canonicalLocale;
  });
  if (usable.length === 0) return canonical;

  const byLocale = new Map<string, LocaleVariant>();
  for (const variant of usable) byLocale.set(normalizeLocale(variant.locale) as string, variant);

  const exact = byLocale.get(requested) ?? null;
  // Language-only fallback, deterministic when several regions are stored:
  // the bare language tag wins, then the lowest tag by ordinary comparison.
  const language = localeLanguage(requested);
  const sameLanguage =
    byLocale.get(language) ??
    [...byLocale.entries()]
      .filter(([tag]) => localeLanguage(tag) === language)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, variant]) => variant)[0] ??
    null;

  const pick = (field: LocalizedTextField): { value: string | null; from: string | null } => {
    for (const candidate of [exact, sameLanguage]) {
      if (!candidate) continue;
      const value = candidate[field];
      if (typeof value === 'string' && value !== '') {
        return { value, from: normalizeLocale(candidate.locale) };
      }
    }
    return { value: null, from: null };
  };

  const name = pick('name');
  const description = pick('description');
  const metaTitle = pick('metaTitle');
  const metaDescription = pick('metaDescription');

  // The served locale is the requested language only when SOMETHING actually
  // came from it. A row that translated nothing usable leaves the answer
  // canonical, and says so.
  const servedFrom = [name.from, description.from, metaTitle.from, metaDescription.from].find(
    (from): from is string => from !== null,
  );

  return {
    locale: servedFrom ?? canonicalLocale,
    name: name.value ?? canonical.name,
    description: description.value ?? canonical.description,
    metaTitle: metaTitle.value ?? canonical.metaTitle,
    metaDescription: metaDescription.value ?? canonical.metaDescription,
  };
}
