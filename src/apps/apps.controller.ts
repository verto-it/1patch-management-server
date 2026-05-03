import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { MemoryStore } from '../storage/memory.store';
import { UpdateTask } from '../types';
import { AdminApiGuard } from '../security/admin-api.guard';
import { NodesService } from '../nodes/nodes.service';

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
@UseGuards(AdminApiGuard)
@Controller('/apps')
export class AppsController {
  constructor(private readonly store: MemoryStore, private readonly audit: AuditService, private readonly nodes: NodesService) {}

  @Get()
  list(@Query('q') q?: string) {
    const apps = new Map<string, { id: string; name: string; publisher: string; deviceCount: number; versions: string[]; oldestVersion: string; latestVersion: string }>();
    for (const app of this.store.installedApps) {
      const key = `${app.name}|${app.publisher}`;
      const versions = apps.get(key)?.versions ?? [];
      const nextVersions = [...new Set([...versions, app.version])].sort(compareVersions);
      const current = apps.get(key) ?? {
        id: encodeURIComponent(key),
        name: app.name,
        publisher: app.publisher,
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
          (a) => `${a.name}|${a.publisher}` === `${app.name}|${app.publisher}` &&
            compareVersions(a.version, app.latestVersion) < 0,
        ).length,
      }));
  }

  @Get('/:name')
  detail(@Param('name') name: string) {
    const installed = this.store.installedApps.filter((app) => app.name.toLowerCase() === name.toLowerCase());
    return {
      name,
      installed,
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

  @Post('/:name/update-device')
  updateDevice(@Param('name') name: string, @Body() dto: CreateUpdateTaskDto) {
    return this.createTask(name, dto);
  }

  @Post('/:name/update-all')
  updateAll(@Param('name') name: string, @Body() dto: Omit<CreateUpdateTaskDto, 'deviceId'>) {
    const installed = this.store.installedApps.filter((app) => app.name.toLowerCase() === name.toLowerCase());
    const latestVersion = installed.map((app) => app.version).sort(compareVersions).at(-1);
    const outdated = latestVersion
      ? installed.filter((app) => compareVersions(app.version, latestVersion) < 0)
      : [];
    const tasks = outdated.map((app) => this.createTask(name, {
      ...dto,
      deviceId: app.deviceId,
      packageId: dto.packageId ?? safePackageId(app.packageId),
      productCode: dto.productCode ?? app.productCode,
    }));
    return { tasks };
  }

  private createTask(appName: string, dto: CreateUpdateTaskDto) {
    const device = this.store.devices.find((candidate) => candidate.id === dto.deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId);
    if (!node) throw new BadRequestException('No backend node is available for this device');
    const task: UpdateTask = {
      id: uuid(),
      nodeId: node.id,
      deviceId: dto.deviceId,
      appName,
      packageId: safePackageId(dto.packageId),
      productCode: dto.productCode,
      targetVersion: dto.targetVersion ?? 'latest',
      type: dto.type ?? 'update_package',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    void this.store.persist();
    this.audit.record('system', 'task.created', task.id, { ...task });
    return task;
  }
}

function compareVersions(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function safePackageId(value?: string) {
  const trimmed = (value ?? '').trim();
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}
