import { localeLanguage, normalizeLocale, resolveLocalizedText } from '../shared/locale.util';

/**
 * P5-W2 — locale identity and the deterministic fallback.
 *
 * These are the rules the database CHECK, the resolver and every consumer all
 * have to agree on, so they are pinned here without a database in the way.
 */
describe('locale normalization (P5-W2)', () => {
  it('accepts a bare language and lowercases it', () => {
    expect(normalizeLocale('es')).toBe('es');
    expect(normalizeLocale('EN')).toBe('en');
    expect(normalizeLocale('  De  ')).toBe('de');
  });

  it('canonicalizes region casing and accepts either separator', () => {
    expect(normalizeLocale('pt-br')).toBe('pt-BR');
    expect(normalizeLocale('pt_BR')).toBe('pt-BR');
    expect(normalizeLocale('PT-Br')).toBe('pt-BR');
    // UN M.49 numeric regions stay digits.
    expect(normalizeLocale('es-419')).toBe('es-419');
  });

  it('canonicalizes a script subtag to Titlecase', () => {
    expect(normalizeLocale('zh-hant')).toBe('zh-Hant');
    expect(normalizeLocale('ZH-HANT-tw')).toBe('zh-Hant-TW');
  });

  it('REFUSES what it cannot model instead of guessing', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'e',
      'englsh4',
      '123',
      'es-',
      '-es',
      'es--MX',
      'es-MX-extra-more',
      'x'.repeat(40),
      'es MX',
    ]) {
      expect(normalizeLocale(bad)).toBeNull();
    }
  });

  it('reads the language half of a canonical tag', () => {
    expect(localeLanguage('pt-BR')).toBe('pt');
    expect(localeLanguage('zh-Hant-TW')).toBe('zh');
    expect(localeLanguage('es')).toBe('es');
  });
});

describe('deterministic Spanish-first fallback (P5-W2)', () => {
  const canonical = {
    name: 'Silla nórdica',
    description: 'Hecha a mano',
    metaTitle: 'Silla nórdica | DesignHof',
    metaDescription: 'Una silla',
  };
  const resolve = (requested: string | null | undefined, variants: any[] = []) =>
    resolveLocalizedText({ canonicalLocale: 'es', canonical, variants, requested });

  it('serves the canonical copy when nothing is requested', () => {
    expect(resolve(null)).toEqual({ locale: 'es', ...canonical });
    expect(resolve(undefined)).toEqual({ locale: 'es', ...canonical });
  });

  it('serves the canonical copy when the canonical locale itself is requested', () => {
    expect(resolve('es')).toEqual({ locale: 'es', ...canonical });
    // ...and ignores a stray translation row claiming to BE the canonical one.
    expect(resolve('es', [{ locale: 'es', name: 'Impostora' }])).toEqual({ locale: 'es', ...canonical });
  });

  it('serves the requested locale when a translation supplies it', () => {
    const result = resolve('en', [
      { locale: 'en', name: 'Nordic chair', description: 'Handmade', metaTitle: 'T', metaDescription: 'D' },
    ]);
    expect(result).toEqual({
      locale: 'en',
      name: 'Nordic chair',
      description: 'Handmade',
      metaTitle: 'T',
      metaDescription: 'D',
    });
  });

  it('falls back FIELD BY FIELD for a partial translation, and never suppresses the item', () => {
    const result = resolve('en', [{ locale: 'en', name: 'Nordic chair' }]);
    expect(result.name).toBe('Nordic chair');
    // The untranslated fields arrive in the canonical language beside it.
    expect(result.description).toBe('Hecha a mano');
    expect(result.metaTitle).toBe('Silla nórdica | DesignHof');
    // Something WAS served in English, so that is what the locale reports.
    expect(result.locale).toBe('en');
  });

  it('treats an EMPTY translated string as no translation at all', () => {
    const result = resolve('en', [{ locale: 'en', name: '', description: 'Handmade' }]);
    expect(result.name).toBe('Silla nórdica');
    expect(result.description).toBe('Handmade');
  });

  it('answers a REGIONAL request from a language-only translation', () => {
    const result = resolve('pt-BR', [{ locale: 'pt', name: 'Cadeira nórdica' }]);
    expect(result.name).toBe('Cadeira nórdica');
    expect(result.locale).toBe('pt');
  });

  it('prefers the EXACT tag over the language when both are stored', () => {
    const result = resolve('pt-BR', [
      { locale: 'pt', name: 'Cadeira (pt)' },
      { locale: 'pt-BR', name: 'Cadeira (pt-BR)' },
    ]);
    expect(result.name).toBe('Cadeira (pt-BR)');
    expect(result.locale).toBe('pt-BR');
  });

  it('is deterministic when only sibling regions exist', () => {
    const variants = [
      { locale: 'pt-PT', name: 'Cadeira (PT)' },
      { locale: 'pt-AO', name: 'Cadeira (AO)' },
    ];
    // Lowest tag by ordinary comparison, so two identical requests never
    // return different copy.
    expect(resolve('pt-BR', variants).name).toBe('Cadeira (AO)');
    expect(resolve('pt-BR', [...variants].reverse()).name).toBe('Cadeira (AO)');
  });

  it('falls back to canonical for an UNSUPPORTED locale, and says so', () => {
    const result = resolve('de', [{ locale: 'en', name: 'Nordic chair' }]);
    expect(result).toEqual({ locale: 'es', ...canonical });
  });

  it('falls back to canonical for a MALFORMED locale rather than erroring', () => {
    expect(resolve('not-a-locale-at-all', [{ locale: 'en', name: 'Nordic chair' }])).toEqual({
      locale: 'es',
      ...canonical,
    });
  });

  it('reports the CANONICAL locale when a translation row exists but translates nothing usable', () => {
    const result = resolve('en', [{ locale: 'en', name: null, description: null }]);
    expect(result).toEqual({ locale: 'es', ...canonical });
  });

  it('keeps an ABSENT optional canonical field absent — it never borrows another language', () => {
    const sparse = resolveLocalizedText({
      canonicalLocale: 'es',
      canonical: { name: 'Silla', description: null, metaTitle: null, metaDescription: null },
      // German has a description; Spanish does not. A request for ENGLISH must
      // not receive the German one — absence is the documented final step.
      variants: [{ locale: 'de', description: 'Handgemacht' }],
      requested: 'en',
    });
    expect(sparse.name).toBe('Silla');
    expect(sparse.description).toBeNull();
    expect(sparse.locale).toBe('es');
  });

  it('honours a NON-Spanish canonical locale — `es` is a default, not a fence', () => {
    const result = resolveLocalizedText({
      canonicalLocale: 'en',
      canonical: { name: 'Nordic chair', description: 'Handmade' },
      variants: [{ locale: 'es', name: 'Silla nórdica' }],
      requested: 'es',
    });
    expect(result).toEqual({
      locale: 'es',
      name: 'Silla nórdica',
      description: 'Handmade',
      metaTitle: null,
      metaDescription: null,
    });
    // And asking for the canonical language returns the base columns.
    expect(
      resolveLocalizedText({
        canonicalLocale: 'en',
        canonical: { name: 'Nordic chair' },
        variants: [{ locale: 'es', name: 'Silla nórdica' }],
        requested: 'en',
      }).name,
    ).toBe('Nordic chair');
  });
});
