import { Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { MemoryStore } from '../storage/memory.store';
import { User } from '../types';

@ApiTags('alarms')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('audit:read')
@Controller('/alarms')
export class AlarmsController {
  /**
   * Creates a AlarmsController instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param audit audit supplied to the function.
   */
  constructor(private readonly store: MemoryStore, private readonly audit: AuditService) {}

  /**
   * Lists list records for the caller.
   * @returns The result produced by the operation.
   */
  @Get()
  list() {
    return this.store.alarms.filter((a) => !a.resolvedAt);
  }

  /**
   * Resolves resolve configuration.
   *
   * @param id Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/:id/resolve')
  resolve(@Param('id') id: string, @CurrentUser() user: User) {
    const alarm = this.store.alarms.find((a) => a.id === id);
    if (!alarm) throw new NotFoundException('Alarm not found');
    alarm.resolvedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(user.id, 'alarm.resolved', id);
    return alarm;
  }
}
