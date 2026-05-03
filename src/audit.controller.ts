// AGPL-3.0-only
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit/audit.service';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';

@ApiTags('audit')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('audit:read')
@Controller('/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    const max = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.audit.list().slice(0, max);
  }
}
