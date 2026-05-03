import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';

@ApiTags('audit')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('audit:read')
@Controller('/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    const n = parseInt(limit ?? '50', 10);
    return this.audit.list().slice(0, isNaN(n) || n <= 0 ? 50 : n);
  }
}
