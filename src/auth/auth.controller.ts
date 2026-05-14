import { Body, Controller, Get, Logger, Post, Req, UseGuards } from '@nestjs/common';

import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { AuthService } from './auth.service';

class SetupOwnerDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
}

class LoginDto extends SetupOwnerDto {
  /** Deprecated: ignored. Country is derived server-side from the request IP. */
  @IsOptional() @IsString() country?: string;
}

class MfaDto {
  @IsString() challengeToken!: string;
  @IsString() code!: string;
}

@ApiTags('auth')
@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  /**
   * Creates a AuthController instance with its required collaborators.
   *
   * @param auth auth supplied to the function.
   * @param audit audit supplied to the function.
   */
  constructor(private readonly auth: AuthService, private readonly audit: AuditService) {}

  /**
   * Creates a owner record.
   *
   * @param dto Request payload or data transfer object.
   * @returns The result produced by the operation.
   */
  @Post('/setup/owner')
  createOwner(@Body() dto: SetupOwnerDto) {
    this.logger.log(`Setup owner requested for ${dto.email}`);
    return this.auth.createOwner(dto.email, dto.password);
  }

  /**
   * Handles the login operation for AuthController.
   *
   * @param dto Request payload or data transfer object.
   * @param req Incoming HTTP request context.
   * @returns The result produced by the operation.
   */
  @Post('/auth/login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    const ip = requestIp(req);
    this.logger.log(`Login attempt for ${dto.email} from IP ${ip}`);
    return this.auth.login(dto.email, dto.password, ip);
  }

  /**
   * Validates mfa rules.
   *
   * @param dto Request payload or data transfer object.
   * @param req Incoming HTTP request context.
   * @returns The result produced by the operation.
   */
  @Post('/auth/mfa/verify')
  async verifyMfa(@Body() dto: MfaDto, @Req() req: Request) {
    const ip = requestIp(req);
    this.logger.log(`MFA verification attempt from IP ${ip}`);
    return this.auth.verifyMfa(dto.challengeToken, dto.code, ip);
  }

  /**
   * Revokes the current JWT session and records the logout event.
   *
   * @param req Incoming HTTP request with the authenticated user and bearer token.
   * @returns A simple success response when the session is revoked.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('/auth/logout')
  async logout(@Req() req: Request & { user: { sub: string } }) {
    const ip = requestIp(req);
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    this.logger.log(`Logout requested by user ${req.user.sub} from IP ${ip}`);
    await this.auth.logout(req.user.sub, token, ip);
    return { ok: true };
  }

  // FIX #9: require a valid session JWT — derive userId from token, never from request body
  /**
   * Handles the enable mfa operation for AuthController.
   *
   * @param req Incoming HTTP request context.
   * @returns The result produced by the operation.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('/auth/mfa/enable')
  enableMfa(@Req() req: Request & { user: { sub: string } }) {
    this.logger.log(`MFA enable requested by user ${req.user.sub}`);
    return this.auth.enableMfa(req.user.sub);
  }

  // FIX #10: audit log requires admin authentication
  /**
   * Handles the audit log operation for AuthController.
   * @returns The result produced by the operation.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('audit:read')
  @Get('/audit')
  auditLog() {
    return this.audit.list();
  }
}

/**
 * Handles the request ip operation.
 *
 * @param req Incoming HTTP request context.
 * @returns The result produced by the operation.
 */
function requestIp(req: Request): string | undefined {
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}
