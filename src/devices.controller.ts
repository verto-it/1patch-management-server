import { Controller, Get, Param, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminApiGuard } from './security/admin-api.guard';
import { MemoryStore } from './storage/memory.store';

@ApiTags('devices')
@UseGuards(AdminApiGuard)
@Controller('/devices')
export class DevicesController {
  constructor(private readonly store: MemoryStore) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.store.devices
      .map((device) => ({
        ...device,
        online: device.lastSeenAt ? Date.now() - new Date(device.lastSeenAt).getTime() < 2 * 60_000 : false,
        installedAppCount: this.store.installedApps.filter((app) => app.deviceId === device.id).length,
        pendingTaskCount: this.store.tasks.filter((task) => task.deviceId === device.id && ['pending', 'dispatched'].includes(task.status)).length,
      }))
      .filter((device) => !q || `${device.hostname} ${device.os} ${device.id}`.toLowerCase().includes(q.toLowerCase()));
  }

  @Get('/:id')
  detail(@Param('id') id: string) {
    const device = this.store.devices.find((candidate) => candidate.id === id);
    return {
      device,
      installedApps: this.store.installedApps.filter((app) => app.deviceId === id),
      tasks: this.store.tasks.filter((task) => task.deviceId === id),
      alarms: this.store.alarms.filter((alarm) => alarm.deviceId === id && !alarm.resolvedAt),
    };
  }
}
