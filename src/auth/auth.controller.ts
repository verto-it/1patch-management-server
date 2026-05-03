import { Body, Controller, Get, Headers, Logger, Post, Req, UseGuards } from '@nestjs/common';

import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AdminApiGuard } from '../security/admin-api.guard';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { AuthService } from './auth.service';

class SetupOwnerDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
}

class LoginDto extends SetupOwnerDto {
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

  constructor(private readonly auth: AuthService, private readonly audit: AuditService) {}

  @Post('/setup/owner')
  createOwner(@Body() dto: SetupOwnerDto) {
    this.logger.log(`Setup owner requested for ${dto.email}`);
    return this.auth.createOwner(dto.email, dto.password);
  }

  @Post('/auth/login')
  login(@Body() dto: LoginDto, @Headers('x-forwarded-for') ip?: string) {
    this.logger.log(`Login attempt for ${dto.email} from IP ${ip}`);
    return this.auth.login(dto.email, dto.password, ip, dto.country);
  }

  @Post('/auth/mfa/verify')
  verifyMfa(@Body() dto: MfaDto, @Headers('x-forwarded-for') ip?: string) {
    this.logger.log(`MFA verification attempt from IP ${ip}`);
    return this.auth.verifyMfa(dto.challengeToken, dto.code, ip);
  }

  // FIX #9: require a valid session JWT — derive userId from token, never from request body
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('/auth/mfa/enable')
  enableMfa(@Req() req: Request & { user: { sub: string } }) {
    this.logger.log(`MFA enable requested by user ${req.user.sub}`);
    return this.auth.enableMfa(req.user.sub);
  }

  // FIX #10: audit log requires admin authentication
  @ApiBearerAuth()
  @UseGuards(AdminApiGuard)
  @Get('/audit')
  auditLog() {
    return this.audit.list();
  }
}