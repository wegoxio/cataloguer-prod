import { ProductsService } from '../../catalogue/products.service';
import { stockDouble } from '../../../../../test/inventory-stock-support';

/** Minimal stand-in for MikroORM's Collection. */
function collection(initial: any[] = []) {
  return { getItems: () => initial, isInitialized: () => true, count: () => initial.length };
}

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('variant suggestions for the existing catalogue', () => {
  const build = (products: any[]) => {
    // Readiness is read in TWO batched queries — shops and specification
    // conflicts for every candidate at once, never per suggestion. These
    // doubles answer both with nothing, which is the honest shape for products
    // that were never given either.
    const executed: string[] = [];
    const repo: any = {
      find: jest.fn().mockResolvedValue(products),
      getEntityManager: () => ({
        execute: jest.fn(async (sql: string) => {
          executed.push(sql);
          return [];
        }),
      }),
    };
    return {
      svc: new ProductsService(
        repo,
        {} as any,
        {} as any,
        {} as any,
        {
          learnFromAcceptedGroup: jest.fn(),
          learnedWordsFor: jest.fn().mockResolvedValue([]),
          dismissedSignaturesFor: jest.fn().mockResolvedValue([]),
        } as any,
        {} as any,
        {} as any,
        stockDouble() as any,
      ),
      repo,
    };
  };

  it('suggests a group for ungrouped items that look like one model', async () => {
    const { svc } = build([
      { id: 'p1', name: 'Chair Wooz Natural', price: 100, children: collection() },
      { id: 'p2', name: 'Chair Wooz Walnut', price: 110, children: collection() },
      { id: 'p3', name: 'Alfombra Lake Grande', price: 50, children: collection() },
    ]);

    const out = await svc.findFamilySuggestions(ORG_ID);

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Chair Wooz');
    expect(out[0].members.map((m) => m.id)).toEqual(['p1', 'p2']);
    expect(out[0].members.map((m) => m.label)).toEqual(['Natural', 'Walnut']);
  });

  it('asks the database only for products outside any family', async () => {
    // Versions (parent set) never resurface: the query itself excludes them
    const { svc, repo } = build([]);

    await svc.findFamilySuggestions(ORG_ID);

    // #177: childlessness is part of the WHERE — the database returns only
    // candidates, and no child collections are populated just to be counted.
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ parent: null, children: { $none: {} } }),
      expect.not.objectContaining({ populate: expect.anything() }),
    );
  });

  it('stops suggesting for a product that already leads a family', async () => {
    const { svc } = build([
      { id: 'parent', name: 'Chair Wooz', price: 100, children: collection([{ id: 'p1' }, { id: 'p2' }]) },
      { id: 'p3', name: 'Alfombra Lake', price: 50, children: collection() },
    ]);

    expect(await svc.findFamilySuggestions(ORG_ID)).toEqual([]);
  });

  it('refuses to build a group from fewer than two items', async () => {
    const { svc } = build([]);
    await expect(svc.createFamily('Chair Wooz', [{ id: 'p1', label: 'Natural' }])).rejects.toThrow(
      'A parent needs at least two child products',
    );
    await expect(
      svc.createFamily('  ', [
        { id: 'p1', label: 'a' },
        { id: 'p2', label: 'b' },
      ]),
    ).rejects.toThrow('The parent product needs a name');
  });
});
