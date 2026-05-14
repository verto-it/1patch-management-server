import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';
import { DragonflyService } from './storage/dragonfly.service';
import { MemoryStore } from './storage/memory.store';

@ApiTags('dashboard')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('apps:read')
@Controller('/dashboard')
export class DashboardController {
  /**
   * Creates a DashboardController instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param dragonfly dragonfly supplied to the function.
   */
  constructor(private readonly store: MemoryStore, private readonly dragonfly: DragonflyService) {}

  /**
   * Handles the summary operation for DashboardController.
   * @returns The result produced by the operation.
   */
  @Get('/summary')
  summary() {
    const stats = this.computeSummaryStats();

    // Persist today's coverage snapshot (fire-and-forget)
    const today = new Date().toISOString().slice(0, 10);
    void this.dragonfly.setJson(`patch:coverage:${today}`, { date: today, value: stats.coverage });

    const appKeys = new Set(this.store.installedApps.map((app) => `${app.name}|${app.publisher}`));
    const activeAlarms = this.store.alarms.filter((alarm) => !alarm.resolvedAt);
    return {
      managedDevices: this.store.devices.length,
      onlineDevices: stats.onlineDevices,
      appsDiscovered: appKeys.size,
      installedApps: this.store.installedApps.length,
      activeAlarms: activeAlarms.length,
      criticalAlarms: activeAlarms.filter((alarm) => alarm.severity === 'critical').length,
      activeUpdates: this.store.tasks.filter((task) => ['pending', 'dispatched'].includes(task.status)).length,
      failedUpdates: this.store.tasks.filter((task) => task.status === 'failed').length,
      activeRules: this.store.rules.filter((r) => r.enabled).length,
      coverage: stats.coverage,
      compliantApps: stats.compliantApps,
      outdatedApps: stats.outdatedApps,
      recentUpdates: this.store.tasks
        .filter((task) => ['completed', 'failed', 'rejected'].includes(task.status))
        .slice(-10)
        .reverse(),
      alarms: this.store.alarms.filter((alarm) => !alarm.resolvedAt).slice(0, 10),
    };
  }

  /**
   * Handles the coverage history operation for DashboardController.
   *
   * @param days Number of days to include in the range.
   * @returns The result produced by the operation.
   */
  @Get('/coverage-history')
  async coverageHistory(@Query('days') days?: string) {
    const n = Math.min(Math.max(parseInt(days ?? '30', 10) || 30, 1), 90);
    const results: Array<{ date: string; value: number }> = [];
    const today = new Date().toISOString().slice(0, 10);
    const currentCoverage = this.computeSummaryStats().coverage;
    await this.dragonfly.setJson(`patch:coverage:${today}`, { date: today, value: currentCoverage });
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const stored = await this.dragonfly.getJson<number | { date?: string; value?: number }>(`patch:coverage:${date}`);
      const value = typeof stored === 'number' ? stored : stored?.value;
      if (Number.isFinite(value)) results.push({ date, value: Number(value) });
    }
    if (!results.some((point) => point.date === today)) results.push({ date: today, value: currentCoverage });
    return results;
  }

  /**
   * Computes start-page metrics from the current fleet snapshot.
   * @returns Fresh summary values for the dashboard overview.
   */
  private computeSummaryStats() {
    const onlineDevices = this.store.devices.filter(
      (device) => device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 2 * 60_000,
    ).length;

    const latestByApp = new Map<string, string>();
    for (const app of this.store.installedApps) {
      const key = appKey(app, devicePlatform(this.store.devices.find((device) => device.id === app.deviceId)));
      const current = latestByApp.get(key);
      if (!current || compareVersions(app.version, current) > 0) latestByApp.set(key, app.version);
    }

    let compliantApps = 0;
    let outdatedApps = 0;
    for (const app of this.store.installedApps) {
      const latest = latestByApp.get(appKey(app, devicePlatform(this.store.devices.find((device) => device.id === app.deviceId))));
      if (!latest || compareVersions(app.version, latest) >= 0) compliantApps += 1;
      else outdatedApps += 1;
    }

    const totalApps = this.store.installedApps.length;
    const coverage = totalApps > 0 ? Math.round((compliantApps / totalApps) * 100) : 100;
    return { onlineDevices, compliantApps, outdatedApps, coverage };
  }
}

/**
 * Handles version ordering for installed app comparisons.
 *
 * @param left left supplied to the function.
 * @param right right supplied to the function.
 * @returns The result produced by the operation.
 */
function compareVersions(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function appKey(app: { name: string; publisher: string }, platform: string) {
  return `${platform}|${app.name}|${app.publisher}`;
}

function devicePlatform(device?: { os?: string }) {
  const os = device?.os ?? '';
  if (/(windows|win)/i.test(os)) return 'windows';
  if (/(linux|ubuntu|debian)/i.test(os)) return 'linux';
  return 'other';
}
