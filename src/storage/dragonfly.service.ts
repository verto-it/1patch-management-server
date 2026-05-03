import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class DragonflyService implements OnModuleDestroy {
  private readonly logger = new Logger(DragonflyService.name);
  private readonly client?: Redis;
  private lastError?: string;

  constructor() {
    const url = process.env.DRAGONFLY_URL;
    if (!url) {
      this.logger.warn('DRAGONFLY_URL is not configured; state will not survive process restarts');
      return;
    }
    this.client = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    this.client.on('error', (error) => {
      this.lastError = error.message || 'Connection failed';
    });
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    if (!this.client) return undefined;
    if (!(await this.ensureConnected())) return undefined;
    try {
      const raw = await this.client.get(key);
      this.lastError = undefined;
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
      return undefined;
    }
  }

  async setJson(key: string, value: unknown) {
    if (!this.client) return;
    if (!(await this.ensureConnected())) return;
    try {
      await this.client.set(key, JSON.stringify(value));
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
    }
  }

  async onModuleDestroy() {
    if (this.client?.status === 'ready') await this.client.quit();
  }

  isConfigured() {
    return Boolean(this.client);
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      available: this.client?.status === 'ready',
      lastError: this.lastError,
    };
  }

  private async ensureConnected() {
    if (!this.client) return false;
    if (this.client.status === 'ready') return true;
    if (this.client.status !== 'wait' && this.client.status !== 'end') return false;
    try {
      await this.client.connect();
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
      return false;
    }
  }
}
