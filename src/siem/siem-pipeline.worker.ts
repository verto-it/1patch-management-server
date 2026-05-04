// AGPL-3.0-only
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SentinelExporter } from './exporters/sentinel.exporter';
import { SyslogExporter } from './exporters/syslog.exporter';
import { WebhookExporter } from './exporters/webhook.exporter';
import { EventExporter, filterEvents } from './exporter.interface';
import { SiemConfigService } from './siem-config.service';
import { SiemEventService } from './siem-event.service';
import { SiemConfig, SiemEvent } from '../types';

const FLUSH_INTERVAL_MS = Number(process.env.SIEM_FLUSH_INTERVAL_MS ?? 10_000);
const MAX_EXPORTER_RETRIES = 3;

@Injectable()
export class SiemPipelineWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SiemPipelineWorker.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly events: SiemEventService,
    private readonly configs: SiemConfigService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.logger.log(`SIEM pipeline worker started (interval=${FLUSH_INTERVAL_MS}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Public for CLI/test access */
  async flush(): Promise<void> {
    const batch = await this.events.drain(200);
    if (batch.length === 0) return;

    this.logger.debug(`SIEM flush: draining ${batch.length} event(s)`);

    // Group by tenantId so each tenant uses its own config
    const byTenant = new Map<string, SiemEvent[]>();
    for (const event of batch) {
      const list = byTenant.get(event.tenantId) ?? [];
      list.push(event);
      byTenant.set(event.tenantId, list);
    }

    for (const [tenantId, tenantEvents] of byTenant) {
      const config = await this.configs.get(tenantId);
      if (!config) {
        this.logger.debug(`No SIEM config for tenant=${tenantId} — skipping ${tenantEvents.length} event(s)`);
        continue;
      }
      await this.exportForTenant(tenantId, tenantEvents, config);
    }
  }

  private async exportForTenant(
    tenantId: string,
    events: SiemEvent[],
    config: SiemConfig,
  ): Promise<void> {
    const filtered = filterEvents(events, config.mode, config.exportOverrides);
    if (filtered.length === 0) return;

    const exporters = this.buildExporters(config);
    if (exporters.length === 0) {
      this.logger.debug(`No exporters configured for tenant=${tenantId}`);
      return;
    }

    for (const exporter of exporters) {
      await this.runExporter(exporter, filtered, tenantId);
    }
  }

  private async runExporter(
    exporter: EventExporter,
    events: SiemEvent[],
    tenantId: string,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_EXPORTER_RETRIES; attempt++) {
      try {
        await exporter.send(events);
        return;
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `SIEM exporter '${exporter.name}' attempt ${attempt}/${MAX_EXPORTER_RETRIES} failed` +
          ` (tenant=${tenantId}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < MAX_EXPORTER_RETRIES) await sleep(1_000 * attempt);
      }
    }
    // All retries exhausted — dead-letter these events
    this.logger.error(
      `SIEM exporter '${exporter.name}' failed after ${MAX_EXPORTER_RETRIES} retries` +
      ` (tenant=${tenantId}). Moving ${events.length} event(s) to DLQ.`,
    );
    await this.events.deadLetter(events);
  }

  buildExporters(config: SiemConfig): EventExporter[] {
    const exporters: EventExporter[] = [];
    try {
      if (config.webhook?.url) exporters.push(new WebhookExporter(config.webhook));
    } catch (err) {
      this.logger.error(`Webhook exporter config invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (config.syslog?.host) exporters.push(new SyslogExporter(config.syslog));
    if (config.sentinel?.workspaceId) exporters.push(new SentinelExporter(config.sentinel));
    return exporters;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
