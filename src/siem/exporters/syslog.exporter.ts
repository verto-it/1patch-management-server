// AGPL-3.0-only
import { Logger } from '@nestjs/common';
import * as dgram from 'dgram';
import * as net from 'net';
import { SiemEvent, SiemSeverity, SiemSyslogConfig } from '../../types';
import { EventExporter } from '../exporter.interface';

/** RFC5424 severity mapping */
const SEVERITY_MAP: Record<SiemSeverity, number> = {
  low: 6,      // Informational
  medium: 4,   // Warning
  high: 3,     // Error
  critical: 2, // Critical
};

/** Facility: 1 = user-level */
const FACILITY = 1;

export class SyslogExporter implements EventExporter {
  readonly name = 'syslog';
  private readonly logger = new Logger(SyslogExporter.name);
  private readonly appName: string;

  /**
   * Creates a SyslogExporter instance with its required collaborators.
   *
   * @param config Configuration object used by the operation.
   */
  constructor(private readonly config: SiemSyslogConfig) {
    this.appName = config.appName ?? '1patch';
  }

  /**
   * Sends send data to its destination.
   *
   * @param events events supplied to the function.
   */
  async send(events: SiemEvent[]): Promise<void> {
    for (const event of events) {
      const msg = this.formatRfc5424(event);
      await this.sendMessage(msg);
    }
  }

  /**
   * Validates verify rules.
   * @returns The result produced by the operation.
   */
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
        metadata: { test: true },
        correlationId: null,
      };
      await this.sendMessage(this.formatRfc5424(testEvent));
      return { ok: true, message: `Connected to ${this.config.host}:${this.config.port} (${this.config.protocol})` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Formats the rfc5424 value.
   *
   * @param event Event object emitted by the runtime or UI.
   * @returns The result produced by the operation.
   */
  private formatRfc5424(event: SiemEvent): string {
    const severity = SEVERITY_MAP[event.severity];
    const pri = FACILITY * 8 + severity;
    const timestamp = event.timestamp;
    const hostname = 'management-server';
    const appName = this.appName;
    const procId = process.pid.toString();
    const msgId = event.type;
    const structuredData = this.buildStructuredData(event);
    const msg = JSON.stringify({
      eventId: event.eventId,
      tenantId: event.tenantId,
      actor: event.actor,
      target: event.target,
      metadata: event.metadata,
    });

    // <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
    return `<${pri}>1 ${timestamp} ${hostname} ${appName} ${procId} ${msgId} ${structuredData} ${msg}`;
  }

  /**
   * Builds the structured data payload.
   *
   * @param event Event object emitted by the runtime or UI.
   * @returns The result produced by the operation.
   */
  private buildStructuredData(event: SiemEvent): string {
    const fields = [
      `eventId="${event.eventId}"`,
      `tenantId="${event.tenantId}"`,
      `severity="${event.severity}"`,
      `correlationId="${event.correlationId ?? '-'}"`,
    ].join(' ');
    return `[1patch@1patch ${fields}]`;
  }

  /**
   * Sends message data to its destination.
   *
   * @param msg msg supplied to the function.
   * @returns The result produced by the operation.
   */
  private sendMessage(msg: string): Promise<void> {
    return this.config.protocol === 'udp'
      ? this.sendUdp(msg)
      : this.sendTcp(msg);
  }

  /**
   * Sends udp data to its destination.
   *
   * @param msg msg supplied to the function.
   * @returns The result produced by the operation.
   */
  private sendUdp(msg: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const buf = Buffer.from(msg, 'utf8');
      client.send(buf, 0, buf.length, this.config.port, this.config.host, (err) => {
        client.close();
        if (err) {
          this.logger.warn(`Syslog UDP send failed: ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Sends tcp data to its destination.
   *
   * @param msg msg supplied to the function.
   * @returns The result produced by the operation.
   */
  private sendTcp(msg: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.config.host, port: this.config.port }, () => {
        socket.write(msg + '\n', 'utf8', (err) => {
          socket.destroy();
          if (err) {
            this.logger.warn(`Syslog TCP send failed: ${err.message}`);
            reject(err);
          } else {
            resolve();
          }
        });
      });
      socket.setTimeout(8_000);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('TCP connection timed out')); });
      socket.on('error', (err) => { socket.destroy(); reject(err); });
    });
  }
}
