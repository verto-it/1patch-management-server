// AGPL-3.0-only
import { Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { SiemEvent, SiemWebhookConfig } from '../../types';
import { EventExporter } from '../exporter.interface';

const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 500;

export class WebhookExporter implements EventExporter {
  readonly name = 'webhook';
  private readonly logger = new Logger(WebhookExporter.name);

  constructor(private readonly config: SiemWebhookConfig) {
    if (!config.url.startsWith('https://')) {
      throw new Error(`Webhook URL must use HTTPS. Got: ${config.url}`);
    }
  }

  async send(events: SiemEvent[]): Promise<void> {
    if (events.length === 0) return;
    const body = JSON.stringify(events);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.config.headers ?? {}),
    };

    if (this.config.secret) {
      headers['x-1patch-signature'] = this.buildSignature(body, this.config.secret);
    }

    await this.sendWithRetry(body, headers);
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      const testPayload = JSON.stringify([{ ping: true, source: '1patch-siem' }]);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.config.secret) {
        headers['x-1patch-signature'] = this.buildSignature(testPayload, this.config.secret);
      }
      const res = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: testPayload,
        signal: AbortSignal.timeout(8_000),
      });
      return { ok: res.ok, message: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async sendWithRetry(body: string, headers: Record<string, string>): Promise<void> {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        const res = await fetch(this.config.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return;
        throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          throw new Error(`Webhook delivery failed after ${MAX_RETRIES} retries: ${err instanceof Error ? err.message : String(err)}`);
        }
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 100;
        this.logger.warn(`Webhook attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${Math.round(delay)}ms`);
        await sleep(delay);
      }
    }
  }

  private buildSignature(body: string, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
