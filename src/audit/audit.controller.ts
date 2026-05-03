import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { AdminApiGuard } from '../security/admin-api.guard';

@ApiTags('audit')
@UseGuards(AdminApiGuard)
@Controller('/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    const n = parseInt(limit ?? '50', 10);
    return this.audit.list().slice(0, isNaN(n) || n <= 0 ? 50 : n);
  }
}
