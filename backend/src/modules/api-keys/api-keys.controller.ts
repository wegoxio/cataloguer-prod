import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { API_KEY_CAPABILITIES, ApiKeyCapability } from './api-key-capabilities';
import { ApiKeysService } from './api-keys.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntityManager } from '@mikro-orm/postgresql';
import { NotFoundException } from '@nestjs/common';
import { ApiKey } from './entities/api-key.entity';
import { assertStoreInOrganization, resolveScopedStoreTarget } from '../auth/tenancy/tenant-assertions';
import { TenantScope, scopeAllowsStore } from '../auth/tenancy/tenant-scope';

class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsUUID()
  storeId!: string;

  // Phase 6: what the key may do. Omitted = CATALOGUE_READ only (the secure
  // default). Explicit empty arrays and unknown literals are refused — a key
  // must never come back quietly holding different power than was asked for.
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_KEY_CAPABILITIES as readonly string[], { each: true })
  capabilities?: ApiKeyCapability[];
}

/**
 * P5-A2 family 3. API keys are STORE CREDENTIALS, so every operation names a
 * store explicitly and the resolved TenantScope decides whether that store is
 * reachable. Credentials are never listed globally: an unscoped platform owner
 * must enter a managed organization first (the service refuses without one).
 *
 *   ORGANIZATION_MANAGER . every store of its organization; narrowing binds
 *   ADMIN ................ its exact assigned store
 *   EDITOR / VIEWER ...... nothing
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN')
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly em: EntityManager,
  ) {}

  @Get()
  async findAll(@Req() req: any) {
    // PHASE 4 (C14): the company from the resolved scope is the boundary. A
    // branch actor still sees only its own branch's keys, because its scope
    // carries `storeId`; what changes is that a store-less actor is now scoped
    // to one company instead of reaching every company's keys.
    return {
      data: await this.apiKeysService.findAll(req.scope?.organizationId ?? null, req.scope?.storeId ?? undefined),
    };
  }

  @Post()
  async create(@Req() req: any, @Body() dto: CreateApiKeyDto) {
    // Response contains the full secret — the only time it is ever returned.
    //
    // The target comes from the REQUEST and is validated against the scope.
    // It used to be `req.user?.store?.id ?? dto.storeId`, which preferred the
    // actor's own binding over the store actually asked for, and ignored
    // narrowing entirely. The store-in-organization check stays as a second,
    // database-backed proof after the scope check.
    const storeId = resolveScopedStoreTarget(req.scope, dto.storeId);
    await assertStoreInOrganization(this.em, req.scope, storeId);
    return { data: await this.apiKeysService.create(dto.name, storeId, req.user?.id, dto.capabilities) };
  }

  @Patch(':id/revoke')
  async revoke(@Req() req: any, @Param('id') id: string) {
    // P1-07 (#162): a key is revocable only inside the actor's explicit
    // TenantScope. Foreign, out-of-branch and unknown ids all answer with the
    // SAME 404, so a UUID from another tenant is indistinguishable from a
    // nonexistent one.
    const scope: TenantScope | undefined = req.scope;
    const key = await this.em.findOne(ApiKey, { id }, { populate: ['store'] as never });
    if (!key) throw new NotFoundException('API key not found');
    const storeId = typeof (key as any).store === 'string' ? (key as any).store : (key as any).store?.id;
    if (storeId) {
      if (!scopeAllowsStore(scope, storeId)) throw new NotFoundException('API key not found');
      // Narrowing binds (P5-A2 family 3): an actor working inside one branch
      // may revoke that branch's credentials and no sibling's.
      const narrowedTo = scope?.storeId;
      if (typeof narrowedTo === 'string' && narrowedTo.length > 0 && narrowedTo !== storeId) {
        throw new NotFoundException('API key not found');
      }
    } else if (!scope || !scope.platform || scope.organizationId) {
      // Legacy storeless key: no tenant can own it, so no tenant may revoke
      // it. Recovery stays possible for the platform owner acting globally —
      // an explicit unscoped SUPER_ADMIN — never inferred from a missing store.
      throw new NotFoundException('API key not found');
    }
    return { data: await this.apiKeysService.revoke(id) };
  }
}
