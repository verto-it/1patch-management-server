// AGPL-3.0-only
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { RuleTemplate, User } from '../types';
import { RuleTemplatesService } from './rule-templates.service';

@ApiTags('rule-templates')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('rules:manage')
@Controller('/rule-templates')
export class RuleTemplatesController {
  /**
   * Creates a RuleTemplatesController instance with its required collaborators.
   *
   * @param templates templates supplied to the function.
   */
  constructor(private readonly templates: RuleTemplatesService) {}

  /**
   * Lists list records for the caller.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @Get()
  list(@Query('tenantId') tenantId = 'default') {
    return this.templates.list(tenantId);
  }

  /**
   * Handles the export custom operation for RuleTemplatesController.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @Get('/custom/export')
  exportCustom(@Query('tenantId') tenantId = 'default') {
    return this.templates.exportCustom(tenantId);
  }

  /**
   * Gets the get value.
   *
   * @param id Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Get('/:id')
  get(@Param('id') id: string, @CurrentUser() user: User) {
    return this.templates.get(id, user);
  }

  /**
   * Creates a draft record.
   *
   * @param id Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/:id/create-draft')
  createDraft(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: User) {
    return this.templates.createDraft(id, body ?? {}, user);
  }

  /**
   * Creates a custom record.
   *
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/custom')
  createCustom(@Body() body: Partial<RuleTemplate>, @CurrentUser() user: User) {
    return this.templates.createCustom(body, user);
  }

  /**
   * Handles the import custom operation for RuleTemplatesController.
   *
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/custom/import')
  importCustom(@Body() body: unknown, @CurrentUser() user: User) {
    return this.templates.importCustom(body, user);
  }
}
