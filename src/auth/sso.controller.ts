// AGPL-3.0-only
import {
  Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, MinLength,
} from 'class-validator';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { SsoProviderType } from '../types';
import { CreateProviderDto, SsoService } from './sso.service';

const PROVIDER_TYPES: SsoProviderType[] = ['microsoft', 'google', 'github', 'okta', 'oidc'];

class CreateProviderBody implements CreateProviderDto {
  @IsIn(PROVIDER_TYPES) type!: SsoProviderType;
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) clientId!: string;
  @IsString() @MinLength(1) clientSecret!: string;
  @IsOptional() @IsBoolean()  enabled?: boolean;
  @IsOptional() @IsString()   tenantId?: string;
  @IsOptional() @IsString()   domain?: string;
  @IsOptional() @IsString()   discoveryUrl?: string;
  @IsOptional() @IsArray()    allowedDomains?: string[];
  @IsOptional() @IsString()   defaultRole?: string;
  @IsOptional() @IsBoolean()  autoProvision?: boolean;
}

class UpdateProviderBody {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() @MinLength(1) clientId?: string;
  @IsOptional() @IsString() @MinLength(1) clientSecret?: string;
  @IsOptional() @IsBoolean()  enabled?: boolean;
  @IsOptional() @IsString()   tenantId?: string;
  @IsOptional() @IsString()   domain?: string;
  @IsOptional() @IsString()   discoveryUrl?: string;
  @IsOptional() @IsArray()    allowedDomains?: string[];
  @IsOptional() @IsString()   defaultRole?: string;
  @IsOptional() @IsBoolean()  autoProvision?: boolean;
}

class CompleteHandoffBody {
  @IsString() @MinLength(1) handoffToken!: string;
}

@ApiTags('sso')
@Controller()
export class SsoController {
  private readonly logger = new Logger(SsoController.name);

  constructor(private readonly sso: SsoService) {}

  // ── Public: list enabled providers for login UI ────────────────────────────

  @Get('/sso/providers')
  listPublic() {
    return this.sso.listProvidersPublic();
  }

  // ── Admin: provider management (auth:manage required) ─────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('auth:manage')
  @Get('/sso/providers/all')
  listAdmin() {
    return this.sso.listProvidersAdmin();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('auth:manage')
  @Post('/sso/providers')
  create(@Body() dto: CreateProviderBody) {
    return this.sso.createProvider(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('auth:manage')
  @Patch('/sso/providers/:id')
  update(@Param('id') id: string, @Body() dto: UpdateProviderBody) {
    return this.sso.updateProvider(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('auth:manage')
  @Delete('/sso/providers/:id')
  async remove(@Param('id') id: string) {
    await this.sso.deleteProvider(id);
    return { ok: true };
  }

  // ── SSO Flow ───────────────────────────────────────────────────────────────

  @Get('/auth/sso/:providerId/initiate')
  async initiate(@Param('providerId') providerId: string, @Req() req: Request) {
    const baseUrl = ssoBaseUrl(req);
    this.logger.log(`SSO initiate: provider=${providerId} baseUrl=${baseUrl}`);
    return this.sso.initiateFlow(providerId, baseUrl);
  }

  @Get('/auth/sso/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      this.logger.warn(`SSO callback error: ${error} — ${errorDescription}`);
      return res.redirect(`/ui?sso_error=${encodeURIComponent(error)}`);
    }
    try {
      const ip = requestIp(req);
      const handoffToken = await this.sso.handleCallback(code, state, ip);
      return res.redirect(`/ui?sso_handoff=${handoffToken}`);
    } catch (err) {
      const msg = (err as Error).message ?? 'Authentication failed';
      this.logger.warn(`SSO callback failed: ${msg}`);
      return res.redirect(`/ui?sso_error=${encodeURIComponent(msg)}`);
    }
  }

  @Post('/auth/sso/complete')
  complete(@Body() dto: CompleteHandoffBody) {
    return this.sso.completeHandoff(dto.handoffToken);
  }
}

function requestIp(req: Request): string | undefined {
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}

function ssoBaseUrl(req: Request): string {
  // Always prefer PUBLIC_URL to prevent Host-header injection
  const pub = process.env.PUBLIC_URL;
  if (pub) return pub.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() ?? req.protocol;
  const host  = (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim() ?? req.hostname;
  return `${proto}://${host}`;
}
