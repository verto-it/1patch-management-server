// AGPL-3.0-only — Coverage history endpoint
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminApiGuard } from './security/admin-api.guard';
import { DragonflyService } from './storage/dragonfly.service';
import { MemoryStore } from './storage/memory.store';

@ApiTags('dashboard')
@UseGuards(AdminApiGuard)
@Controller('/dashboard')
export class DashboardHistoryController {
  constructor(private readonly store: MemoryStore, private readonly df: DragonflyService) {}

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
      const stored = await this.df.getJson?.<{ date: string; value: number }>(`patch:coverage:${key}`);
      if (stored) out.push(stored);
    }
    if (!out.length) out.push({ date: todayKey, value: today });
    return out;
  }

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
      if (a.version === latestByApp.get(`${a.name}|${a.publisher}`)) compliant++;
    }
    return Math.round((compliant / total) * 100);
  }
}
function cmp(a: string, b: string) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
