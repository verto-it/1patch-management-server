import { filterEvents } from './exporter.interface';
import { SentinelExporter } from './exporters/sentinel.exporter';
import { SyslogExporter } from './exporters/syslog.exporter';
import { SiemEventService } from './siem-event.service';
import { SiemPipelineWorker } from './siem-pipeline.worker';
import { SiemEvent } from '../types';

const baseEvent: SiemEvent = {
  eventId: '11111111-1111-1111-1111-111111111111',
  timestamp: '2026-05-04T00:00:00.000Z',
  tenantId: 'tenant-a',
  type: 'auth.login.success',
  severity: 'low',
  actor: { userId: 'user-1', nodeId: null, ip: '127.0.0.1' },
  target: { taskId: null, deviceId: null, nodeId: null },
  metadata: {},
  correlationId: null,
};

describe('SIEM pipeline', () => {
  it('filters events by mode and per-type overrides', () => {
    const events: SiemEvent[] = [
      baseEvent,
      { ...baseEvent, eventId: '2', type: 'task.security_scan.completed', severity: 'low' },
      { ...baseEvent, eventId: '3', type: 'kill_switch.activated', severity: 'critical' },
    ];

    expect(filterEvents(events, 'minimal').map((e) => e.type)).toEqual(['kill_switch.activated']);
    expect(filterEvents(events, 'standard').map((e) => e.type)).toContain('auth.login.success');
    expect(filterEvents(events, 'full')).toHaveLength(3);
    expect(filterEvents(events, 'minimal', { 'auth.login.success': true }).map((e) => e.type))
      .toEqual(['auth.login.success', 'kill_switch.activated']);
    expect(filterEvents(events, 'full', { 'auth.login.success': false }).map((e) => e.type))
      .not.toContain('auth.login.success');
  });

  it('generates immutable events with hash chaining and durable append calls', async () => {
    const kv = new Map<string, unknown>();
    const dragonfly = {
      getJson: jest.fn(async (key: string) => kv.get(key)),
      setJson: jest.fn(async (key: string, value: unknown) => { kv.set(key, value); }),
    };
    const postgres = { appendSiemEvent: jest.fn(async () => undefined) };
    const service = new SiemEventService(dragonfly as any, postgres as any);

    await (service as any).emitAsync({ tenantId: 'tenant-a', type: 'auth.login.success', severity: 'low' });
    await (service as any).emitAsync({ tenantId: 'tenant-a', type: 'auth.login.failed', severity: 'medium' });

    const queue = kv.get('1patch:siem:queue') as SiemEvent[];
    expect(queue).toHaveLength(2);
    expect(queue[0].eventHash).toBeTruthy();
    expect(queue[1].previousEventHash).toBe(queue[0].eventHash);
    expect(postgres.appendSiemEvent).toHaveBeenCalledTimes(2);
    expect(kv.get('1patch:siem:append-log')).toHaveLength(2);
  });

  it('formats RFC5424 syslog with severity mapping', () => {
    const exporter = new SyslogExporter({ host: '127.0.0.1', port: 514, protocol: 'udp' });
    const line = (exporter as any).formatRfc5424({ ...baseEvent, severity: 'critical' });
    expect(line).toMatch(/^<10>1 2026-05-04T00:00:00.000Z management-server 1patch \d+ auth\.login\.success \[1patch@1patch /);
    expect(line).toContain('"tenantId":"tenant-a"');
  });

  it('builds the Sentinel SharedKey signature deterministically', () => {
    const exporter = new SentinelExporter({
      workspaceId: 'workspace-id',
      sharedKey: Buffer.from('secret-key').toString('base64'),
      logType: 'OnePatchEvents',
    });
    const actual = exporter.buildSignature(14, 'application/json', 'Mon, 04 May 2026 00:00:00 GMT', '/api/logs');
    expect(actual).toBe('HmEZpWcs1IX0YxzExt/kcv/M3HBb8tP1VeBj8bdMZBo=');
  });

  it('batches Sentinel ingestion requests', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    (global as any).fetch = fetchMock;
    try {
      const exporter = new SentinelExporter({
        workspaceId: 'workspace-id',
        sharedKey: Buffer.from('secret-key').toString('base64'),
        logType: 'OnePatchEvents',
      });
      await exporter.send(Array.from({ length: 205 }, (_, i) => ({ ...baseEvent, eventId: String(i) })));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('dead-letters exporter failures without throwing from flush', async () => {
    const events = [{ ...baseEvent, type: 'kill_switch.activated' as const, severity: 'critical' as const }];
    const eventService = {
      drain: jest.fn(async () => events),
      deadLetter: jest.fn(async () => undefined),
    };
    const configService = { get: jest.fn(async () => ({ mode: 'minimal' })) };
    const worker = new SiemPipelineWorker(eventService as any, configService as any);
    jest.spyOn(worker, 'buildExporters').mockReturnValue([
      { name: 'failing-test-exporter', send: jest.fn(async () => { throw new Error('nope'); }) },
    ]);

    await expect(worker.flush()).resolves.toBeUndefined();
    expect(eventService.deadLetter).toHaveBeenCalledWith(events);
  });
});
