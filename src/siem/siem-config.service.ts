// AGPL-3.0-only
import { Injectable, Logger } from '@nestjs/common';
import { DragonflyService } from '../storage/dragonfly.service';
import { SiemConfig, TenantSiemConfig } from '../types';

const CONFIG_KEY = '1patch:siem:configs';

@Injectable()
export class SiemConfigService {
  private readonly logger = new Logger(SiemConfigService.name);
  /** In-process cache to avoid Redis round-trips on every flush */
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

  private async loadAll(): Promise<TenantSiemConfig[]> {
    return await this.dragonfly.getJson<TenantSiemConfig[]>(CONFIG_KEY) ?? [];
  }

  private validate(config: SiemConfig): void {
    if (!['minimal', 'standard', 'full'].includes(config.mode)) {
      throw new Error(`Invalid SIEM mode: ${config.mode}`);
    }
    if (config.webhook?.url && !config.webhook.url.startsWith('https://')) {
      throw new Error('Webhook URL must use HTTPS');
    }
  }
}
