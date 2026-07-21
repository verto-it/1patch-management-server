import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class DragonflyService implements OnModuleDestroy {
  private readonly logger = new Logger(DragonflyService.name);
  private readonly client?: Redis;
  private lastError?: string;

  /**
   * Creates a DragonflyService instance with its required collaborators.
   */
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
      /**
       * Handles the retry strategy operation for DragonflyService.
       */
      retryStrategy: () => null,
    });
    this.client.on('error', (error) => {
      this.lastError = error.message || 'Connection failed';
    });
  }

  /**
   * Gets the json value.
   *
   * @param key key supplied to the function.
   * @returns The result produced by the operation.
   */
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

  /**
   * Sets the json value.
   *
   * @param key key supplied to the function.
   * @param value Value to read, render, or store.
   */
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

  /**
   * Sets the json ex value.
   *
   * @param key key supplied to the function.
   * @param value Value to read, render, or store.
   * @param ttlSeconds ttl seconds supplied to the function.
   */
  async setJsonEx(key: string, value: unknown, ttlSeconds: number) {
    if (!this.client) return;
    if (!(await this.ensureConnected())) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
    }
  }

  /**
   * Atomically increments a counter and, on first creation, sets its TTL.
   *
   * Uses a single server-side script so concurrent callers cannot race between
   * read and write (used for brute-force counters). When Dragonfly is not
   * configured/available the operation fails open and returns undefined so the
   * caller can decide how to degrade.
   *
   * @param key key supplied to the function.
   * @param ttlSeconds TTL applied only when the counter is first created.
   * @returns The new counter value, or undefined if the store is unavailable.
   */
  async increment(key: string, ttlSeconds: number): Promise<number | undefined> {
    if (!this.client) return undefined;
    if (!(await this.ensureConnected())) return undefined;
    try {
      const value = (await this.client.eval(
        "local v = redis.call('INCR', KEYS[1]) if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return v",
        1,
        key,
        String(ttlSeconds),
      )) as number;
      this.lastError = undefined;
      return value;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
      return undefined;
    }
  }

  /**
   * Sets a key with a TTL only if it does not already exist (SET NX EX).
   *
   * Returns true when the key was newly created, false when it already existed.
   * Used for single-use tokens: the first caller wins, replays see false. When
   * the store is unavailable the operation fails open and returns true so the
   * primary action is not blocked.
   *
   * @param key key supplied to the function.
   * @param value Value to store.
   * @param ttlSeconds TTL for the key.
   * @returns True if newly set (or the store is unavailable), false if it existed.
   */
  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    if (!this.client) return true;
    if (!(await this.ensureConnected())) return true;
    try {
      const result = await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
      this.lastError = undefined;
      return result === 'OK';
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
      return true;
    }
  }

  /**
   * Handles the del operation for DragonflyService.
   *
   * @param key key supplied to the function.
   */
  async del(key: string) {
    if (!this.client) return;
    if (!(await this.ensureConnected())) return;
    try {
      await this.client.del(key);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
    }
  }

  /**
   * Handles the on module destroy operation for DragonflyService.
   */
  async onModuleDestroy() {
    if (this.client?.status === 'ready') await this.client.quit();
  }

  /**
   * Handles the is configured operation for DragonflyService.
   * @returns The result produced by the operation.
   */
  isConfigured() {
    return Boolean(this.client);
  }

  /**
   * Gets the status value.
   * @returns The result produced by the operation.
   */
  getStatus() {
    return {
      configured: this.isConfigured(),
      available: this.client?.status === 'ready',
      lastError: this.lastError,
    };
  }

  /**
   * Resolves connected configuration.
   * @returns The result produced by the operation.
   */
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
