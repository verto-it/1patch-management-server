// AGPL-3.0-only
import { Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { SiemEvent, SiemSentinelConfig } from '../../types';
import { EventExporter } from '../exporter.interface';

const API_VERSION = '2016-04-01';
const BATCH_SIZE = 100;

export class SentinelExporter implements EventExporter {
  readonly name = 'sentinel';
  private readonly logger = new Logger(SentinelExporter.name);

  constructor(private readonly config: SiemSentinelConfig) {}

  async send(events: SiemEvent[]): Promise<void> {
    if (events.length === 0) return;
    // Batch into slices of BATCH_SIZE
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      await this.postBatch(batch);
    }
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      // Send a minimal synthetic event to prove auth + connectivity
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
      await this.postBatch([testEvent]);
      return { ok: true, message: `Sentinel workspace ${this.config.workspaceId} accepted event` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async postBatch(events: SiemEvent[]): Promise<void> {
    const body = JSON.stringify(events);
    const contentLength = Buffer.byteLength(body, 'utf8');
    const contentType = 'application/json';
    const xMsDate = new Date().toUTCString();
    const resource = '/api/logs';

    const signature = this.buildSignature(contentLength, contentType, xMsDate, resource);
    const url =
      `https://${this.config.workspaceId}.ods.opinsights.azure.com${resource}?api-version=${API_VERSION}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `SharedKey ${this.config.workspaceId}:${signature}`,
        'Log-Type': this.config.logType,
        'x-ms-date': xMsDate,
        'time-generated-field': 'timestamp',
        'Content-Type': contentType,
        'Content-Length': contentLength.toString(),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Sentinel ingestion failed: HTTP ${res.status} — ${detail}`);
    }

    this.logger.debug(
      `Sentinel: ingested ${events.length} event(s) → workspace=${this.config.workspaceId} logType=${this.config.logType}`,
    );
  }

  /**
   * Builds the SharedKey HMAC-SHA256 signature required by the
   * Azure Log Analytics HTTP Data Collector API.
   *
   * stringToSign = METHOD + "\n" + Content-Length + "\n" + Content-Type + "\n"
   *              + x-ms-date + "\n" + /api/logs
   */
  buildSignature(
    contentLength: number,
    contentType: string,
    xMsDate: string,
    resource: string,
  ): string {
    const stringToSign = [
      'POST',
      contentLength.toString(),
      contentType,
      `x-ms-date:${xMsDate}`,
      resource,
    ].join('\n');

    const key = Buffer.from(this.config.sharedKey, 'base64');
    const hash = createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
    return hash;
  }
}
