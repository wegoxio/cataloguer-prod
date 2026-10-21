import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PublicCatalogueController } from '../public-catalogue.controller';
import { API_KEY_CAPABILITY_METADATA, isApiKeyCapability } from '../../api-keys/api-key-capabilities';

/**
 * Phase 6 structural guarantee: EVERY route on the public controller declares
 * exactly one known capability. The guard fails closed on an unclassified
 * route, so a missing decorator would brick the endpoint for every key — this
 * test turns that runtime surprise into a red build the moment a route is
 * added without an authorization decision.
 *
 * The enumeration reads the same reflection metadata Nest routes by, so a
 * handler cannot be reachable over HTTP yet invisible here.
 */
describe('PublicCatalogueController capability classification', () => {
  const prototype = PublicCatalogueController.prototype;

  const routes = Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (prototype as any)[name];
      return {
        name,
        handler,
        path: Reflect.getMetadata(PATH_METADATA, handler),
        method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined,
        capability: Reflect.getMetadata(API_KEY_CAPABILITY_METADATA, handler),
      };
    })
    .filter((route) => route.path !== undefined && route.method !== undefined);

  it('sees the whole controller (the enumeration itself must not silently shrink)', () => {
    // If a route is ever removed or added this count moves, forcing whoever
    // touches the controller to re-read the classification below.
    expect(routes).toHaveLength(8);
  });

  it('every HTTP route declares exactly one KNOWN capability', () => {
    const unclassified = routes.filter((route) => route.capability === undefined);
    expect(unclassified.map((route) => route.name)).toEqual([]);
    const unknown = routes.filter((route) => !isApiKeyCapability(route.capability));
    expect(unknown.map((route) => `${route.name}=${route.capability}`)).toEqual([]);
  });

  it('classifies each route with the authority its side effect requires', () => {
    const byName = Object.fromEntries(
      routes.map((route) => [
        `${RequestMethod[route.method as RequestMethod]} /public/${route.path}`,
        route.capability,
      ]),
    );
    expect(byName).toEqual({
      'GET /public/categories': 'CATALOGUE_READ',
      'GET /public/groups': 'CATALOGUE_READ',
      'GET /public/products': 'CATALOGUE_READ',
      'GET /public/products/:slug': 'CATALOGUE_READ',
      'GET /public/categories/:slug/products': 'CATALOGUE_READ',
      'GET /public/site': 'CATALOGUE_READ',
      // The two catalogue-related mutating surfaces require narrower capabilities.
      'POST /public/orders': 'ORDER_CREATE',
      'POST /public/validate-discount': 'DISCOUNT_VALIDATE',
    });
  });
});
