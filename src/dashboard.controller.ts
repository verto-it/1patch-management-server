import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminApiGuard } from './security/admin-api.guard';
import { MemoryStore } from './storage/memory.store';

@ApiTags('dashboard')
@UseGuards(AdminApiGuard)
@Controller('/dashboard')
export class DashboardController {
  constructor(private readonly store: MemoryStore) {}

  @Get('/summary')
  summary() {
    const onlineDevices = this.store.devices.filter((device) => device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 2 * 60_000).length;
    const appKeys = new Set(this.store.installedApps.map((app) => `${app.name}|${app.publisher}`));
    return {
      managedDevices: this.store.devices.length,
      onlineDevices,
      appsDiscovered: appKeys.size,
      activeAlarms: this.store.alarms.filter((alarm) => !alarm.resolvedAt).length,
      activeUpdates: this.store.tasks.filter((task) => ['pending', 'dispatched'].includes(task.status)).length,
      failedUpdates: this.store.tasks.filter((task) => task.status === 'failed').length,
      recentUpdates: this.store.tasks
        .filter((task) => ['completed', 'failed', 'rejected'].includes(task.status))
        .slice(-10)
        .reverse(),
      alarms: this.store.alarms.filter((alarm) => !alarm.resolvedAt).slice(0, 10),
    };
  }
}
