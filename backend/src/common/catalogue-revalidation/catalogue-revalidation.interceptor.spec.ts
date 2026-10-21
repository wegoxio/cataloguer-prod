import { changesPublicCatalogue } from './catalogue-revalidation.interceptor';

describe('catalogue cache revalidation boundary', () => {
  it.each([
    ['/api/v1/products/abc', 'PATCH'],
    ['/api/v1/products/abc/images/img/make-primary', 'PATCH'],
    ['/api/v1/categories/abc/archive', 'PATCH'],
    ['/api/v1/stores/store/catalogue-navigation/channels', 'POST'],
    ['/api/v1/inventory/recount', 'POST'],
    ['/api/v1/bulk/products/status', 'POST'],
    ['/api/v1/public/orders', 'POST'],
  ])('revalidates %s %s', (url, method) => expect(changesPublicCatalogue(method, url)).toBe(true));

  it.each([
    ['/api/v1/products', 'GET'],
    ['/api/v1/auth/login', 'POST'],
    ['/api/v1/users/me', 'PATCH'],
  ])('ignores %s %s', (url, method) => expect(changesPublicCatalogue(method, url)).toBe(false));
});
