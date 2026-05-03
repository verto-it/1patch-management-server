import { BadRequestException, Body, Controller, Get, Header, Logger, NotFoundException, Param, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { CurrentUser } from './security/current-user.decorator';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { NodeOrJwtGuard } from './security/node-or-jwt.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';
import { MemoryStore } from './storage/memory.store';
import { PackageArtifact, UpdateTask, User } from './types';
import { NodesService } from './nodes/nodes.service';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

interface PackageDto {
  name: string; publisher: string; version: string;
  architecture?: PackageArtifact['architecture'];
  platform?: PackageArtifact['platform'];
  type?: PackageArtifact['type'];
  packageId?: string; fileName?: string; fileBase64?: string;
  sourceUrl?: string; sha256?: string;
  signatureStatus?: PackageArtifact['signatureStatus'];
  installArgs?: string; uninstallArgs?: string;
  applicability?: PackageArtifact['applicability'];
}

@ApiTags('packages')
@Controller('/packages')
export class PackagesController {
  private readonly logger = new Logger(PackagesController.name);
  private readonly packageRoot = process.env.PACKAGE_STORAGE_PATH ?? join(process.cwd(), 'packages');

  constructor(private readonly store: MemoryStore, private readonly audit: AuditService, private readonly nodes: NodesService) {}

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('packages:read')
  @Get()
  list() {
    this.logger.debug(`Listing ${this.store.packages.length} package(s)`);
    return this.store.packages;
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('packages:write')
  @Post()
  async create(@Body() dto: PackageDto, @CurrentUser() user: User) {
    if (!dto.name || !dto.publisher || !dto.version)
      throw new BadRequestException('name, publisher, and version are required');

    this.logger.log(`Creating package: ${dto.name} v${dto.version} by ${dto.publisher}`);

    const id = uuid();
    let storagePath: string | undefined;
    let fileName = dto.fileName ? basename(dto.fileName) : undefined;
    let sha256 = dto.sha256;

    if (dto.fileBase64) {
      const file = Buffer.from(dto.fileBase64, 'base64');
      // FIX #18: enforce maximum upload size
      if (file.length > MAX_UPLOAD_BYTES) {
        this.logger.warn(`Package upload rejected — file too large (${file.length} bytes, max ${MAX_UPLOAD_BYTES})`);
        throw new BadRequestException(`Package file exceeds maximum allowed size of ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
      }
      await mkdir(this.packageRoot, { recursive: true });
      fileName = fileName ?? `${dto.name}-${dto.version}.bin`;
      sha256 = createHash('sha256').update(file).digest('hex');
      storagePath = join(this.packageRoot, `${id}-${fileName}`);
      await writeFile(storagePath, file);
      this.logger.log(`Package file saved to ${storagePath} (${file.length} bytes, sha256=${sha256})`);
    }

    const type = dto.type ?? 'msi';
    const isDownloadedPackage = type === 'msi' || !!storagePath || !!dto.sourceUrl;
    if (isDownloadedPackage && !sha256) throw new BadRequestException('sha256 is required for downloadable packages');
    const packageId = safePackageId(dto.packageId);
    if ((type === 'winget' || type === 'apt') && !packageId)
      throw new BadRequestException('packageId is required for winget and apt packages');

    const artifact: PackageArtifact = {
      id, name: dto.name, publisher: dto.publisher, version: dto.version,
      architecture: dto.architecture ?? 'x64', platform: dto.platform ?? 'windows',
      type, packageId, fileName, storagePath,
      sourceUrl: dto.sourceUrl ?? (storagePath ? `/packages/${id}/download` : undefined),
      sha256, signatureStatus: dto.signatureStatus ?? 'unknown',
      installArgs: dto.installArgs ?? '/qn /norestart', uninstallArgs: dto.uninstallArgs,
      applicability: dto.applicability ?? { appName: dto.name },
      createdAt: new Date().toISOString(),
    };
    this.store.packages.push(artifact);
    await this.store.persist();
    this.audit.record(user.id, 'package.created', artifact.id, { name: artifact.name, version: artifact.version, sha256: artifact.sha256 });
    this.logger.log(`Package created: id=${artifact.id} name=${artifact.name} v${artifact.version}`);
    return artifact;
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('packages:read')
  @Get('/:id')
  detail(@Param('id') id: string) {
    const artifact = this.findPackage(id);
    this.logger.debug(`Package detail requested: id=${id}`);
    return artifact;
  }

  @UseGuards(NodeOrJwtGuard)
  @Get('/:id/download')
  @Header('content-type', 'application/octet-stream')
  download(@Param('id') id: string) {
    const artifact = this.findPackage(id);
    if (!artifact.storagePath)
      throw new NotFoundException('Package file is not stored on this management server');
    this.logger.log(`Package download: id=${id} file=${artifact.fileName}`);
    return new StreamableFile(createReadStream(artifact.storagePath), {
      disposition: `attachment; filename="${artifact.fileName ?? artifact.id}"`,
    });
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/:id/deploy-device/:deviceId')
  async deployDevice(@Param('id') id: string, @Param('deviceId') deviceId: string, @CurrentUser() user: User) {
    this.logger.log(`Deploying package ${id} to device ${deviceId}`);
    return this.createDeploymentTask(this.findPackage(id), deviceId, user.id);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/:id/deploy-all')
  async deployAll(@Param('id') id: string, @CurrentUser() user: User) {
    const artifact = this.findPackage(id);
    const targets = [...new Set(
      this.store.installedApps
        .filter((app) => !artifact.applicability.appName || app.name.toLowerCase().includes(artifact.applicability.appName.toLowerCase()))
        .map((app) => app.deviceId)
    )];
    this.logger.log(`Deploying package ${id} to ${targets.length} device(s)`);
    return targets.map((deviceId) => this.createDeploymentTask(artifact, deviceId, user.id));
  }

  private createDeploymentTask(artifact: PackageArtifact, deviceId: string, actor = 'system') {
    const device = this.store.devices.find((d) => d.id === deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId);
    if (!node) throw new BadRequestException('No backend node is available for this device');
    const task: UpdateTask = {
      id: uuid(), nodeId: node.id, deviceId,
      appName: artifact.name, packageArtifactId: artifact.id,
      packageId: safePackageId(artifact.packageId), sourceUrl: artifact.sourceUrl,
      sha256: artifact.sha256, installArgs: artifact.installArgs,
      targetVersion: artifact.version, type: 'update_package',
      status: 'pending', createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    void this.store.persist();
    this.audit.record(actor, 'package.deployment_created', task.id, { packageId: artifact.id, deviceId });
    this.logger.log(`Deployment task created: taskId=${task.id} package=${artifact.name} device=${deviceId} node=${node.id}`);
    return task;
  }

  private findPackage(id: string) {
    const artifact = this.store.packages.find((p) => p.id === id);
    if (!artifact) throw new NotFoundException('Unknown package');
    return artifact;
  }
}

function safePackageId(value?: string) {
  const trimmed = (value ?? '').trim();
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}
