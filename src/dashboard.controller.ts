import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminApiGuard } from './security/admin-api.guard';
import { DragonflyService } from './storage/dragonfly.service';
import { MemoryStore } from './storage/memory.store';

@ApiTags('dashboard')
@UseGuards(AdminApiGuard)
@Controller('/dashboard')
export class DashboardController {
  constructor(private readonly store: MemoryStore, private readonly dragonfly: DragonflyService) {}

  @Get('/summary')
  summary() {
    const onlineDevices = this.store.devices.filter(
      (device) => device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 2 * 60_000,
    ).length;

    // Build app groups to compute coverage
    const appGroups = new Map<string, { versions: Set<string> }>();
    for (const app of this.store.installedApps) {
      const key = `${app.name}|${app.publisher}`;
      const group = appGroups.get(key) ?? { versions: new Set() };
      group.versions.add(app.version);
      appGroups.set(key, group);
    }
    const totalApps = appGroups.size;
    const outdatedApps = [...appGroups.values()].filter((g) => g.versions.size > 1).length;
    const compliantApps = totalApps - outdatedApps;
    const coverage = totalApps > 0 ? Math.round((compliantApps / totalApps) * 100) : 100;

    // Persist today's coverage snapshot (fire-and-forget)
    const today = new Date().toISOString().slice(0, 10);
    void this.dragonfly.setJson(`patch:coverage:${today}`, coverage);

    const appKeys = new Set(this.store.installedApps.map((app) => `${app.name}|${app.publisher}`));
    return {
      managedDevices: this.store.devices.length,
      onlineDevices,
      appsDiscovered: appKeys.size,
      activeAlarms: this.store.alarms.filter((alarm) => !alarm.resolvedAt).length,
      activeUpdates: this.store.tasks.filter((task) => ['pending', 'dispatched'].includes(task.status)).length,
      failedUpdates: this.store.tasks.filter((task) => task.status === 'failed').length,
      activeRules: this.store.rules.filter((r) => r.enabled).length,
      coverage,
      compliantApps,
      outdatedApps,
      recentUpdates: this.store.tasks
        .filter((task) => ['completed', 'failed', 'rejected'].includes(task.status))
        .slice(-10)
        .reverse(),
      alarms: this.store.alarms.filter((alarm) => !alarm.resolvedAt).slice(0, 10),
    };
  }

  @Get('/coverage-history')
  async coverageHistory(@Query('days') days?: string) {
    const n = Math.min(Math.max(parseInt(days ?? '30', 10) || 30, 1), 90);
    const results: Array<{ date: string; value: number }> = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const value = await this.dragonfly.getJson<number>(`patch:coverage:${date}`);
      if (value !== undefined) results.push({ date, value });
    }
    return results;
  }
}
