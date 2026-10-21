import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { Organization } from '../../../organizations/entities/organization.entity';
import { Product } from '../../entities/product.entity';
import { ProductImage } from '../../../product-images/entities/product-image.entity';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { realStock } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * #177 — the hasImages filter and the variant-suggestion candidate query must
 * be BOUNDED: the database answers membership, and no image or child rows are
 * materialized into the process just to compute a filter.
 *
 * The old shape loaded EVERY active ProductImage of the organization and
 * pushed the distinct product ids back as one $in list. These tests pin both
 * halves of the fix: the answer is unchanged, and the identity map stays free
 * of the rows the old implementation dragged in.
 */
d('#177 · bounded filter queries (real PostgreSQL)', () => {
  // Booting a disposable database applies the whole migration chain, which
  // outruns jest's five-second default whenever the full battery is
  // contending for PostgreSQL. Every other pg suite says so; this one did
  // not, and passed alone while failing in company.
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let orgA: string;
  let withImage: string;
  let withArchivedImageOnly: string;
  let withoutImage: string;
  let offPageWithImage: string;

  const service = (scoped: EntityManager) =>
    new ProductsService(
      scoped.getRepository(Product) as any,
      { find: async () => [], findOne: async () => null } as any,
      { findById: async () => undefined } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { learnedWordsFor: async () => [], dismissedSignaturesFor: async () => [] } as any,
      new PublicationGuardService(),
      {} as any,
      realStock(scoped as any),
    );

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork();
    const a = em.create(Organization, { name: 'Alpha', slug: 'alpha-177' } as any);
    const b = em.create(Organization, { name: 'Beta', slug: 'beta-177' } as any);
    em.persist([a, b]);
    await em.flush();
    orgA = a.id;

    const product = (slug: string, org: Organization) =>
      em.create(Product, {
        name: slug,
        slug,
        price: 10,
        trackInventory: false,
        stockQuantity: 0,
        status: ProductStatus.PUBLISHED,
        organization: org,
      } as any);
    const p1 = product('p177-with-image', a);
    const p2 = product('p177-archived-image', a);
    const p3 = product('p177-no-image', a);
    const p4 = product('p177-offpage-image', a);
    const pB = product('p177-foreign', b);
    em.persist([p1, p2, p3, p4, pB]);
    await em.flush();
    withImage = p1.id;
    withArchivedImageOnly = p2.id;
    withoutImage = p3.id;
    offPageWithImage = p4.id;

    em.persist([
      em.create(ProductImage, { product: p1, url: 'https://x/1.jpg', isPrimary: true, sortOrder: 0 } as any),
      em.create(ProductImage, {
        product: p2,
        url: 'https://x/2.jpg',
        isPrimary: true,
        sortOrder: 0,
        archivedAt: new Date(),
      } as any),
      em.create(ProductImage, { product: p4, url: 'https://x/4.jpg', isPrimary: true, sortOrder: 0 } as any),
      // the foreign tenant's image must never leak into A's answer
      em.create(ProductImage, { product: pB, url: 'https://x/3.jpg', isPrimary: true, sortOrder: 0 } as any),
    ]);
    await em.flush();
    em.clear();
  });

  afterAll(async () => {
    await pg.close();
  });

  it('hasImages=true answers from the database and materializes only the page, never the organization', async () => {
    const fresh = pg.orm.em.fork();
    // `search` narrows the page to ONE of the two image-carrying products. The
    // pre-#177 implementation would still have loaded EVERY active image of
    // the organization to compute the filter; the bounded query touches only
    // the returned page's own populated gallery.
    const result = await service(fresh).findAll({
      organizationId: orgA,
      hasImages: true,
      search: 'p177-with-image',
      limit: 50,
    });
    const ids = result.items.map((p: any) => p.id);
    expect(ids).toEqual([withImage]);
    const identityMap = fresh.getUnitOfWork().getIdentityMap();
    const imageOwners = [...identityMap]
      .filter((entity) => entity instanceof ProductImage)
      .map((img: any) => (typeof img.product === 'string' ? img.product : img.product.id));
    // page-owned images are legitimate; anything beyond the page is the leak
    expect(imageOwners.every((owner) => ids.includes(owner))).toBe(true);
    expect(imageOwners).not.toContain(offPageWithImage);
  });

  it('hasImages=true without narrowing returns every live-image product of the tenant', async () => {
    const fresh = pg.orm.em.fork();
    const result = await service(fresh).findAll({ organizationId: orgA, hasImages: true, limit: 50 });
    const ids = result.items.map((p: any) => p.id).sort();
    expect(ids).toEqual([withImage, offPageWithImage].sort());
  });

  it('hasImages=false returns the archived-only and imageless products', async () => {
    const fresh = pg.orm.em.fork();
    const result = await service(fresh).findAll({ organizationId: orgA, hasImages: false, limit: 50 });
    const ids = result.items.map((p: any) => p.id).sort();
    expect(ids).toEqual([withArchivedImageOnly, withoutImage].sort());
    expect(ids).not.toContain(offPageWithImage);
  });

  it('variant suggestions exclude family members in the WHERE, not in memory', async () => {
    const fresh = pg.orm.em.fork();
    // file two of the products into a family: they must vanish from candidates
    const card = fresh.create(Product, {
      name: 'card 177',
      slug: 'p177-card',
      price: 10,
      trackInventory: false,
      stockQuantity: 0,
      status: ProductStatus.PUBLISHED,
      organization: orgA,
    } as any);
    fresh.persist(card);
    await fresh.flush();
    const child = await fresh.findOneOrFail(Product, { id: withImage });
    (child as any).parent = card;
    await fresh.flush();
    fresh.clear();

    const scope = pg.orm.em.fork();
    const suggestions = await service(scope).findFamilySuggestions(orgA);
    const memberIds = suggestions.flatMap((group: any) => group.members.map((m: any) => m.id));
    // neither the card (has children) nor the child (has a parent) may appear
    expect(memberIds).not.toContain(card.id);
    expect(memberIds).not.toContain(withImage);
    // and the candidate query populated no child collections into the map
    const identityMap = scope.getUnitOfWork().getIdentityMap();
    const loaded = [...identityMap].filter((entity) => entity instanceof Product).map((p: any) => p.id);
    expect(loaded).not.toContain(withImage);
  });
});
