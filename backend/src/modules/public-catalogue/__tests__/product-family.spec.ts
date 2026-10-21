import { mapProductToPublicDto } from '../dto/public-catalogue.dto';
import { ProductStatus } from '../../products/catalogue/product-status.enum';

/** Collection stand-in. */
const coll = (items: any[] = []) => ({
  getItems: () => items,
  isInitialized: () => true,
  count: () => items.length,
});

/**
 * A store_products row as the entity actually defines it. `published` DEFAULTS
 * TO FALSE there, and the fixtures used to omit it — which is how a child with
 * no published link to the requested store passed for a visible one.
 */
const link = (over: Record<string, any>) => ({
  published: true,
  price: null,
  salePrice: null,
  stockQuantity: 0,
  trackInventory: false,
  ...over,
});

const child = (over: Record<string, any>) => ({
  status: ProductStatus.PUBLISHED,
  archivedAt: null,
  price: 100,
  salePrice: null,
  stockQuantity: 3,
  trackInventory: true,
  images: coll(),
  branchLinks: coll(),
  ...over,
});

describe('public DTO for a product family (parent/child model)', () => {
  const parent = () => ({
    id: 'walter',
    name: 'Chair Walter',
    slug: 'chair-walter',
    price: 100,
    salePrice: null,
    stockQuantity: 0,
    trackInventory: false,
    categories: coll(),
    images: coll(),
    branchLinks: coll(),
    parent: null,
    children: coll([
      child({
        id: 'green',
        name: 'Chair Walter Green',
        slug: 'chair-walter-green',
        optionLabel: 'Green',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        images: coll([{ url: 'green.jpg', isPrimary: true, archivedAt: null, displayMode: 'CONTAIN', sortOrder: 0 }]),
        // Published here, stating no price of its own.
        branchLinks: coll([link({ store: 's1', stockQuantity: 3, trackInventory: true })]),
      }),
      child({
        id: 'brown',
        name: 'Chair Walter Brown',
        slug: 'chair-walter-brown',
        optionLabel: 'Brown',
        createdAt: new Date('2026-01-01T00:00:01Z'),
        price: 110,
        branchLinks: coll([link({ store: 's1', price: 95, stockQuantity: 7, trackInventory: true })]),
      }),
      child({ id: 'draft', name: 'Chair Walter Red', optionLabel: 'Red', status: ProductStatus.DRAFT }),
    ]),
  });

  it('marks the card as not purchasable and its versions as purchasable (B2)', () => {
    const card = mapProductToPublicDto(parent() as any);
    expect(card.purchasable).toBe(false);

    // A version fetched on its own is a real item: it has no children.
    const version = mapProductToPublicDto(
      child({
        id: 'green',
        name: 'Chair Walter Green',
        slug: 'chair-walter-green',
        optionLabel: 'Green',
        categories: coll(),
        children: coll(),
        parent: { id: 'walter' },
      }) as any,
    );
    expect(version.purchasable).toBe(true);
    expect(version.parentId).toBe('walter');
  });

  it('marks a standalone item as purchasable (B2, unchanged behaviour)', () => {
    const alone = mapProductToPublicDto({
      id: 'lamp',
      name: 'Lamp',
      slug: 'lamp',
      price: 40,
      salePrice: null,
      stockQuantity: 2,
      trackInventory: true,
      categories: coll(),
      images: coll(),
      branchLinks: coll(),
      parent: null,
      children: coll(),
    } as any);
    expect(alone.purchasable).toBe(true);
    expect(alone.children).toEqual([]);
  });

  it('keeps child ids and branch-specific values as the buyable selections (B2)', () => {
    const dto = mapProductToPublicDto(parent() as any, 's1');

    // Every selectable entry is a CHILD product id — never the card's id.
    expect(dto.children.map((v) => v.id)).toEqual(['green', 'brown']);
    expect(dto.children.map((v) => v.id)).not.toContain(dto.id);

    // The branch's own price and stock win for that child.
    const brown = dto.children.find((v) => v.id === 'brown')!;
    expect(brown.price).toBe(95);
    expect(brown.stockQuantity).toBe(7);
    expect(brown.trackInventory).toBe(true);

    // A link that states no price of its own falls back to the base price.
    // (This assertion used to read "a child WITHOUT a link keeps its base
    // values" — which only held because the projection ignored the store
    // entirely. A child with no published link here is now not shown at all.)
    const green = dto.children.find((v) => v.id === 'green')!;
    expect(green.price).toBe(100);
    expect(green.stockQuantity).toBe(3);
  });

  it('serves the children as the card selector, skipping unpublished ones', () => {
    const dto = mapProductToPublicDto(parent() as any);

    expect(dto.children.map((v) => v.optionLabel)).toEqual(['Green', 'Brown']);
    expect(dto.children[0].slug).toBe('chair-walter-green');
    expect(dto.parentId).toBeNull();
  });

  it("prices each version by the requesting store's own link", () => {
    const dto = mapProductToPublicDto(parent() as any, 's1');

    const brown = dto.children.find((v) => v.optionLabel === 'Brown')!;
    expect(brown.price).toBe(95);
    expect(brown.stockQuantity).toBe(7);
  });

  it('borrows the first version photo when the card has none of its own', () => {
    const dto = mapProductToPublicDto(parent() as any);

    expect(dto.primaryImage?.url).toBe('green.jpg');
  });

  it('marks a version with its parent id when fetched directly', () => {
    const version = {
      ...child({ id: 'green', name: 'Chair Walter Green', slug: 'chair-walter-green', optionLabel: 'Green' }),
      categories: coll(),
      children: coll(),
      parent: { id: 'walter' },
    };

    const dto = mapProductToPublicDto(version as any);

    expect(dto.parentId).toBe('walter');
    expect(dto.optionLabel).toBe('Green');
  });

  describe('deterministic selector order (B4b)', () => {
    it('orders versions by creation time then id, whatever order the collection arrives in', () => {
      const shuffled = parent();
      const items = (shuffled.children as any).getItems();
      items.reverse(); // simulate DB-arbitrary collection order

      const dto = mapProductToPublicDto(shuffled as any);

      expect(dto.children.map((v) => v.id)).toEqual(['green', 'brown']);
    });

    it('breaks equal creation times by id, so ties cannot flicker between loads', () => {
      const twin = (id: string) =>
        child({
          id,
          name: `Chair ${id}`,
          slug: `chair-${id}`,
          optionLabel: id,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        });
      const card = { ...parent(), children: coll([twin('zeta'), twin('alpha')]) };

      const dto = mapProductToPublicDto(card as any);

      expect(dto.children.map((v) => v.id)).toEqual(['alpha', 'zeta']);
    });
  });
});
