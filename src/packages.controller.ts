import { BadRequestException, Body, Controller, Get, Header, Logger, NotFoundException, Param, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { PackageCatalogService } from './package-catalog.service';
import { CurrentUser } from './security/current-user.decorator';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { NodeOrJwtGuard } from './security/node-or-jwt.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';
import { MemoryStore } from './storage/memory.store';
import { PackageArtifact, UpdateTask, User } from './types';
import { NodesService } from './nodes/nodes.service';
import { TaskAuthorizationService } from './tasks/task-authorization.service';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

interface PackageDto {
  name: string; publisher: string; version: string;
  architecture?: PackageArtifact['architecture'];
  platform?: PackageArtifact['platform'];
  type?: PackageArtifact['type'];
  packageId?: string; packageManager?: PackageArtifact['packageManager']; packageScope?: PackageArtifact['packageScope']; fileName?: string; fileBase64?: string;
  sourceUrl?: string; sha256?: string;
  signatureStatus?: PackageArtifact['signatureStatus'];
  installArgs?: string; uninstallArgs?: string;
  applicability?: PackageArtifact['applicability'];
  catalogCategory?: string;
}

@ApiTags('packages')
@Controller('/packages')
export class PackagesController {
  private readonly logger = new Logger(PackagesController.name);
  private readonly packageRoot = process.env.PACKAGE_STORAGE_PATH ?? join(process.cwd(), 'packages');

  /**
   * Creates a PackagesController instance with its required collaborators.
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
    private readonly catalog: PackageCatalogService,
  ) {}

  /**
   * Lists list records for the caller.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('packages:read')
  @Get()
  list() {
    this.logger.debug(`Listing ${this.store.packages.length} package(s)`);
    return this.store.packages;
  }

  /**
   * Creates a create record.
   *
   * @param dto Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('packages:write')
  @Post()
  async create(@Body() dto: PackageDto, @CurrentUser() user: User) {
    if (!dto.name || !dto.publisher || !dto.version)
      throw new BadRequestException('name, publisher, and version are required');

    this.logger.log(`Creating package: ${dto.name} v${dto.version} by ${dto.publisher}`);

    const id = uuid();
    const type = dto.type ?? 'msi';
    const platform = dto.platform ?? (isLinuxPackageManager(type) ? 'linux' : 'windows');
    if (isLinuxPackageManager(type)) {
      if (platform !== 'linux') throw new BadRequestException(`${type} packages must use platform=linux`);
      if (dto.fileBase64 || dto.fileName || dto.sourceUrl || dto.sha256)
        throw new BadRequestException(`${type} packages are repo-managed in v1 and must not include uploaded files, sourceUrl, or sha256`);
      if (clean(dto.installArgs)) throw new BadRequestException(`installArgs are not supported for ${type} repo packages`);
    } else if ((type === 'winget' || type === 'chocolatey' || type === 'scoop') && platform !== 'windows') {
      throw new BadRequestException(`${type} packages must use platform=windows`);
    } else if ((type === 'msi' || type === 'exe') && platform !== 'windows') {
      throw new BadRequestException(`${type} packages must use platform=windows`);
    }

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

    const isDownloadedPackage = type === 'msi' || type === 'exe' || !!storagePath || !!dto.sourceUrl;
    if (isDownloadedPackage && !sha256) throw new BadRequestException('sha256 is required for downloadable packages');
    const packageId = isLinuxPackageManager(type) ? linuxPackageId(type, dto.packageId) : safePackageId(dto.packageId);
    if ((type === 'winget' || isLinuxPackageManager(type) || type === 'chocolatey' || type === 'scoop') && !packageId)
      throw new BadRequestException('packageId is required for package-manager artifacts');
    if (dto.packageManager && dto.packageManager !== type)
      throw new BadRequestException('packageManager must match package type');
    const packageManager = dto.packageManager ?? type;
    const packageScope = dto.packageScope ?? (type === 'scoop' ? 'global' : 'system');

    const artifact: PackageArtifact = {
      id, name: dto.name, publisher: dto.publisher, version: dto.version,
      architecture: dto.architecture ?? 'x64', platform,
      type, packageId, packageManager, packageScope, fileName, storagePath,
      sourceUrl: dto.sourceUrl ?? (storagePath ? `/packages/${id}/download` : undefined),
      sha256, signatureStatus: dto.signatureStatus ?? 'unknown',
      installArgs: isDownloadedPackage ? (dto.installArgs ?? defaultInstallArgs(type)) : (dto.installArgs ?? ''), uninstallArgs: dto.uninstallArgs,
      applicability: dto.applicability ?? { appName: dto.name },
      catalogSource: 'custom',
      catalogCategory: dto.catalogCategory,
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
  @Get('/catalog')
  listCatalog() {
    return this.catalog.getCatalog();
  }

  /**
   * Handles the detail operation for PackagesController.
   *
   * @param id Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('packages:read')
  @Get('/:id')
  detail(@Param('id') id: string) {
    const artifact = this.findPackage(id);
    this.logger.debug(`Package detail requested: id=${id}`);
    return artifact;
  }

  /**
   * Handles the download operation for PackagesController.
   *
   * @param id Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
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

  /**
   * Handles the deploy device operation for PackagesController.
   *
   * @param id Identifier used to locate the target record.
   * @param deviceId Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/:id/deploy-device/:deviceId')
  async deployDevice(@Param('id') id: string, @Param('deviceId') deviceId: string, @CurrentUser() user: User) {
    this.logger.log(`Deploying package ${id} to device ${deviceId}`);
    return this.createDeploymentTask(this.findPackage(id), deviceId, user.id);
  }

  /**
   * Handles the deploy all operation for PackagesController.
   *
   * @param id Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/:id/deploy-all')
  async deployAll(@Param('id') id: string, @CurrentUser() user: User) {
    const artifact = this.findPackage(id);
    const candidateTargets = [...new Set(
      this.store.installedApps
        .filter((app) => !artifact.applicability.appName || app.name.toLowerCase().includes(artifact.applicability.appName.toLowerCase()))
        .map((app) => app.deviceId)
    )];
    const targets = candidateTargets.filter((deviceId) => {
      const device = this.store.devices.find((candidate) => candidate.id === deviceId);
      return device && packageMatchesDevice(artifact, device);
    });
    this.logger.log(`Deploying package ${id} to ${targets.length} device(s)`);
    return {
      tasks: targets.map((deviceId) => this.createDeploymentTask(artifact, deviceId, user.id)),
      skippedDeviceCount: candidateTargets.length - targets.length,
    };
  }

  /**
   * Creates a deployment task record.
   *
   * @param artifact artifact supplied to the function.
   * @param deviceId Identifier used to locate the target record.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  private createDeploymentTask(artifact: PackageArtifact, deviceId: string, actor = 'system') {
    const device = this.store.devices.find((d) => d.id === deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    if (!packageMatchesDevice(artifact, device)) {
      throw new BadRequestException(`${artifact.platform} package '${artifact.name}' cannot be deployed to ${devicePlatform(device)} device '${device.hostname}'`);
    }
    const node = this.nodes.availableNode(device.preferredNodeId, device.tenantId, device, requiredCapabilitiesForArtifact(artifact));
    if (!node) throw new BadRequestException('No backend node is available for this device');
    const task: UpdateTask = {
      id: uuid(), nodeId: node.id, deviceId,
      tenantId: device.tenantId,
      appName: artifact.name, packageArtifactId: artifact.id,
      packageId: linuxPackageId(artifact.type, artifact.packageId) ?? safePackageId(artifact.packageId),
      packageManager: artifact.packageManager ?? artifact.type,
      packageScope: artifact.packageScope,
      sourceUrl: proxiedSourceUrl(artifact, node),
      managementSourceUrl: artifact.sourceUrl,
      sha256: artifact.sha256, installArgs: artifact.installArgs,
      requiredCapabilities: requiredCapabilitiesForArtifact(artifact),
      targetVersion: artifact.version, type: 'update_package',
      status: 'pending', createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    this.authorization.autoSignTask(task, actor);
    this.audit.record(actor, 'package.deployment_created', task.id, { packageId: artifact.id, deviceId });
    this.logger.log(`Deployment task created: taskId=${task.id} package=${artifact.name} device=${deviceId} node=${node.id}`);
    return task;
  }

  /**
   * Finds the package record.
   *
   * @param id Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  private findPackage(id: string) {
    const artifact = this.store.packages.find((p) => p.id === id);
    if (!artifact) throw new NotFoundException('Unknown package');
    return artifact;
  }
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

function safeAptPackageId(value?: string) {
  const trimmed = clean(value);
  return /^[a-z0-9][a-z0-9+.-]*$/.test(trimmed) ? trimmed : undefined;
}

function safeFlatpakPackageId(value?: string) {
  const trimmed = clean(value);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) && trimmed.includes('.') ? trimmed : undefined;
}

function isLinuxPackageManager(value?: string): value is 'apt' | 'snap' | 'flatpak' {
  return value === 'apt' || value === 'snap' || value === 'flatpak';
}

function linuxPackageId(type: PackageArtifact['type'], value?: string) {
  if (type === 'apt' || type === 'snap') return safeAptPackageId(value);
  if (type === 'flatpak') return safeFlatpakPackageId(value);
  return undefined;
}

function packageMatchesDevice(artifact: PackageArtifact, device: { os?: string }) {
  return artifact.platform === devicePlatform(device);
}

function requiredCapabilitiesForArtifact(artifact: PackageArtifact) {
  if (artifact.platform === 'linux') return ['linux-patching' as const];
  if (artifact.type === 'winget') return ['windows-patching' as const, 'winget-cache' as const];
  if (artifact.type === 'chocolatey') return ['windows-patching' as const, 'chocolatey-cache' as const];
  return ['windows-patching' as const];
}

function proxiedSourceUrl(artifact: PackageArtifact, node: { publicUrl?: string }) {
  if (!artifact.sourceUrl || !artifact.sha256) return artifact.sourceUrl;
  const base = clean(node.publicUrl).replace(/\/$/, '');
  if (!base) return artifact.sourceUrl;
  return `${base}/packages/cache/${encodeURIComponent(artifact.id)}`;
}

function devicePlatform(device: { os?: string }) {
  const os = device.os ?? '';
  if (/(windows|win)/i.test(os)) return 'windows';
  if (/(linux|ubuntu|debian)/i.test(os)) return 'linux';
  return 'other';
}

function clean(value?: string) {
  return (value ?? '').trim();
}

function defaultInstallArgs(type: PackageArtifact['type']) {
  return type === 'exe' ? '/quiet /norestart' : '/qn /norestart';
}
