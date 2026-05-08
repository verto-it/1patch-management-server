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
  constructor(private readonly templates: RuleTemplatesService) {}

  @Get()
  list(@Query('tenantId') tenantId = 'default') {
    return this.templates.list(tenantId);
  }

  @Get('/custom/export')
  exportCustom(@Query('tenantId') tenantId = 'default') {
    return this.templates.exportCustom(tenantId);
  }

  @Get('/:id')
  get(@Param('id') id: string, @CurrentUser() user: User) {
    return this.templates.get(id, user);
  }

  @Post('/:id/create-draft')
  createDraft(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: User) {
    return this.templates.createDraft(id, body ?? {}, user);
  }

  @Post('/custom')
  createCustom(@Body() body: Partial<RuleTemplate>, @CurrentUser() user: User) {
    return this.templates.createCustom(body, user);
  }

  @Post('/custom/import')
  importCustom(@Body() body: unknown, @CurrentUser() user: User) {
    return this.templates.importCustom(body, user);
  }
}
