import {
  Controller,
  Patch,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDevDto } from './dto/register-dev.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { ConfirmEmailChangeDto, RequestEmailChangeDto } from './dto/email-change.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  // Single shape for the session user in login/refresh/me responses.
  // Name and company let the UI greet the person properly.
  private toSessionUser(user: any) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      company: user.company ?? null,
      role: user.role.name,
      mfaEnabled: Boolean(user.mfaEnabledAt),
      store: user.store ? { id: user.store.id, name: user.store.name } : null,
    };
  }

  /**
   * Deployed environments serve the frontend and the API from different
   * domains (application host versus API host), so the cookie must be
   * SameSite=None + Secure or browsers silently drop it on refresh calls
   * and every session dies when the 15-minute access token expires.
   * Local development runs on plain http where Secure cookies don't work.
   */
  private get cookieFlags(): { secure: boolean; sameSite: 'none' | 'lax' } {
    const env = this.configService.get<string>('NODE_ENV') || 'development';
    const deployed = env === 'production' || env === 'staging' || env === 'beta';
    return deployed ? { secure: true, sameSite: 'none' } : { secure: false, sameSite: 'lax' };
  }

  private setRefreshTokenCookie(res: Response, token: string) {
    res.cookie('refreshToken', token, {
      httpOnly: true,
      ...this.cookieFlags,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/v1/auth', // only send to auth endpoints
    });
  }

  // Strict limit: mitigates password brute force (manual 5.4)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(@Req() req: Request, @Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.validateUser(loginDto.email, loginDto.password);

    // MFA-enabled accounts get a short challenge instead of tokens
    if (user.mfaEnabledAt) {
      const challengeToken = await this.authService.issueMfaChallenge(user);
      return { data: { mfaRequired: true, challengeToken } };
    }

    return this.completeLogin(req, res, user);
  }

  private async completeLogin(req: Request, res: Response, user: any) {
    const accessToken = await this.authService.generateAccessToken(user);
    const { token: refreshToken } = await this.authService.issueRefreshToken(user, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    this.setRefreshTokenCookie(res, refreshToken);

    return {
      data: {
        accessToken,
        user: this.toSessionUser(user),
      },
    };
  }

  // Second sign-in step for MFA accounts: challenge + authenticator code
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  async verifyMfaLogin(
    @Req() req: Request,
    @Body() body: { challengeToken: string; code: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.challengeToken || !body?.code) {
      throw new BadRequestException('Code is required');
    }
    const user = await this.authService.verifyMfaChallenge(body.challengeToken, body.code);
    return this.completeLogin(req, res, user);
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      await this.authService.revokeRefreshToken(refreshToken);
    }
    res.clearCookie('refreshToken', {
      httpOnly: true,
      ...this.cookieFlags,
      path: '/api/v1/auth',
    });
    return { data: { message: 'Logged out successfully' } };
  }

  // Refresh happens automatically from the frontend; allow a moderate
  // rate but block token grinding.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    const validated = await this.authService.validateRefreshToken(refreshToken);
    const user = validated.stored.user;

    /**
     * ROTATE FIRST, THEN MINT (#291 correction round 2).
     *
     * Rotation re-reads the account's generation under its row lock and refuses
     * if it has moved since validation, so nothing is issued at all when a
     * removal has landed in between. Minting the access token first would have
     * built a response the rotation then refused — and, in the ordering where
     * the rotation succeeds, would have stamped it with a number read before
     * the lock rather than the one confirmed under it.
     */
    const rotated = await this.authService.rotateRefreshToken(validated, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const newAccessToken = await this.authService.generateAccessToken(user, rotated.generation);
    const newRefreshToken = rotated.token;

    this.setRefreshTokenCookie(res, newRefreshToken);

    return {
      data: {
        accessToken: newAccessToken,
        user: this.toSessionUser(user),
      },
    };
  }

  // Anti-enumeration: always the same generic answer, hard rate limit
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.requestPasswordReset(dto.email);
    return { data: { message: 'If that email exists, a reset link is on its way.' } };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPasswordWithToken(dto.token, dto.newPassword, dto.acceptTerms);
    return { data: { message: 'Password updated. You can sign in now.' } };
  }

  // Same strict limit as login: this endpoint verifies passwords too
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(req.user.id, dto.currentPassword, dto.newPassword);
    return { data: { message: 'Password changed. All sessions have been signed out.' } };
  }

  // Strict limit: verifies passwords, like login
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('request-email-change')
  async requestEmailChange(@Req() req: any, @Body() dto: RequestEmailChangeDto) {
    await this.authService.requestEmailChange(req.user.id, dto.newEmail, dto.currentPassword);
    return { data: { message: 'Confirmation link sent to the new address.' } };
  }

  // Public: the user clicks this from the email sent to the new address
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('confirm-email-change')
  async confirmEmailChange(@Body() dto: ConfirmEmailChangeDto) {
    const email = await this.authService.confirmEmailChange(dto.token);
    return { data: { email } };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  async updateProfile(@Req() req: any, @Body() body: { firstName?: string; lastName?: string }) {
    const user = await this.usersService.updateProfile(req.user.id, body.firstName, body.lastName);
    return { data: user };
  }

  // ---- Two-factor enrollment (Settings → Security) ----
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('mfa/setup')
  async setupMfa(@Req() req: any, @Body() body: { currentPassword: string }) {
    return { data: await this.authService.setupMfa(req.user.id, body?.currentPassword ?? '') };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('mfa/enable')
  async enableMfa(@Req() req: any, @Body() body: { code: string }) {
    const recoveryCodes = await this.authService.enableMfa(req.user.id, body?.code ?? '');
    return { data: { recoveryCodes } };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('mfa/disable')
  async disableMfa(@Req() req: any, @Body() body: { currentPassword: string; code: string }) {
    await this.authService.disableMfa(req.user.id, body?.currentPassword ?? '', body?.code ?? '');
    return { data: { message: 'Two-factor authentication disabled' } };
  }

  // Sessions UI: where this account is signed in, with per-device revoke
  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  async sessions(@Req() req: any) {
    return { data: await this.authService.listSessions(req.user.id) };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  async revokeSession(@Req() req: any, @Param('id') id: string) {
    await this.authService.revokeSession(req.user.id, id);
    return { data: { message: 'Session closed' } };
  }

  @UseGuards(JwtAuthGuard)
  @Post('sessions/revoke-all')
  async revokeAllSessions(@Req() req: any) {
    await this.authService.revokeAllForUser(req.user.id);
    return { data: { message: 'All sessions closed' } };
  }

  /**
   * The panel's authority source (P5-A2 family 2 companion).
   *
   * Only what the frontend capability helpers read, whitelisted field by field
   * — NEVER a spread of `req.scope`, so a future TenantScope field cannot leak
   * here by accident. No tokens, MFA state, credentials, names or billing data.
   *
   * Returned only by `me()`, which is guarded and therefore has a resolved
   * scope. `login`, `mfa/verify` and `refresh` deliberately keep their existing
   * payloads: they are unguarded, and re-deriving authority there would create
   * a second source of truth.
   */
  private toSessionScope(scope: any) {
    if (!scope) return null;
    return {
      platform: scope.platform === true,
      role: typeof scope.role === 'string' ? scope.role : '',
      organizationId: scope.organizationId ?? null,
      storeId: scope.storeId ?? null,
      allowedStoreIds: Array.isArray(scope.allowedStoreIds) ? [...scope.allowedStoreIds] : [],
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: any) {
    return { data: { ...this.toSessionUser(req.user), scope: this.toSessionScope(req.scope) } };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register-dev')
  async registerDev(@Body() dto: RegisterDevDto) {
    // Fail closed (P1-06): a "just for development" endpoint must be OFF unless
    // explicitly and locally turned on — not merely "not production". It needs
    // NODE_ENV=development AND ALLOW_DEV_REGISTER=true; staging, preview and any
    // misconfigured deploy fall through to a 404, hiding that it ever existed.
    const isLocalDev = this.configService.get<string>('NODE_ENV') === 'development';
    const explicitlyAllowed = this.configService.get<string>('ALLOW_DEV_REGISTER') === 'true';
    if (!isLocalDev || !explicitlyAllowed) {
      throw new NotFoundException();
    }

    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new BadRequestException('Email already registered');
    }

    // Role is whitelisted by the DTO (never SUPER_ADMIN); default to EDITOR.
    // The user is created INSIDE the given store (#156): the service derives
    // the organization from the store and validates the binding, so this
    // endpoint can no longer mint an unscoped tenant user.
    const passwordHash = await argon2.hash(dto.password);
    const user = await this.usersService.createUserInStore({
      email: dto.email,
      passwordHash,
      roleName: dto.role ?? 'EDITOR',
      storeId: dto.storeId,
    });

    return {
      data: {
        id: user.id,
        email: user.email,
        role: user.role.name,
      },
    };
  }
}
