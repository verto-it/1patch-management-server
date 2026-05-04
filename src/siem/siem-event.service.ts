// AGPL-3.0-only
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { DragonflyService } from '../storage/dragonfly.service';
import { PostgresService } from '../storage/postgres.service';
import { SiemEvent, SiemEventType, SiemSeverity } from '../types';

const QUEUE_KEY = '1patch:siem:queue';
const APPEND_LOG_KEY = '1patch:siem:append-log';
const CHAIN_HEAD_KEY = '1patch:siem:chain:head';
const MAX_QUEUE = 10_000;
const MAX_APPEND_LOG = 50_000;

export interface EmitOptions {
  tenantId: string;
  type: SiemEventType;
  severity: SiemSeverity;
  actor?: Partial<SiemEvent['actor']>;
  target?: Partial<SiemEvent['target']>;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

@Injectable()
export class SiemEventService {
  private readonly logger = new Logger(SiemEventService.name);
  /** In-process head hash — authoritative when Dragonfly is unavailable */
  private headHash: string | null = null;

  constructor(
    private readonly dragonfly: DragonflyService,
    private readonly postgres: PostgresService,
  ) {}

  /**
   * Emit a SIEM event.  Never throws — SIEM must never block the core system.
   */
  emit(opts: EmitOptions): void {
    void this.emitAsync(opts).catch((err) => {
      this.logger.error(`SIEM emit failed (swallowed): ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async emitAsync(opts: EmitOptions): Promise<void> {
    const previousEventHash = this.headHash ?? await this.dragonfly.getJson<string>(CHAIN_HEAD_KEY) ?? undefined;

    const partial: Omit<SiemEvent, 'eventHash'> = {
      eventId: uuid(),
      timestamp: new Date().toISOString(),
      tenantId: opts.tenantId,
      type: opts.type,
      severity: opts.severity,
      actor: {
        userId: opts.actor?.userId ?? null,
        nodeId: opts.actor?.nodeId ?? null,
        ip: opts.actor?.ip ?? null,
      },
      target: {
        taskId: opts.target?.taskId ?? null,
        deviceId: opts.target?.deviceId ?? null,
        nodeId: opts.target?.nodeId ?? null,
      },
      metadata: opts.metadata ?? {},
      correlationId: opts.correlationId ?? null,
      previousEventHash,
    };

    const eventHash = computeSiemHash(partial, previousEventHash);
    const event: SiemEvent = { ...partial, eventHash };

    // Update head in-process immediately for chain continuity
    this.headHash = eventHash;

    // Persist to the durable store, append-only operational log, and delivery queue.
    await this.dragonfly.setJson(CHAIN_HEAD_KEY, eventHash);
    await this.appendLog(event);
    await this.postgres.appendSiemEvent(event);
    await this.enqueue(event);

    this.logger.debug(`SIEM event queued: type=${event.type} tenant=${event.tenantId} id=${event.eventId}`);
  }

  /** Drain up to `count` events from the queue. Returns the drained events. */
  async drain(count = 200): Promise<SiemEvent[]> {
    const raw = await this.dragonfly.getJson<SiemEvent[]>(QUEUE_KEY);
    if (!raw || raw.length === 0) return [];
    const batch = raw.splice(0, count);
    await this.dragonfly.setJson(QUEUE_KEY, raw);
    return batch;
  }

  /** Push a batch back onto the front of the queue (for retry). */
  async requeue(events: SiemEvent[]): Promise<void> {
    if (events.length === 0) return;
    const raw = await this.dragonfly.getJson<SiemEvent[]>(QUEUE_KEY) ?? [];
    await this.dragonfly.setJson(QUEUE_KEY, [...events, ...raw]);
  }

  /** Dead-letter queue — events that failed after all retries */
  async deadLetter(events: SiemEvent[]): Promise<void> {
    if (events.length === 0) return;
    const key = '1patch:siem:dlq';
    const raw = await this.dragonfly.getJson<SiemEvent[]>(key) ?? [];
    await this.dragonfly.setJson(key, [...raw, ...events]);
    this.logger.warn(`SIEM: ${events.length} event(s) moved to dead-letter queue`);
  }

  async getDeadLetterQueue(): Promise<SiemEvent[]> {
    return await this.dragonfly.getJson<SiemEvent[]>('1patch:siem:dlq') ?? [];
  }

  async queueDepth(): Promise<number> {
    const raw = await this.dragonfly.getJson<SiemEvent[]>(QUEUE_KEY);
    return raw?.length ?? 0;
  }

  private async enqueue(event: SiemEvent): Promise<void> {
    const raw = await this.dragonfly.getJson<SiemEvent[]>(QUEUE_KEY) ?? [];
    if (raw.length >= MAX_QUEUE) {
      this.logger.warn(`SIEM queue full (${MAX_QUEUE}) — dropping oldest event`);
      raw.shift();
    }
    raw.push(event);
    await this.dragonfly.setJson(QUEUE_KEY, raw);
  }

  private async appendLog(event: SiemEvent): Promise<void> {
    const raw = await this.dragonfly.getJson<SiemEvent[]>(APPEND_LOG_KEY) ?? [];
    raw.push(event);
    if (raw.length > MAX_APPEND_LOG) raw.splice(0, raw.length - MAX_APPEND_LOG);
    await this.dragonfly.setJson(APPEND_LOG_KEY, raw);
  }
}

export function computeSiemHash(event: Omit<SiemEvent, 'eventHash'>, previousHash?: string): string {
  const canonical = JSON.stringify({
    eventId: event.eventId,
    timestamp: event.timestamp,
    tenantId: event.tenantId,
    type: event.type,
    severity: event.severity,
    actor: event.actor,
    target: event.target,
    correlationId: event.correlationId,
    previousEventHash: previousHash ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
