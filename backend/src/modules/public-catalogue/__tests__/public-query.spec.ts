import {
  PublicQueryError,
  parsePublicCategoriesQuery,
  parsePublicLocaleQuery,
  parsePublicProductDetailQuery,
  parsePublicProductsQuery,
  parsePublicSlug,
} from '../query/public-query';

/**
 * Phase 6 fail-closed contract: a `/public` query string either parses into
 * exactly what the caller asked, or dies as a stable machine-readable 400 —
 * never a silent reinterpretation, never an ORM-level 500.
 */
describe('public query parsing (fail closed)', () => {
  const errorBody = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(PublicQueryError);
      return (error as PublicQueryError).getResponse() as Record<string, unknown>;
    }
    throw new Error('expected the parse to throw');
  };

  describe('products', () => {
    it('parses a fully-specified valid query verbatim', () => {
      expect(
        parsePublicProductsQuery({
          page: '2',
          limit: '10',
          sortBy: 'price',
          sortDirection: 'asc',
          locale: 'en-US',
          minPrice: '10.5',
          maxPrice: '99',
          hasSalePrice: 'true',
        }),
      ).toEqual({
        page: 2,
        limit: 10,
        sortBy: 'price',
        sortDirection: 'asc',
        locale: 'en-US',
        minPrice: 10.5,
        maxPrice: 99,
        hasSalePrice: true,
      });
    });

    it('an empty query parses to all-undefined — absent keeps its v1 default', () => {
      expect(parsePublicProductsQuery({})).toEqual({
        page: undefined,
        limit: undefined,
        sortBy: undefined,
        sortDirection: undefined,
        locale: undefined,
        minPrice: undefined,
        maxPrice: undefined,
        hasSalePrice: undefined,
      });
    });

    it('refuses an unsupported parameter with a machine-readable body', () => {
      const body = errorBody(() => parsePublicProductsQuery({ hasSaleprice: 'true' }));
      expect(body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        code: 'unknown_parameter',
        param: 'hasSaleprice',
        message: 'Unsupported query parameter: hasSaleprice',
      });
    });

    it('refuses a repeated scalar parameter instead of picking one occurrence', () => {
      const body = errorBody(() => parsePublicProductsQuery({ minPrice: ['5', '10'] }));
      expect(body).toMatchObject({ code: 'repeated_parameter', param: 'minPrice' });
    });

    it('refuses a bracketed (non-scalar) value', () => {
      const body = errorBody(() => parsePublicProductsQuery({ page: { $gt: '1' } as never }));
      expect(body).toMatchObject({ code: 'malformed_value', param: 'page' });
    });

    it.each([
      ['page', 'abc'],
      ['page', '1.5'],
      ['page', '-1'],
      ['limit', '10x'],
      ['minPrice', 'cheap'],
      ['minPrice', '1,50'],
      ['maxPrice', '1e3'],
      ['hasSalePrice', 'yes'],
      ['hasSalePrice', 'TRUE'],
      ['hasSalePrice', '1'],
      ['sortDirection', 'up'],
      ['locale', 'not a locale'],
      ['locale', 'es_ES'],
    ])('refuses malformed %s=%s', (param, value) => {
      const body = errorBody(() => parsePublicProductsQuery({ [param]: value }));
      expect(body).toMatchObject({ code: 'malformed_value', param });
    });

    it('parses the Phase 6 discovery parameters', () => {
      expect(
        parsePublicProductsQuery({
          search: '  mesa nórdica ',
          mfgCode: 'FAB-123',
          categorySlug: 'sillas-oficina',
          inStock: 'true',
          'spec.material': 'Roble',
          'spec.ancho': ['90', '120'],
        }),
      ).toMatchObject({
        search: 'mesa nórdica', // trimmed
        mfgCode: 'FAB-123',
        categorySlug: 'sillas-oficina',
        inStock: true,
        specs: { material: ['Roble'], ancho: ['90', '120'] },
      });
    });

    it('bounds free-text terms to 2–80 characters', () => {
      for (const [param, value] of [
        ['search', 'a'],
        ['search', 'x'.repeat(81)],
        ['mfgCode', ' 1 '], // trims to a single character
      ] as const) {
        const body = errorBody(() => parsePublicProductsQuery({ [param]: value }));
        expect(body).toMatchObject({ code: 'malformed_value', param });
      }
    });

    it('refuses a malformed categorySlug and a repeated search', () => {
      expect(errorBody(() => parsePublicProductsQuery({ categorySlug: 'No Slug!' }))).toMatchObject({
        code: 'malformed_value',
        param: 'categorySlug',
      });
      expect(errorBody(() => parsePublicProductsQuery({ search: ['a', 'b'] }))).toMatchObject({
        code: 'repeated_parameter',
        param: 'search',
      });
    });

    it('spec parameters: repetition is legal (values OR), but the key must be a plain identifier', () => {
      expect(parsePublicProductsQuery({ 'spec.material': ['Roble', 'Nogal'] }).specs).toEqual({
        material: ['Roble', 'Nogal'],
      });
      expect(errorBody(() => parsePublicProductsQuery({ 'spec.': 'x' }))).toMatchObject({
        code: 'malformed_value',
        param: 'spec.',
      });
      expect(errorBody(() => parsePublicProductsQuery({ 'spec.mal clave': 'x' }))).toMatchObject({
        code: 'malformed_value',
        param: 'spec.mal clave',
      });
      expect(errorBody(() => parsePublicProductsQuery({ 'spec.material': '' }))).toMatchObject({
        code: 'malformed_value',
        param: 'spec.material',
      });
    });

    it('allowing spec.* does not reopen the door for other unknown parameters', () => {
      expect(errorBody(() => parsePublicProductsQuery({ specs: 'material=Roble' }))).toMatchObject({
        code: 'unknown_parameter',
        param: 'specs',
      });
    });

    it('whitelists sortBy: real columns outside the contract are as refused as nonsense', () => {
      for (const sortBy of ['salePrice', 'keyHash', 'updatedAt', 'sortOrder', 'nonsense']) {
        const body = errorBody(() => parsePublicProductsQuery({ sortBy }));
        expect(body).toMatchObject({ code: 'unsupported_sort', param: 'sortBy' });
      }
      for (const sortBy of ['createdAt', 'price', 'name']) {
        expect(parsePublicProductsQuery({ sortBy }).sortBy).toBe(sortBy);
      }
    });
  });

  describe('categories', () => {
    it('accepts its own sort vocabulary, which differs from the products one', () => {
      for (const sortBy of ['sortOrder', 'name', 'createdAt']) {
        expect(parsePublicCategoriesQuery({ sortBy }).sortBy).toBe(sortBy);
      }
      const body = errorBody(() => parsePublicCategoriesQuery({ sortBy: 'price' }));
      expect(body).toMatchObject({ code: 'unsupported_sort', param: 'sortBy' });
    });

    it('refuses product-only parameters — the contract is per endpoint', () => {
      const body = errorBody(() => parsePublicCategoriesQuery({ minPrice: '10' }));
      expect(body).toMatchObject({ code: 'unknown_parameter', param: 'minPrice' });
    });
  });

  describe('slug routes', () => {
    it('accepts real slugs and passes them through unchanged', () => {
      expect(parsePublicSlug('silla-nordica', 'product slug')).toBe('silla-nordica');
      expect(parsePublicSlug('a1-b2-c3', 'product slug')).toBe('a1-b2-c3');
    });

    it.each(['Silla-Nordica', 'silla nordica', 'silla--', '-silla', 'silla_%00', 'a'.repeat(201)])(
      'refuses a value that cannot be a slug (%s) with a 400, not a 404',
      (slug) => {
        const body = errorBody(() => parsePublicSlug(slug, 'product slug'));
        expect(body).toMatchObject({ code: 'malformed_value', param: 'product slug' });
      },
    );

    it('category by-slug accepts locale and nothing else', () => {
      expect(parsePublicLocaleQuery({ locale: 'es' })).toEqual({ locale: 'es' });
      expect(parsePublicLocaleQuery({})).toEqual({ locale: undefined });
      const body = errorBody(() => parsePublicLocaleQuery({ page: '1' }));
      expect(body).toMatchObject({ code: 'unknown_parameter', param: 'page' });
    });

    it('product detail accepts a strict channel key as well as locale', () => {
      expect(parsePublicProductDetailQuery({ locale: 'es', channel: 'mobiliario-h1' })).toEqual({
        locale: 'es',
        channel: 'mobiliario-h1',
      });
      expect(parsePublicProductDetailQuery({})).toEqual({ locale: undefined, channel: undefined });
      expect(errorBody(() => parsePublicProductDetailQuery({ channel: 'Mobiliario H1' }))).toMatchObject({
        code: 'malformed_value',
        param: 'channel',
      });
      expect(errorBody(() => parsePublicProductDetailQuery({ page: '1' }))).toMatchObject({
        code: 'unknown_parameter',
        param: 'page',
      });
    });
  });
});
