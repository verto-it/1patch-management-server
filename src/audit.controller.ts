import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit/audit.service';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';

@ApiTags('audit')
@Controller('/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('audit:read')
  @Get()
  list() {
    return this.audit.list();
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('audit:read')
  @Get('/verify-chain')
  verifyChain() {
    return this.audit.verifyChain();
  }
}
