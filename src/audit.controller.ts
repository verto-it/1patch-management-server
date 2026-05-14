import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit/audit.service';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';

@ApiTags('audit')
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
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('audit:read')
  @Get()
  list() {
    return this.audit.list();
  }

  /**
   * Validates chain rules.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('audit:read')
  @Get('/verify-chain')
  verifyChain() {
    return this.audit.verifyChain();
  }
}
