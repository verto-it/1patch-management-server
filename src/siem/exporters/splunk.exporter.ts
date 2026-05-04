// AGPL-3.0-only
import { Logger } from '@nestjs/common';
import { SiemEvent, SiemSplunkConfig } from '../../types';
import { EventExporter } from '../exporter.interface';

export class SplunkExporter implements EventExporter {
  readonly name = 'splunk';
  private readonly logger = new Logger(SplunkExporter.name);

  constructor(private readonly config: SiemSplunkConfig) {
    if (!config.url.startsWith('https://')) {
      throw new Error(`Splunk HEC URL must use HTTPS. Got: ${config.url}`);
    }
  }

  async send(events: SiemEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Splunk HEC accepts newline-delimited JSON objects
    const body = events
      .map((event) => JSON.stringify({
        event,
        time: Math.floor(new Date(event.timestamp).getTime() / 1000),
        ...(this.config.index ? { index: this.config.index } : {}),
        ...(this.config.source ? { source: this.config.source } : {}),
      }))
      .join('\n');

    const res = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        'Authorization': `Splunk ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Splunk HEC rejected events: HTTP ${res.status} — ${detail}`);
    }

    this.logger.debug(`Splunk: sent ${events.length} event(s) → ${this.config.url}`);
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      const testEvent: SiemEvent = {
        eventId: '00000000-0000-0000-0000-000000000000',
        timestamp: new Date().toISOString(),
        tenantId: 'test',
        type: 'auth.login.success',
        severity: 'low',
        actor: { userId: null, nodeId: null, ip: null },
        target: { taskId: null, deviceId: null, nodeId: null },
        metadata: { test: true, source: '1patch-siem-verify' },
        correlationId: null,
      };
      await this.send([testEvent]);
      return { ok: true, message: `Splunk HEC at ${this.config.url} accepted event` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
