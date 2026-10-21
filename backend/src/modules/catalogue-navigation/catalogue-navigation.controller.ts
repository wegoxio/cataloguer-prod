import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { resolveScopedStoreTarget } from '../auth/tenancy/tenant-assertions';
import { CatalogueNavigationService } from './catalogue-navigation.service';
import { CreateChannelDto, CreateGroupDto, SetGroupCategoriesDto, UpdateChannelDto, UpdateGroupDto, UpsertCategoryPublicationDto } from './dto/catalogue-navigation.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN')
@Controller('stores/:storeId/catalogue-navigation')
export class CatalogueNavigationController {
  constructor(private readonly service: CatalogueNavigationService) {}
  private scope(req: any, storeId: string) {
    return { organizationId: req.scope?.organizationId as string, storeId: resolveScopedStoreTarget(req.scope, storeId) };
  }
  @Get() snapshot(@Req() req: any, @Param('storeId') requested: string) { const s = this.scope(req, requested); return this.service.snapshot(s.organizationId, s.storeId).then((data) => ({ data })); }
  @Post('channels') createChannel(@Req() req: any, @Param('storeId') requested: string, @Body() dto: CreateChannelDto) { const s = this.scope(req, requested); return this.service.createChannel(s.organizationId, s.storeId, dto).then((data) => ({ data })); }
  @Patch('channels/:channelId') updateChannel(@Req() req: any, @Param('storeId') requested: string, @Param('channelId') id: string, @Body() dto: UpdateChannelDto) { const s = this.scope(req, requested); return this.service.updateChannel(s.organizationId, s.storeId, id, dto).then((data) => ({ data })); }
  @Post('channels/:channelId/groups') createGroup(@Req() req: any, @Param('storeId') requested: string, @Param('channelId') channelId: string, @Body() dto: CreateGroupDto) { const s = this.scope(req, requested); return this.service.createGroup(s.organizationId, s.storeId, channelId, dto).then((data) => ({ data })); }
  @Patch('groups/:groupId') updateGroup(@Req() req: any, @Param('storeId') requested: string, @Param('groupId') id: string, @Body() dto: UpdateGroupDto) { const s = this.scope(req, requested); return this.service.updateGroup(s.organizationId, s.storeId, id, dto).then((data) => ({ data })); }
  @Put('groups/:groupId/categories') setGroupCategories(@Req() req: any, @Param('storeId') requested: string, @Param('groupId') id: string, @Body() dto: SetGroupCategoriesDto) { const s = this.scope(req, requested); return this.service.setGroupCategories(s.organizationId, s.storeId, id, dto).then((data) => ({ data })); }
  @Put('channels/:channelId/categories/:categoryId') upsertPublication(@Req() req: any, @Param('storeId') requested: string, @Param('channelId') channelId: string, @Param('categoryId') categoryId: string, @Body() dto: UpsertCategoryPublicationDto) { const s = this.scope(req, requested); return this.service.upsertPublication(s.organizationId, s.storeId, channelId, categoryId, dto).then((data) => ({ data })); }
}
