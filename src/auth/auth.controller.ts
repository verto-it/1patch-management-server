import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';

class SetupOwnerDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  password!: string;
}

class LoginDto extends SetupOwnerDto {
  @IsOptional()
  @IsString()
  country?: string;
}

class MfaDto {
  @IsString()
  challengeToken!: string;

  @IsString()
  code!: string;
}

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly audit: AuditService) {}

  @Post('/setup/owner')
  createOwner(@Body() dto: SetupOwnerDto) {
    return this.auth.createOwner(dto.email, dto.password);
  }

  @Post('/auth/login')
  login(@Body() dto: LoginDto, @Headers('x-forwarded-for') ip?: string) {
    return this.auth.login(dto.email, dto.password, ip, dto.country);
  }

  @Post('/auth/mfa/verify')
  verifyMfa(@Body() dto: MfaDto, @Headers('x-forwarded-for') ip?: string) {
    return this.auth.verifyMfa(dto.challengeToken, dto.code, ip);
  }

  @Post('/auth/mfa/enable')
  enableMfa(@Body('userId') userId: string) {
    return this.auth.enableMfa(userId);
  }

  @Get('/audit')
  auditLog() {
    return this.audit.list();
  }
}
