import { Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { AdminApiGuard } from '../security/admin-api.guard';
import { MemoryStore } from '../storage/memory.store';

@ApiTags('alarms')
@UseGuards(AdminApiGuard)
@Controller('/alarms')
export class AlarmsController {
  constructor(private readonly store: MemoryStore, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.store.alarms.filter((a) => !a.resolvedAt);
  }

  @Post('/:id/resolve')
  resolve(@Param('id') id: string) {
    const alarm = this.store.alarms.find((a) => a.id === id);
    if (!alarm) throw new NotFoundException('Alarm not found');
    alarm.resolvedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record('system', 'alarm.resolved', id);
    return alarm;
  }
}
