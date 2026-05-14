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

  /**
   * Creates a SiemConfigService instance with its required collaborators.
   *
   * @param dragonfly dragonfly supplied to the function.
   */
  constructor(private readonly dragonfly: DragonflyService) {}

  /**
   * Gets the get value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async get(tenantId: string): Promise<SiemConfig | undefined> {
    if (this.cache.has(tenantId)) return this.cache.get(tenantId);
    const all = await this.loadAll();
    return all.find((c) => c.tenantId === tenantId)?.config;
  }

  /**
   * Sets the set value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param config Configuration object used by the operation.
   * @returns The result produced by the operation.
   */
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

  /**
   * Removes the delete record or state.
   *
   * @param tenantId Identifier used to locate the target record.
   */
  async delete(tenantId: string): Promise<void> {
    const all = (await this.loadAll()).filter((c) => c.tenantId !== tenantId);
    await this.dragonfly.setJson(CONFIG_KEY, all);
    this.cache.delete(tenantId);
  }

  /**
   * Lists all records for the caller.
   * @returns The result produced by the operation.
   */
  async listAll(): Promise<TenantSiemConfig[]> {
    return this.loadAll();
  }

  // ── Health tracking ──────────────────────────────────────────────────────────

  /**
   * Gets the health value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
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

  /**
   * Lists all health records for the caller.
   * @returns The result produced by the operation.
   */
  async listAllHealth(): Promise<SiemHealth[]> {
    return this.loadAllHealth();
  }

  /**
   * Handles the record success operation for SiemConfigService.
   *
   * @param tenantId Identifier used to locate the target record.
   */
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

  /**
   * Handles the record failure operation for SiemConfigService.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param error Error raised by the preceding operation.
   */
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

  /**
   * Loads all data.
   * @returns The result produced by the operation.
   */
  private async loadAll(): Promise<TenantSiemConfig[]> {
    return await this.dragonfly.getJson<TenantSiemConfig[]>(CONFIG_KEY) ?? [];
  }

  /**
   * Loads all health data.
   * @returns The result produced by the operation.
   */
  private async loadAllHealth(): Promise<SiemHealth[]> {
    return await this.dragonfly.getJson<SiemHealth[]>(HEALTH_KEY) ?? [];
  }

  /**
   * Validates validate rules.
   *
   * @param config Configuration object used by the operation.
   */
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
