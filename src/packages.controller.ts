import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { MemoryStore } from './storage/memory.store';
import { PackageArtifact, UpdateTask } from './types';
import { AdminApiGuard } from './security/admin-api.guard';

interface PackageDto {
  name: string;
  publisher: string;
  version: string;
  architecture?: PackageArtifact['architecture'];
  platform?: PackageArtifact['platform'];
  type?: PackageArtifact['type'];
  packageId?: string;
  fileName?: string;
  fileBase64?: string;
  sourceUrl?: string;
  sha256?: string;
  signatureStatus?: PackageArtifact['signatureStatus'];
  installArgs?: string;
  uninstallArgs?: string;
  applicability?: PackageArtifact['applicability'];
}

@ApiTags('packages')
@Controller('/packages')
export class PackagesController {
  private readonly packageRoot = process.env.PACKAGE_STORAGE_PATH ?? join(process.cwd(), 'packages');

  constructor(private readonly store: MemoryStore, private readonly audit: AuditService) {}

  @Get()
  @UseGuards(AdminApiGuard)
  list() {
    return this.store.packages;
  }

  @Post()
  @UseGuards(AdminApiGuard)
  async create(@Body() dto: PackageDto) {
    if (!dto.name || !dto.publisher || !dto.version) throw new BadRequestException('name, publisher, and version are required');
    const id = uuid();
    let storagePath: string | undefined;
    let fileName = dto.fileName ? basename(dto.fileName) : undefined;
    let sha256 = dto.sha256;

    if (dto.fileBase64) {
      await mkdir(this.packageRoot, { recursive: true });
      fileName = fileName ?? `${dto.name}-${dto.version}.bin`;
      const file = Buffer.from(dto.fileBase64, 'base64');
      sha256 = createHash('sha256').update(file).digest('hex');
      storagePath = join(this.packageRoot, `${id}-${fileName}`);
      await writeFile(storagePath, file);
    }

    if (!sha256) throw new BadRequestException('sha256 is required when no package file is uploaded');

    const artifact: PackageArtifact = {
      id,
      name: dto.name,
      publisher: dto.publisher,
      version: dto.version,
      architecture: dto.architecture ?? 'x64',
      platform: dto.platform ?? 'windows',
      type: dto.type ?? 'msi',
      packageId: dto.packageId,
      fileName,
      storagePath,
      sourceUrl: dto.sourceUrl ?? (storagePath ? `/packages/${id}/download` : undefined),
      sha256,
      signatureStatus: dto.signatureStatus ?? 'unknown',
      installArgs: dto.installArgs ?? '/qn /norestart',
      uninstallArgs: dto.uninstallArgs,
      applicability: dto.applicability ?? { appName: dto.name },
      createdAt: new Date().toISOString(),
    };
    this.store.packages.push(artifact);
    await this.store.persist();
    this.audit.record('system', 'package.created', artifact.id, { ...artifact, storagePath: undefined });
    return artifact;
  }

  @Get('/:id')
  @UseGuards(AdminApiGuard)
  detail(@Param('id') id: string) {
    const artifact = this.findPackage(id);
    return artifact;
  }

  @Get('/:id/download')
  @Header('content-type', 'application/octet-stream')
  download(@Param('id') id: string) {
    const artifact = this.findPackage(id);
    if (!artifact.storagePath) throw new NotFoundException('Package file is not stored on this management server');
    return new StreamableFile(createReadStream(artifact.storagePath), {
      disposition: `attachment; filename="${artifact.fileName ?? artifact.id}"`,
    });
  }

  @Post('/:id/deploy-device/:deviceId')
  @UseGuards(AdminApiGuard)
  async deployDevice(@Param('id') id: string, @Param('deviceId') deviceId: string) {
    return this.createDeploymentTask(this.findPackage(id), deviceId);
  }

  @Post('/:id/deploy-all')
  @UseGuards(AdminApiGuard)
  async deployAll(@Param('id') id: string) {
    const artifact = this.findPackage(id);
    const targets = this.store.installedApps
      .filter((app) => !artifact.applicability.appName || app.name.toLowerCase().includes(artifact.applicability.appName.toLowerCase()))
      .map((app) => app.deviceId);
    return [...new Set(targets)].map((deviceId) => this.createDeploymentTask(artifact, deviceId));
  }

  private createDeploymentTask(artifact: PackageArtifact, deviceId: string) {
    const device = this.store.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = device.preferredNodeId
      ? this.store.backendNodes.find((candidate) => candidate.id === device.preferredNodeId)
      : this.store.backendNodes.find((candidate) => candidate.status === 'online');
    if (!node) throw new BadRequestException('No backend node is available for this device');
    const task: UpdateTask = {
      id: uuid(),
      nodeId: node.id,
      deviceId,
      appName: artifact.name,
      packageArtifactId: artifact.id,
      packageId: artifact.packageId,
      sourceUrl: artifact.sourceUrl,
      sha256: artifact.sha256,
      installArgs: artifact.installArgs,
      targetVersion: artifact.version,
      type: 'update_package',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    void this.store.persist();
    this.audit.record('system', 'package.deployment_created', task.id, { packageArtifactId: artifact.id, deviceId });
    return task;
  }

  private findPackage(id: string) {
    const artifact = this.store.packages.find((candidate) => candidate.id === id);
    if (!artifact) throw new NotFoundException('Unknown package');
    return artifact;
  }
}
