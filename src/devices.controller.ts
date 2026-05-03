// AGPL-3.0-only — replacement for src/devices.controller.ts (adds /update-all-outdated)
import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { CurrentUser } from './security/current-user.decorator';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';
import { MemoryStore } from './storage/memory.store';
import { UpdateTask, User } from './types';
import { NodesService } from './nodes/nodes.service';
import { SigningService } from './signing.service';

@ApiTags('devices')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('apps:read')
@Controller('/devices')
export class DevicesController {
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly nodes: NodesService,
    private readonly signing: SigningService,
  ) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.store.devices.map((device) => ({
      ...device,
      online: device.lastSeenAt ? Date.now() - new Date(device.lastSeenAt).getTime() < 2 * 60_000 : false,
      installedAppCount: this.store.installedApps.filter((a) => a.deviceId === device.id).length,
      pendingTaskCount: this.store.tasks.filter((t) => t.deviceId === device.id && ['pending','dispatched'].includes(t.status)).length,
    })).filter((d) => !q || `${d.hostname} ${d.os} ${d.id}`.toLowerCase().includes(q.toLowerCase()));
  }

  @Get('/:id')
  detail(@Param('id') id: string) {
    const device = this.store.devices.find((d) => d.id === id);
    const latest = new Map<string, string>();
    for (const app of this.store.installedApps) {
      const key = `${app.name}|${app.publisher}`;
      const current = latest.get(key);
      if (!current || app.version.localeCompare(current, undefined, { numeric: true }) > 0) latest.set(key, app.version);
    }
    const installedApps = this.store.installedApps
      .filter((a) => a.deviceId === id)
      .map((app) => ({
        ...app,
        latestVersion: latest.get(`${app.name}|${app.publisher}`) ?? app.version,
      }));
    return {
      device,
      installedApps,
      tasks: this.store.tasks.filter((t) => t.deviceId === id),
      alarms: this.store.alarms.filter((a) => a.deviceId === id && !a.resolvedAt),
    };
  }

  @Post('/enrollments')
  @RequirePermission('nodes:enroll')
  createEnrollment(@Body() dto: {
    mode?: 'single' | 'batch';
    tenantId?: string;
    managementUrl?: string;
    trustedDownloadHosts?: string[];
    heartbeatSeconds?: number;
    inventoryMinutes?: number;
    nodeProbeTimeoutMilliseconds?: number;
    clientName?: string;
    maxUses?: number;
  }, @CurrentUser() user: User) {
    const tenantId = clean(dto.tenantId) || 'default';
    const managementUrl = clean(dto.managementUrl);
    if (!managementUrl) throw new BadRequestException('managementUrl is required');

    const mode = dto.mode === 'batch' ? 'batch' : 'single';
    const trustedDownloadHosts = (dto.trustedDownloadHosts ?? [managementUrl]).map(clean).filter(Boolean);
    const heartbeatSeconds = positiveInt(dto.heartbeatSeconds, 60);
    const inventoryMinutes = positiveInt(dto.inventoryMinutes, 30);
    const nodeProbeTimeoutMilliseconds = positiveInt(dto.nodeProbeTimeoutMilliseconds, 2000);
    const maxUses = mode === 'batch' ? positiveInt(dto.maxUses, 1) : 1;
    if (maxUses > 10_000) throw new BadRequestException('Batch enrollment is limited to 10000 clients');
    const enrollmentToken = `client_${randomBytes(18).toString('hex')}`;
    const onePatch: Record<string, unknown> = {
      TenantId: tenantId,
      ManagementUrl: managementUrl,
      EnrollmentToken: enrollmentToken,
      TrustedSigningPublicKeys: this.signing.publicKeysForConfig(),
      TrustedDownloadHosts: trustedDownloadHosts.length ? trustedDownloadHosts : [managementUrl],
      HeartbeatSeconds: heartbeatSeconds,
      InventoryMinutes: inventoryMinutes,
      NodeProbeTimeoutMilliseconds: nodeProbeTimeoutMilliseconds,
    };

    const clientName = clean(dto.clientName);
    if (mode === 'single' && clientName) onePatch.ClientName = clientName;
    const config = { OnePatch: onePatch };
    this.store.clientEnrollments.push({
      id: uuid(),
      tenantId,
      mode,
      enrollmentTokenHash: bcrypt.hashSync(enrollmentToken, 12),
      maxUses,
      uses: 0,
      usedDeviceIds: [],
      clientName: mode === 'single' && clientName ? clientName : undefined,
      createdAt: new Date().toISOString(),
    });
    void this.store.persist();

    this.audit.record(user.id, 'device.enrollment_config_created', tenantId, {
      mode,
      reusable: mode === 'batch',
      maxUses,
      clientName: mode === 'single' ? clientName || undefined : undefined,
    });

    return {
      mode,
      tenantId,
      managementUrl,
      count: maxUses,
      remainingUses: maxUses,
      createdAt: new Date().toISOString(),
      enrollmentToken,
      config,
      oneLineJson: JSON.stringify(config),
      reusable: mode === 'batch',
    };
  }

  @Post('/:id/update-all-outdated')
  @RequirePermission('deployments:write')
  updateAllOutdated(@Param('id') id: string, @CurrentUser() user: User) {
    const device = this.store.devices.find((d) => d.id === id);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId);
    if (!node) throw new BadRequestException('No backend node is available for this device');

    // latest known version per app/publisher key from the entire fleet
    const latest = new Map<string, string>();
    for (const a of this.store.installedApps) {
      const k = `${a.name}|${a.publisher}`;
      const cur = latest.get(k);
      if (!cur || a.version.localeCompare(cur, undefined, { numeric: true }) > 0) latest.set(k, a.version);
    }

    const tasks: UpdateTask[] = [];
    for (const a of this.store.installedApps.filter((x) => x.deviceId === id)) {
      const want = latest.get(`${a.name}|${a.publisher}`);
      if (!want || want === a.version) continue;
      const task: UpdateTask = {
        id: uuid(), nodeId: node.id, deviceId: id, appName: a.name,
        packageId: safePackageId(a.packageId), productCode: a.productCode,
        targetVersion: 'latest', type: 'update_package',
        status: 'pending', createdAt: new Date().toISOString(),
      };
      this.store.tasks.push(task);
      tasks.push(task);
    }

    void this.store.persist();
    this.audit.record(user.id, 'device.update_all_outdated', id, { count: tasks.length });
    return { tasks };
  }
}

function clean(value?: string) {
  return (value ?? '').trim();
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safePackageId(value?: string) {
  const trimmed = clean(value);
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}
