import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TranslationsService } from './translations.service';
import { UpsertTranslationDto } from './dto/translation.dto';

/**
 * Catalogue translations (P5-W2).
 *
 * WRITE authority follows ADR 014: catalogue copy is organization-owned, so
 * the platform owner working inside a company and the ORGANIZATION_MANAGER of
 * that company may change it. ADMIN appears in no write list here for the same
 * reason it does not archive a product — a branch admin rewriting shared
 * catalogue copy changes what every sibling branch publishes. The service
 * repeats the check with `hasOrganizationWideAuthority`, so a narrowed manager
 * is refused there too: the role list is not the whole gate.
 *
 * READ is open to the catalogue roles, bounded to items the caller's branch
 * carries.
 *
 * NO PHASE 8 UX IS IMPLIED. This is the contract's write path, the same way
 * product fields, documents and relations landed their backends before their
 * panels existed.
 */
const TRANSLATION_READ_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR'] as const;
const TRANSLATION_WRITE_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products/:productId/translations')
export class ProductTranslationsController {
  constructor(private readonly service: TranslationsService) {}

  @Roles(...TRANSLATION_READ_ROLES)
  @Get()
  async list(@Req() req: any, @Param('productId') productId: string) {
    return { data: await this.service.list(req.scope, 'product', productId) };
  }

  @Roles(...TRANSLATION_WRITE_ROLES)
  @Put(':locale')
  async upsert(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('locale') locale: string,
    @Body() dto: UpsertTranslationDto,
  ) {
    return { data: await this.service.upsert(req.scope, 'product', productId, locale, dto ?? {}) };
  }

  @Roles(...TRANSLATION_WRITE_ROLES)
  @Delete(':locale')
  async remove(@Req() req: any, @Param('productId') productId: string, @Param('locale') locale: string) {
    return { data: await this.service.remove(req.scope, 'product', productId, locale) };
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('categories/:categoryId/translations')
export class CategoryTranslationsController {
  constructor(private readonly service: TranslationsService) {}

  @Roles(...TRANSLATION_READ_ROLES)
  @Get()
  async list(@Req() req: any, @Param('categoryId') categoryId: string) {
    return { data: await this.service.list(req.scope, 'category', categoryId) };
  }

  @Roles(...TRANSLATION_WRITE_ROLES)
  @Put(':locale')
  async upsert(
    @Req() req: any,
    @Param('categoryId') categoryId: string,
    @Param('locale') locale: string,
    @Body() dto: UpsertTranslationDto,
  ) {
    return { data: await this.service.upsert(req.scope, 'category', categoryId, locale, dto ?? {}) };
  }

  @Roles(...TRANSLATION_WRITE_ROLES)
  @Delete(':locale')
  async remove(@Req() req: any, @Param('categoryId') categoryId: string, @Param('locale') locale: string) {
    return { data: await this.service.remove(req.scope, 'category', categoryId, locale) };
  }
}
