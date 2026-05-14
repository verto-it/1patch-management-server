// AGPL-3.0-only — Coverage history endpoint
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
export class DashboardHistoryController {
  /**
   * Creates a DashboardHistoryController instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param df df supplied to the function.
   */
  constructor(private readonly store: MemoryStore, private readonly df: DragonflyService) {}

  /**
   * Handles the history operation for DashboardHistoryController.
   *
   * @param daysParam Number of days to include in the range.
   * @returns The result produced by the operation.
   */
  @Get('/coverage-history')
  async history(@Query('days') daysParam?: string) {
    const days = Math.max(1, Math.min(180, Number(daysParam) || 30));
    const today = this.computeCoverage();
    const todayKey = new Date().toISOString().slice(0, 10);
    await this.df.setJson?.(`patch:coverage:${todayKey}`, { date: todayKey, value: today });
    const out: Array<{ date: string; value: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const stored = await this.df.getJson?.<number | { date?: string; value?: number }>(`patch:coverage:${key}`);
      const value = typeof stored === 'number' ? stored : stored?.value;
      if (Number.isFinite(value)) out.push({ date: key, value: Number(value) });
    }
    if (!out.length) out.push({ date: todayKey, value: today });
    return out;
  }

  /**
   * Computes the coverage value.
   * @returns The result produced by the operation.
   */
  private computeCoverage() {
    const total = this.store.installedApps.length;
    if (!total) return 100;
    // An install is "compliant" if no other install of the same app/publisher has a higher version.
    const latestByApp = new Map<string, string>();
    for (const a of this.store.installedApps) {
      const k = `${a.name}|${a.publisher}`;
      const cur = latestByApp.get(k);
      if (!cur || cmp(a.version, cur) > 0) latestByApp.set(k, a.version);
    }
    let compliant = 0;
    for (const a of this.store.installedApps) {
      const latest = latestByApp.get(`${a.name}|${a.publisher}`);
      if (!latest || cmp(a.version, latest) >= 0) compliant++;
    }
    return Math.round((compliant / total) * 100);
  }
}
/**
 * Handles the cmp operation.
 *
 * @param a a supplied to the function.
 * @param b b supplied to the function.
 * @returns The result produced by the operation.
 */
function cmp(a: string, b: string) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
