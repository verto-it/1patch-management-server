import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { NodesService } from '../nodes/nodes.service';
import { SigningService } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import { Device, InstalledApp } from '../types';

@ApiTags('agent-control')
@Controller()
export class AgentController {
  constructor(
    private readonly nodes: NodesService,
    private readonly signing: SigningService,
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
  ) {}

  @Get('/agent/bootstrap/:tenantId')
  bootstrap(@Param('tenantId') tenantId: string) {
    const manifest = {
      tenantId,
      issuedAt: new Date().toISOString(),
      nodes: this.nodes.onlineNodes().map((node) => ({
        id: node.id,
        publicUrl: node.publicUrl,
        region: node.region,
        site: node.site,
      })),
    };
    return this.signing.signPayload(manifest);
  }

  @Get('/agent/rules/:tenantId')
  rules(@Param('tenantId') tenantId: string) {
    return this.signing.signPayload({ tenantId, issuedAt: new Date().toISOString(), rules: this.store.rules.filter((rule) => rule.enabled) });
  }

  @Post('/sync/node-events')
  syncNodeEvents(@Body() dto: { nodeId: string; events: Array<{ type: string; payload: unknown }> }) {
    for (const event of dto.events) {
      switch (event.type) {
        case 'device_registered': {
          const payload = event.payload as Device;
          const existing = this.store.devices.find((device) => device.id === payload.id || device.id === (payload as unknown as { deviceId: string }).deviceId);
          const device: Device = {
            id: (payload as unknown as { deviceId?: string }).deviceId ?? payload.id,
            tenantId: payload.tenantId,
            hostname: payload.hostname,
            os: payload.os,
            publicKey: payload.publicKey,
            preferredNodeId: dto.nodeId,
            lastSeenAt: new Date().toISOString(),
          };
          if (existing) Object.assign(existing, device);
          else this.store.devices.push(device);
          break;
        }
        case 'heartbeat': {
          const payload = event.payload as { deviceId: string };
          const device = this.store.devices.find((candidate) => candidate.id === payload.deviceId);
          if (device) {
            device.lastSeenAt = new Date().toISOString();
            device.preferredNodeId = dto.nodeId;
          }
          break;
        }
        case 'inventory': {
          const payload = event.payload as { deviceId: string; apps: Omit<InstalledApp, 'deviceId'>[] };
          this.store.installedApps = this.store.installedApps
            .filter((app) => app.deviceId !== payload.deviceId)
            .concat(payload.apps.map((app) => ({ ...app, deviceId: payload.deviceId })));
          break;
        }
        case 'task_result': {
          const payload = event.payload as { deviceId: string; taskId: string; status: 'completed' | 'failed' | 'rejected'; output?: string };
          const task = this.store.tasks.find((candidate) => candidate.id === payload.taskId);
          if (task) {
            task.status = payload.status;
            task.output = payload.output;
            task.completedAt = new Date().toISOString();
          }
          if (payload.status === 'failed' || payload.status === 'rejected') {
            this.store.alarms.unshift({
              id: `${payload.taskId}-${payload.status}`,
              deviceId: payload.deviceId,
              severity: payload.status === 'failed' ? 'critical' : 'warning',
              message: `Task ${payload.status}: ${task?.appName ?? payload.taskId}`,
              createdAt: new Date().toISOString(),
              metadata: { taskId: payload.taskId, output: payload.output },
            });
          }
          break;
        }
        case 'alarm': {
          const payload = event.payload as { deviceId: string; severity: 'info' | 'warning' | 'critical'; message: string; metadata?: Record<string, unknown> };
          this.store.alarms.unshift({
            id: `${dto.nodeId}-${Date.now()}-${this.store.alarms.length}`,
            deviceId: payload.deviceId,
            severity: payload.severity,
            message: payload.message,
            metadata: payload.metadata,
            createdAt: new Date().toISOString(),
          });
          break;
        }
      }
      this.audit.record(dto.nodeId, `node.sync.${event.type}`, dto.nodeId);
    }
    void this.store.persist();
    return { accepted: dto.events.length };
  }
}
