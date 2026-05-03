import { Body, Controller, Get, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { NodesService } from '../nodes/nodes.service';
import { MtlsNodeGuard } from '../security/mtls-node.guard';
import { NodeId } from '../security/node-id.decorator';
import { SigningService } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import { Device, InstalledApp } from '../types';

@ApiTags('agent-control')
@Controller()
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  
  constructor(
    private readonly nodes: NodesService,
    private readonly signing: SigningService,
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
  ) {}

  // Bootstrap and rules are public — clients need them before they have a session
  @Get('/agent/bootstrap/:tenantId')
  bootstrap(@Param('tenantId') tenantId: string) {
    const onlineNodes = this.nodes.onlineNodes();
    this.logger.log(`Bootstrap request for tenant=${tenantId} — returning ${onlineNodes.length} online node(s)`);
    const manifest = {
      nodes: onlineNodes.map((node) => ({
        id: node.id,
        publicUrl: node.publicUrl,
        region: node.region,
        site: node.site,
      })),
    };
    return this.signing.signPayload('bootstrap_manifest', tenantId, manifest);
  }

  @Get('/agent/rules/:tenantId')
  rules(@Param('tenantId') tenantId: string) {
    const enabledRules = this.store.rules.filter((r) => r.enabled);
    this.logger.debug(`Rules request for tenant=${tenantId} — returning ${enabledRules.length} enabled rule(s)`);
    return this.signing.signPayload('rule_bundle', tenantId, { rules: enabledRules });
  }

  /**
   * Sync endpoint — callable only by authenticated backend nodes.
   * Authentication is via Vault-issued mTLS certificate; the nodeId is extracted
   * from the certificate CN by MtlsNodeGuard and injected via @NodeId().
   */
  @UseGuards(MtlsNodeGuard)
  @Post('/sync/node-events')
  syncNodeEvents(
    @NodeId() nodeId: string,
    @Body() dto: { events: Array<{ type: string; payload: unknown }> },
  ) {
    this.logger.log(`Sync from nodeId=${nodeId}: ${dto.events.length} event(s)`);

    for (const event of dto.events) {
      this.logger.debug(`Processing event type=${event.type} from nodeId=${nodeId}`);
      switch (event.type) {
        case 'device_registered': {
          const payload = event.payload as Device & { deviceId?: string; enrollmentToken?: string };
          const id = payload.deviceId ?? payload.id;
          const enrollment = this.store.clientEnrollments.find((candidate) =>
            payload.enrollmentToken && bcrypt.compareSync(payload.enrollmentToken, candidate.enrollmentTokenHash),
          );
          if (!enrollment) {
            this.logger.warn(`Device registration rejected: invalid enrollment token for deviceId=${id}`);
            this.audit.record(nodeId, 'device.registration_rejected', id, { reason: 'invalid_enrollment_token' });
            break;
          }
          const alreadyUsedByDevice = enrollment.usedDeviceIds.includes(id);
          if (!alreadyUsedByDevice && enrollment.uses >= enrollment.maxUses) {
            this.logger.warn(`Device registration rejected: enrollment use limit reached for deviceId=${id}`);
            this.audit.record(nodeId, 'device.registration_rejected', id, { reason: 'enrollment_limit_reached', enrollmentId: enrollment.id });
            break;
          }
          if (!alreadyUsedByDevice) {
            enrollment.usedDeviceIds.push(id);
            enrollment.uses += 1;
          }
          const existing = this.store.devices.find((d) => d.id === id);
          const device: Device = {
            id,
            tenantId: enrollment.tenantId,
            hostname: payload.hostname,
            os: payload.os,
            publicKey: payload.publicKey,
            preferredNodeId: nodeId,
            lastSeenAt: new Date().toISOString(),
          };
          if (existing) {
            Object.assign(existing, device);
            this.logger.log(`Device updated: id=${id} host=${device.hostname}`);
          } else {
            this.store.devices.push(device);
            this.logger.log(`New device registered: id=${id} host=${device.hostname} tenant=${device.tenantId}`);
          }
          break;
        }
        case 'heartbeat': {
          const payload = event.payload as { deviceId: string };
          const device = this.store.devices.find((d) => d.id === payload.deviceId);
          if (device) {
            device.lastSeenAt = new Date().toISOString();
            device.preferredNodeId = nodeId;
            this.logger.debug(`Heartbeat recorded for deviceId=${payload.deviceId}`);
          } else {
            this.logger.warn(`Heartbeat from unknown deviceId=${payload.deviceId}`);
          }
          break;
        }
        case 'inventory': {
          const payload = event.payload as { deviceId: string; apps: Omit<InstalledApp, 'deviceId'>[] };
          this.store.installedApps = this.store.installedApps
            .filter((a) => a.deviceId !== payload.deviceId)
            .concat(payload.apps.map((a) => ({ ...a, deviceId: payload.deviceId })));
          this.logger.log(`Inventory updated for deviceId=${payload.deviceId}: ${payload.apps.length} app(s)`);
          break;
        }
        case 'task_result': {
          const payload = event.payload as { deviceId: string; taskId: string; status: 'completed' | 'failed' | 'rejected'; output?: string };
          const task = this.store.tasks.find((t) => t.id === payload.taskId);
          if (task) {
            task.status = payload.status;
            task.output = payload.output;
            task.completedAt = new Date().toISOString();
            this.logger.log(`Task result: taskId=${payload.taskId} deviceId=${payload.deviceId} status=${payload.status}`);
          } else {
            this.logger.warn(`Task result for unknown taskId=${payload.taskId}`);
          }
          if (payload.status === 'failed' || payload.status === 'rejected') {
            this.logger.warn(`Task ${payload.status}: taskId=${payload.taskId} — creating alarm`);
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
          this.logger.warn(`Alarm from deviceId=${payload.deviceId} severity=${payload.severity}: ${payload.message}`);
          this.store.alarms.unshift({
            id: `${nodeId}-${Date.now()}-${this.store.alarms.length}`,
            deviceId: payload.deviceId,
            severity: payload.severity,
            message: payload.message,
            metadata: payload.metadata,
            createdAt: new Date().toISOString(),
          });
          break;
        }
        default:
          this.logger.warn(`Unknown event type '${event.type}' from nodeId=${nodeId} — ignored`);
      }
      this.audit.record(nodeId, `node.sync.${event.type}`, nodeId);
    }

    void this.store.persist();
    this.logger.log(`Sync from nodeId=${nodeId} complete — ${dto.events.length} event(s) processed`);
    return { accepted: dto.events.length };
  }
}
