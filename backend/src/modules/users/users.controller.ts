import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { SetUserStoreDto } from './dto/set-user-store.dto';
import { ResetUserPasswordDto } from './dto/reset-user-password.dto';
import { PlatformUsersQueryDto } from './dto/platform-users-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * P5-A2 family 6 — team and staffing authority.
 *
 * ADR 014 gives ORGANIZATION_MANAGER users and store assignments inside its own
 * company, within the Phase 4 staffing constraints. Every route carries a
 * COMPLETE explicit role list (an absent list admits every authenticated role),
 * and every one hands the resolved scope to the service, which walls the target
 * by company — and by branch when the actor is narrowed.
 */
const STAFFING_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFFING_ROLES)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * REMOVE A TEAM MEMBER FROM THE COMPANY — reversible, never a delete.
   *
   * `@Roles` keeps everyone below staffing level out; the service applies the
   * matrix on the row it has locked, because a role read before the lock
   * describes a world another transaction may already have changed. A manager
   * may remove an ADMIN, EDITOR or VIEWER of their own company; only an
   * unscoped platform administrator may remove a manager; nobody removes a
   * platform administrator here, and nobody removes themselves.
   */

  @Get()
  async findAll(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('includeDeactivated') includeDeactivated?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDirection') sortDirection?: 'asc' | 'desc',
  ) {
    return this.usersService.findAll({
      // PHASE 4 (C13): boundary from the resolved scope, not the raw user.
      organizationScopeId: req.scope?.organizationId ?? undefined,
      storeScopeId: req.scope?.storeId ?? undefined,
      search,
      includeDeactivated: includeDeactivated === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      sortBy,
      sortDirection,
    });
  }

  /**
   * THE PLATFORM USER DIRECTORY (#275) — unscoped platform owner only.
   *
   * Declared BEFORE any parameterised GET so no `:id` route can shadow the
   * literal path, and narrowed with its own `@Roles` because the controller's
   * class-level list includes roles that must never see this. The role guard is
   * the outer wall; `listPlatformUsers` refuses on the RESOLVED SCOPE, so a
   * platform owner acting inside a company is refused too.
   *
   * `whitelist` + `forbidNonWhitelisted`: an unknown query parameter is a named
   * 400, never a silently ignored filter. A filter the caller believes is
   * applied and is not is how a directory shows the wrong population.
   */
  @Roles('SUPER_ADMIN')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Get('platform')
  async platformDirectory(@Req() req: any, @Query() query: PlatformUsersQueryDto) {
    const data = await this.usersService.listPlatformUsers(req.scope, query);
    return { data };
  }

  // Owner, a (store-bound) admin, or the company's ORGANIZATION_MANAGER may
  // bring people in — always at a role strictly below their own; invitees
  // set their own password. The manager's tenant wall lives in the service:
  // its authority derives from ITS committed organization, never the request.
  @Roles(...STAFFING_ROLES)
  @Post()
  async create(@Req() req: any, @Body() dto: CreateUserDto) {
    const user = await this.usersService.inviteUser(req.scope, req.user, {
      email: dto.email,
      roleName: dto.role,
      company: dto.company,
      firstName: dto.firstName,
      lastName: dto.lastName,
      storeId: dto.storeId,
    });
    return { data: user };
  }

  // D-6.2: store assignment is organization authority — the manager may move
  // people between its own branches, a narrowed actor only into the branch it
  // selected, and an UNSCOPED platform owner is refused: platform ownership
  // alone does not authorize a tenant staffing mutation.
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id/store')
  async setStore(@Req() req: any, @Param('id') id: string, @Body() dto: SetUserStoreDto) {
    const user = await this.usersService.setStore(req.scope, req.user, id, dto.storeId ?? null);
    return { data: user };
  }

  @Roles(...STAFFING_ROLES)
  @Post(':id/resend-invite')
  async resendInvite(@Req() req: any, @Param('id') id: string) {
    const user = await this.usersService.resendInvite(req.scope, req.user, id);
    return { data: user };
  }

  @Patch(':id/role')
  async updateRole(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateUserRoleDto) {
    const user = await this.usersService.updateRole(req.scope, req.user, id, dto.role);
    return { data: user };
  }

  @Patch(':id/deactivate')
  async deactivate(@Req() req: any, @Param('id') id: string) {
    const user = await this.usersService.deactivate(req.scope, req.user, id);
    return { data: user };
  }

  @Patch(':id/reactivate')
  async reactivate(@Req() req: any, @Param('id') id: string) {
    const user = await this.usersService.reactivate(req.scope, req.user, id);
    return { data: user };
  }

  @Patch(':id/password')
  async resetPassword(@Req() req: any, @Param('id') id: string, @Body() dto: ResetUserPasswordDto) {
    const user = await this.usersService.resetPassword(req.scope, req.user, id, dto.password);
    return { data: user };
  }
}
