// AGPL-3.0-only
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { PatchRule, RuleTrigger, User } from '../types';
import { RulesService } from './rules.service';

@ApiTags('rules')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('rules:manage')
@Controller('/rules')
export class RulesController {
  /**
   * Creates a RulesController instance with its required collaborators.
   *
   * @param rules rules supplied to the function.
   */
  constructor(private readonly rules: RulesService) {}

  /**
   * Lists list records for the caller.
   * @returns The result produced by the operation.
   */
  @Get()
  list() {
    return this.rules.list();
  }

  /**
   * Handles the audit operation for RulesController.
   * @returns The result produced by the operation.
   */
  @Get('/audit')
  audit() {
    return this.rules.auditLog();
  }

  /**
   * Handles the audit rule operation for RulesController.
   *
   * @param id Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @Get('/:id/audit')
  auditRule(@Param('id') id: string) {
    return this.rules.auditLog(id);
  }

  /**
   * Creates a create record.
   *
   * @param dto Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post()
  create(@Body() dto: Partial<PatchRule>, @CurrentUser() user: User) {
    return this.rules.create(dto, user);
  }

  /**
   * Handles the patch operation for RulesController.
   *
   * @param id Identifier used to locate the target record.
   * @param dto Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Patch('/:id')
  patch(@Param('id') id: string, @Body() dto: Partial<PatchRule>, @CurrentUser() user: User) {
    return this.rules.update(id, dto, user);
  }

  /**
   * Handles the test operation for RulesController.
   *
   * @param id Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @returns The result produced by the operation.
   */
  @Post('/:id/test')
  test(@Param('id') id: string, @Body() body: { deviceId?: string }) {
    return this.rules.simulate(id, body.deviceId);
  }

  /**
   * Handles the trigger operation for RulesController.
   *
   * @param id Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/:id/trigger')
  trigger(@Param('id') id: string, @Body() body: { deviceId?: string }, @CurrentUser() user: User) {
    return this.rules.trigger(id, user, body.deviceId);
  }

  /**
   * Handles the trigger event operation for RulesController.
   *
   * @param eventType event type supplied to the function.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/events/:eventType')
  triggerEvent(
    @Param('eventType') eventType: NonNullable<RuleTrigger['eventType']>,
    @Body() body: { deviceId?: string },
    @CurrentUser() user: User,
  ) {
    return this.rules.triggerEvent(eventType, user, body.deviceId);
  }
}
