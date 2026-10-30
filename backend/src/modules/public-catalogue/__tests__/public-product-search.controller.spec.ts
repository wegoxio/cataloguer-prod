import { PublicCatalogueController } from '../public-catalogue.controller';

describe('PublicCatalogueController product search', () => {
  it('returns the branch-resolved regular and sale prices in the compact result', async () => {
    const catalogue = {
      getProducts: jest.fn().mockResolvedValue({
        total: 1,
        items: [
          {
            id: 'product-1',
            name: 'Sofá Oslo',
            slug: 'sofa-oslo',
            description: 'Tres puestos',
            price: 1250,
            salePrice: 1100,
            primaryImage: { url: 'https://assets.example/sofa.webp', altText: 'Sofá Oslo' },
            images: [],
          },
        ],
      }),
    };
    const controller = new PublicCatalogueController(catalogue as any, {} as any);

    const result = await controller.searchProducts(
      { catalogueStoreId: 'store-1', catalogueOrganizationId: 'org-1' },
      { q: 'oslo', limit: '8', channel: 'mobiliario' },
    );

    expect(catalogue.getProducts).toHaveBeenCalledWith({
      storeId: 'store-1',
      organizationId: 'org-1',
      search: 'oslo',
      limit: 8,
      channel: 'mobiliario',
      locale: undefined,
      sortBy: 'name',
      sortDirection: 'asc',
    });
    expect(result).toEqual({
      total: 1,
      items: [
        {
          id: 'product-1',
          name: 'Sofá Oslo',
          slug: 'sofa-oslo',
          description: 'Tres puestos',
          price: 1250,
          salePrice: 1100,
          imageUrl: 'https://assets.example/sofa.webp',
          imageAlt: 'Sofá Oslo',
        },
      ],
    });
  });
});
