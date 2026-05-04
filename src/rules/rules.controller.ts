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
  constructor(private readonly rules: RulesService) {}

  @Get()
  list() {
    return this.rules.list();
  }

  @Get('/audit')
  audit() {
    return this.rules.auditLog();
  }

  @Get('/:id/audit')
  auditRule(@Param('id') id: string) {
    return this.rules.auditLog(id);
  }

  @Post()
  create(@Body() dto: Partial<PatchRule>, @CurrentUser() user: User) {
    return this.rules.create(dto, user);
  }

  @Patch('/:id')
  patch(@Param('id') id: string, @Body() dto: Partial<PatchRule>, @CurrentUser() user: User) {
    return this.rules.update(id, dto, user);
  }

  @Post('/:id/test')
  test(@Param('id') id: string, @Body() body: { deviceId?: string }) {
    return this.rules.simulate(id, body.deviceId);
  }

  @Post('/:id/trigger')
  trigger(@Param('id') id: string, @Body() body: { deviceId?: string }, @CurrentUser() user: User) {
    return this.rules.trigger(id, user, body.deviceId);
  }

  @Post('/events/:eventType')
  triggerEvent(
    @Param('eventType') eventType: NonNullable<RuleTrigger['eventType']>,
    @Body() body: { deviceId?: string },
    @CurrentUser() user: User,
  ) {
    return this.rules.triggerEvent(eventType, user, body.deviceId);
  }
}
