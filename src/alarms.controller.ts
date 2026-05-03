// AGPL-3.0-only
import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit/audit.service';
import { MemoryStore } from './storage/memory.store';
import { CurrentUser } from './security/current-user.decorator';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';
import { User } from './types';

@ApiTags('alarms')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('audit:read')
@Controller('/alarms')
export class AlarmsController {
  constructor(private readonly store: MemoryStore, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.store.alarms.filter((a) => !a.resolvedAt);
  }

  @Post('/:id/resolve')
  resolve(@Param('id') id: string, @CurrentUser() user: User) {
    const alarm = this.store.alarms.find((a) => a.id === id);
    if (!alarm) throw new NotFoundException();
    alarm.resolvedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(user.id, 'alarm.resolved', id);
    return alarm;
  }
}
