import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicCatalogueService } from './public-catalogue.service';
import { PublicProductDto } from './dto/public-catalogue.dto';
import { CreatePublicOrderDto, ValidateDiscountDto } from './dto/public-order.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RequireApiCapability } from '../api-keys/api-key-capabilities';
import { SalesService } from '../sales/sales.service';
import {
  parsePublicCategoriesQuery,
  parsePublicLocaleQuery,
  parsePublicProductDetailQuery,
  parsePublicProductsQuery,
  parsePublicSlug,
} from './query/public-query';

// Catalogue API: requires an API key (X-Api-Key) — see ADR 005. Every route
// declares the ONE capability it requires; the guard refuses a route without
// one, so adding an endpoint here forces the authorization decision.
@UseGuards(ApiKeyGuard)
@Controller('public')
export class PublicCatalogueController {
  constructor(
    private readonly publicCatalogueService: PublicCatalogueService,
    private readonly salesService: SalesService,
  ) {}

  // Every query string is parsed by the fail-closed layer in `public-query.ts`
  // BEFORE any database query is built: unknown parameters, repeated scalars,
  // malformed values and unwhitelisted sort columns are all machine-readable
  // 400s instead of silent reinterpretation (Phase 6).
  @RequireApiCapability('CATALOGUE_READ')
  @Get('categories')
  async getCategories(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.publicCatalogueService.getCategories({
      storeId: req.catalogueStoreId ?? undefined,
      organizationId: req.catalogueOrganizationId ?? undefined,
      ...parsePublicCategoriesQuery(query),
    });
  }

  @RequireApiCapability('CATALOGUE_READ')
  @Get('groups')
  async getGroups(@Req() req: any, @Query() query: Record<string, unknown>) {
    const allowed = new Set(['channel', 'purpose', 'placement']);
    for (const key of Object.keys(query)) if (!allowed.has(key)) throw new BadRequestException(`Unsupported query parameter: ${key}`);
    const channel = typeof query.channel === 'string' ? query.channel : undefined;
    if (query.channel !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(query.channel))) throw new BadRequestException('Invalid channel');
    if (query.purpose !== undefined && query.purpose !== 'NAVIGATION' && query.purpose !== 'FILTER') throw new BadRequestException('Invalid purpose');
    if (query.placement !== undefined && !['HOME', 'CATALOG', 'NAVIGATION'].includes(String(query.placement))) throw new BadRequestException('Invalid placement');
    const purpose = query.purpose as 'NAVIGATION' | 'FILTER' | undefined;
    const placement = query.placement as string | undefined;
    return this.publicCatalogueService.getGroups({
      storeId: req.catalogueStoreId ?? undefined,
      organizationId: req.catalogueOrganizationId ?? undefined,
      channel,
      purpose,
      placement,
    });
  }

  @RequireApiCapability('CATALOGUE_READ')
  @Get('products')
  async getProducts(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.publicCatalogueService.getProducts({
      storeId: req.catalogueStoreId ?? undefined,
      organizationId: req.catalogueOrganizationId ?? undefined,
      ...parsePublicProductsQuery(query),
    });
  }

  // `?locale=` is EXPLICIT and OPTIONAL (P5-W2). Omitting it returns exactly
  // what this endpoint has always returned, which is what makes localization
  // additive for every consumer already integrated. Accept-Language
  // negotiation and richer discovery remain Phase 6.
  @RequireApiCapability('CATALOGUE_READ')
  @Get('products/:slug')
  async getProductBySlug(
    @Req() req: any,
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{ data: PublicProductDto }> {
    const detailQuery = parsePublicProductDetailQuery(query);
    const product = await this.publicCatalogueService.getProductBySlug(
      parsePublicSlug(slug, 'product slug'),
      req.catalogueStoreId ?? undefined,
      req.catalogueOrganizationId ?? undefined,
      detailQuery.locale,
      detailQuery.channel,
    );
    return { data: product };
  }

  @RequireApiCapability('CATALOGUE_READ')
  @Get('categories/:slug/products')
  async getProductsByCategorySlug(
    @Req() req: any,
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{ data: PublicProductDto[] }> {
    const products = await this.publicCatalogueService.getProductsByCategorySlug(
      parsePublicSlug(slug, 'category slug'),
      req.catalogueStoreId ?? undefined,
      req.catalogueOrganizationId ?? undefined,
      parsePublicLocaleQuery(query).locale,
    );
    return { data: products };
  }

  // Website checkout: creates a Sales order for the key's store.
  // Requires a store API key (admin JWTs get a 400 without a store scope).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireApiCapability('ORDER_CREATE')
  @Post('orders')
  async createOrder(@Req() req: any, @Body() body: CreatePublicOrderDto) {
    const storeId = req.catalogueStoreId;
    if (!storeId) {
      // Client mistake, not a server fault: a clean 401 instead of a 500
      throw new UnauthorizedException('Orders require a store API key');
    }
    // Double-submit safety: header or body key makes the request retryable
    const idempotencyKey = (req.headers['idempotency-key'] as string) || body.idempotencyKey;
    const order = await this.salesService.createFromWebsite(
      storeId,
      body.items,
      body.customerName,
      body.customerPhone,
      idempotencyKey,
      body.discountCode,
    );
    return { data: order };
  }

  // Checkout preview: is this code valid for this cart, and how much off?
  @RequireApiCapability('DISCOUNT_VALIDATE')
  @Post('validate-discount')
  async validateDiscount(@Req() req: any, @Body() body: ValidateDiscountDto) {
    const storeId = req.catalogueStoreId;
    if (!storeId) {
      throw new UnauthorizedException('A store API key is required');
    }
    return { data: await this.salesService.previewDiscount(storeId, body.code, body.items || []) };
  }

  // Site identity for the key's store: name, contact and SEO meta —
  // websites apply these to <title>/<meta> so the panel controls SEO
  @RequireApiCapability('CATALOGUE_READ')
  @Get('site')
  async getSite(@Req() req: any) {
    return { data: await this.publicCatalogueService.getSite(req.catalogueStoreId ?? undefined) };
  }

}
