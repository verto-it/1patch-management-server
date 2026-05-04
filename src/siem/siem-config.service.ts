// AGPL-3.0-only
import { Injectable, Logger } from '@nestjs/common';
import { DragonflyService } from '../storage/dragonfly.service';
import { SiemConfig, SiemHealth, TenantSiemConfig } from '../types';

const CONFIG_KEY = '1patch:siem:configs';
const HEALTH_KEY = '1patch:siem:health';

@Injectable()
export class SiemConfigService {
  private readonly logger = new Logger(SiemConfigService.name);
  private cache = new Map<string, SiemConfig>();

  constructor(private readonly dragonfly: DragonflyService) {}

  async get(tenantId: string): Promise<SiemConfig | undefined> {
    if (this.cache.has(tenantId)) return this.cache.get(tenantId);
    const all = await this.loadAll();
    return all.find((c) => c.tenantId === tenantId)?.config;
  }

  async set(tenantId: string, config: SiemConfig): Promise<TenantSiemConfig> {
    this.validate(config);
    const all = await this.loadAll();
    const idx = all.findIndex((c) => c.tenantId === tenantId);
    const entry: TenantSiemConfig = { tenantId, config };
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    await this.dragonfly.setJson(CONFIG_KEY, all);
    this.cache.set(tenantId, config);
    this.logger.log(`SIEM config updated for tenant=${tenantId} mode=${config.mode}`);
    return entry;
  }

  async delete(tenantId: string): Promise<void> {
    const all = (await this.loadAll()).filter((c) => c.tenantId !== tenantId);
    await this.dragonfly.setJson(CONFIG_KEY, all);
    this.cache.delete(tenantId);
  }

  async listAll(): Promise<TenantSiemConfig[]> {
    return this.loadAll();
  }

  // ── Health tracking ──────────────────────────────────────────────────────────

  async getHealth(tenantId: string): Promise<SiemHealth> {
    const all = await this.loadAllHealth();
    return all.find((h) => h.tenantId === tenantId) ?? {
      tenantId,
      lastSuccessAt: null,
      lastFailureAt: null,
      failureCount: 0,
      lastError: null,
    };
  }

  async listAllHealth(): Promise<SiemHealth[]> {
    return this.loadAllHealth();
  }

  async recordSuccess(tenantId: string): Promise<void> {
    const all = await this.loadAllHealth();
    const idx = all.findIndex((h) => h.tenantId === tenantId);
    const existing = idx >= 0 ? all[idx] : null;
    const entry: SiemHealth = {
      tenantId,
      lastSuccessAt: new Date().toISOString(),
      lastFailureAt: existing?.lastFailureAt ?? null,
      failureCount: 0,
      lastError: null,
    };
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    await this.dragonfly.setJson(HEALTH_KEY, all);
  }

  async recordFailure(tenantId: string, error: string): Promise<void> {
    const all = await this.loadAllHealth();
    const idx = all.findIndex((h) => h.tenantId === tenantId);
    const existing = idx >= 0 ? all[idx] : null;
    const entry: SiemHealth = {
      tenantId,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      lastFailureAt: new Date().toISOString(),
      failureCount: (existing?.failureCount ?? 0) + 1,
      lastError: error,
    };
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    await this.dragonfly.setJson(HEALTH_KEY, all);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async loadAll(): Promise<TenantSiemConfig[]> {
    return await this.dragonfly.getJson<TenantSiemConfig[]>(CONFIG_KEY) ?? [];
  }

  private async loadAllHealth(): Promise<SiemHealth[]> {
    return await this.dragonfly.getJson<SiemHealth[]>(HEALTH_KEY) ?? [];
  }

  private validate(config: SiemConfig): void {
    if (!['minimal', 'standard', 'full'].includes(config.mode)) {
      throw new Error(`Invalid SIEM mode: ${config.mode}`);
    }
    if (config.webhook?.url && !config.webhook.url.startsWith('https://')) {
      throw new Error('Webhook URL must use HTTPS');
    }
    if (config.splunk?.url && !config.splunk.url.startsWith('https://')) {
      throw new Error('Splunk HEC URL must use HTTPS');
    }
  }
}
