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
  /**
   * Creates a AuditController instance with its required collaborators.
   *
   * @param audit audit supplied to the function.
   */
  constructor(private readonly audit: AuditService) {}

  /**
   * Lists list records for the caller.
   *
   * @param limit Maximum number of records to return.
   * @returns The result produced by the operation.
   */
  @Get()
  list(@Query('limit') limit?: string) {
    const n = parseInt(limit ?? '50', 10);
    return this.audit.list().slice(0, isNaN(n) || n <= 0 ? 50 : n);
  }
}
