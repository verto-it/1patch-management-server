import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { User } from '../types';
import { SecurityPostureFixAction } from './security-posture.types';
import { SecurityPostureService } from './security-posture.service';

@ApiTags('security-posture')
@Controller('/security/posture')
@UseGuards(JwtAuthGuard, RbacGuard)
export class SecurityPostureController {
  /**
   * Creates a SecurityPostureController instance with its required collaborators.
   *
   * @param posture posture supplied to the function.
   * @param audit audit supplied to the function.
   */
  constructor(
    private readonly posture: SecurityPostureService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Gets the posture value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @RequirePermission('users:manage')
  @Get()
  async getPosture(@Query('tenantId') tenantId = 'default') {
    return this.posture.generate(tenantId);
  }

  /**
   * Handles the fix safe operation for SecurityPostureController.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @RequirePermission('users:manage')
  @Post('/fix')
  async fixSafe(
    @Query('tenantId') tenantId = 'default',
    @Body() body: { actions?: SecurityPostureFixAction[] } | undefined,
    @CurrentUser() user: User,
  ) {
    const result = await this.posture.applySafeFixes(tenantId, body?.actions);
    this.audit.record(user.id, 'security_posture.fix_safe', tenantId, {
      applied: result.applied.map((item) => ({ findingId: item.findingId, action: item.action })),
      skippedCount: result.skipped.length,
    }, tenantId);
    return result;
  }
}

