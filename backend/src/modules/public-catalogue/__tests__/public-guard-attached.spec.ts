import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PublicCatalogueController } from '../public-catalogue.controller';
import { ApiKeyGuard } from '../../api-keys/api-key.guard';

/**
 * The guard is ON the controller.
 *
 * Every capability test in this module proves what the guard does when asked.
 * None of them proved anyone asks it: deleting `@UseGuards(ApiKeyGuard)` from
 * the class would make the entire catalogue anonymous while every existing
 * test stayed green, because they all construct the guard by hand.
 */
describe('the public catalogue is guarded at the class', () => {
  it('declares ApiKeyGuard on PublicCatalogueController', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, PublicCatalogueController) ?? [];
    expect(guards).toContain(ApiKeyGuard);
  });
});
