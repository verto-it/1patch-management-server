import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { MemoryStore } from '../storage/memory.store';
import { UpdateTask, User } from '../types';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { NodesService } from '../nodes/nodes.service';
import { TaskAuthorizationService } from '../tasks/task-authorization.service';

class CreateUpdateTaskDto {
  @IsString()
  deviceId!: string;

  @IsOptional()
  @IsString()
  packageId?: string;

  @IsOptional()
  @IsString()
  productCode?: string;

  @IsOptional()
  @IsString()
  targetVersion?: string;

  @IsOptional()
  @IsIn(['update_package', 'refresh_inventory'])
  type?: 'update_package' | 'refresh_inventory';
}

@ApiTags('apps')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('apps:read')
@Controller('/apps')
export class AppsController {
  /**
   * Creates a AppsController instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param audit audit supplied to the function.
   * @param nodes nodes supplied to the function.
   * @param authorization authorization supplied to the function.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly nodes: NodesService,
    private readonly authorization: TaskAuthorizationService,
  ) {}

  /**
   * Lists list records for the caller.
   *
   * @param q Search query or filter supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Get()
  list(@Query('q') q?: string) {
    const apps = new Map<string, { id: string; name: string; publisher: string; platform: string; deviceCount: number; versions: string[]; oldestVersion: string; latestVersion: string }>();
    for (const app of this.store.installedApps) {
      const platform = devicePlatform(this.store.devices.find((device) => device.id === app.deviceId));
      const key = appKey(app, platform);
      const versions = apps.get(key)?.versions ?? [];
      const nextVersions = [...new Set([...versions, app.version])].sort(compareVersions);
      const current = apps.get(key) ?? {
        id: encodeURIComponent(key),
        name: app.name,
        publisher: app.publisher,
        platform,
        deviceCount: 0,
        versions: [],
        oldestVersion: app.version,
        latestVersion: app.version,
      };
      current.deviceCount += 1;
      current.versions = nextVersions;
      current.oldestVersion = nextVersions[0] ?? app.version;
      current.latestVersion = nextVersions[nextVersions.length - 1] ?? app.version;
      apps.set(key, current);
    }
    return [...apps.values()]
      .filter((app) => !q || `${app.name} ${app.publisher}`.toLowerCase().includes(q.toLowerCase()))
      .map((app) => ({
        ...app,
        outdatedDeviceCount: this.store.installedApps.filter(
          (a) => appKey(a, devicePlatform(this.store.devices.find((device) => device.id === a.deviceId))) === appKey(app, app.platform) &&
            compareVersions(a.version, app.latestVersion) < 0,
        ).length,
      }));
  }

  /**
   * Handles the detail operation for AppsController.
   *
   * @param name name supplied to the function.
   * @returns The result produced by the operation.
   */
  @Get('/:name')
  detail(@Param('name') name: string) {
    const installed = this.store.installedApps.filter((app) => app.name.toLowerCase() === name.toLowerCase());
    const latest = latestVersionsForStore(this.store);
    return {
      name,
      installed: installed.map((app) => {
        const platform = devicePlatform(this.store.devices.find((device) => device.id === app.deviceId));
        return { ...app, platform, latestVersion: latest.get(appKey(app, platform)) ?? app.version };
      }),
      devices: this.store.devices
        .filter((device) => installed.some((app) => app.deviceId === device.id))
        .map((device) => ({
          ...device,
          installedApp: installed.find((app) => app.deviceId === device.id),
          online: device.lastSeenAt ? Date.now() - new Date(device.lastSeenAt).getTime() < 2 * 60_000 : false,
        })),
      tasks: this.store.tasks.filter((task) => task.appName?.toLowerCase() === name.toLowerCase()),
    };
  }

  /**
   * Updates the device record or state.
   *
   * @param name name supplied to the function.
   * @param dto Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/:name/update-device')
  @RequirePermission('deployments:write')
  updateDevice(@Param('name') name: string, @Body() dto: CreateUpdateTaskDto, @CurrentUser() user: User) {
    return this.createTask(name, dto, user.id);
  }

  /**
   * Updates the all record or state.
   *
   * @param name name supplied to the function.
   * @param dto Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @Post('/:name/update-all')
  @RequirePermission('deployments:write')
  updateAll(@Param('name') name: string, @Body() dto: Omit<CreateUpdateTaskDto, 'deviceId'>, @CurrentUser() user: User) {
    const installed = this.store.installedApps.filter((app) => app.name.toLowerCase() === name.toLowerCase());
    const latest = latestVersionsForStore(this.store);
    const outdated = installed.filter((app) => {
      const platform = devicePlatform(this.store.devices.find((device) => device.id === app.deviceId));
      const latestVersion = latest.get(appKey(app, platform));
      return latestVersion ? compareVersions(app.version, latestVersion) < 0 : false;
    });
    const tasks = outdated.map((app) => this.createTask(name, {
      ...dto,
      deviceId: app.deviceId,
      packageId: dto.packageId ?? safePackageId(app.packageId),
      productCode: dto.productCode ?? app.productCode,
    }, user.id));
    return { tasks };
  }

  /**
   * Creates a task record.
   *
   * @param appName app name supplied to the function.
   * @param dto Request payload or data transfer object.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  private createTask(appName: string, dto: CreateUpdateTaskDto, actor = 'system') {
    const device = this.store.devices.find((candidate) => candidate.id === dto.deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId, device.tenantId, device);
    if (!node) throw new BadRequestException('No backend node is available for this device');
    const task: UpdateTask = {
      id: uuid(),
      nodeId: node.id,
      deviceId: dto.deviceId,
      tenantId: device.tenantId,
      appName,
      packageId: safePackageId(dto.packageId),
      productCode: dto.productCode,
      targetVersion: dto.targetVersion ?? 'latest',
      type: dto.type ?? 'update_package',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    this.authorization.autoSignTask(task, actor);
    this.audit.record(actor, 'task.created', task.id, { ...task });
    return task;
  }
}

/**
 * Handles the compare versions operation.
 *
 * @param left left supplied to the function.
 * @param right right supplied to the function.
 * @returns The result produced by the operation.
 */
function compareVersions(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Handles the safe package id operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function safePackageId(value?: string) {
  const trimmed = (value ?? '').trim();
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}

function latestVersionsForStore(store: MemoryStore) {
  const latest = new Map<string, string>();
  for (const app of store.installedApps) {
    const platform = devicePlatform(store.devices.find((device) => device.id === app.deviceId));
    const key = appKey(app, platform);
    const current = latest.get(key);
    if (!current || compareVersions(app.version, current) > 0) latest.set(key, app.version);
  }
  return latest;
}

function appKey(app: { name: string; publisher: string }, platform: string) {
  return `${platform}|${app.name}|${app.publisher}`;
}

function devicePlatform(device?: { os?: string }) {
  const os = device?.os ?? '';
  if (/(windows|win)/i.test(os)) return 'windows';
  if (/(linux|ubuntu|debian)/i.test(os)) return 'linux';
  return 'other';
}
