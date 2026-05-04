
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { MtlsNodeGuard } from '../security/mtls-node.guard';
import { NodeId } from '../security/node-id.decorator';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { SigningService } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import { Device, UpdateTask, User } from '../types';
import { NodesService } from '../nodes/nodes.service';
import { SiemEventService } from '../siem/siem-event.service';
import { KillSwitchService } from './kill-switch.service';
import { TaskAuthorizationService } from './task-authorization.service';
import { TaskLedgerService } from './task-ledger.service';
import { TenantPolicyService } from './tenant-policy.service';

@ApiTags('tasks')
@Controller('/tasks')
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
    private readonly nodes: NodesService,
    private readonly signing: SigningService,
    private readonly authorization: TaskAuthorizationService,
    private readonly ledger: TaskLedgerService,
    private readonly killSwitch: KillSwitchService,
    private readonly policy: TenantPolicyService,
  ) {}

  // ── Admin: list all tasks ──────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get()
  list() {
    return this.store.tasks;
  }

  // ── Admin: create draft ────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/draft')
  createDraft(
    @Body() body: {
      deviceId: string;
      type: 'update_package' | 'refresh_inventory';
      targetVersion?: string;
      appName?: string;
      packageArtifactId?: string;
      packageId?: string;
      productCode?: string;
      sourceUrl?: string;
      sha256?: string;
      installArgs?: string;
    },
    @CurrentUser() user: User,
  ) {
    const device = this.store.devices.find((d) => d.id === body.deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId);
    if (!node) throw new BadRequestException('No backend node is available for this device');

    return this.authorization.createDraft(
      {
        nodeId: node.id,
        deviceId: body.deviceId,
        tenantId: device.tenantId,
        type: body.type,
        targetVersion: body.targetVersion ?? 'latest',
        appName: body.appName,
        packageArtifactId: body.packageArtifactId,
        packageId: body.packageId,
        productCode: body.productCode,
        sourceUrl: body.sourceUrl,
        sha256: body.sha256,
        installArgs: body.installArgs,
      },
      user,
    );
  }

  // ── Legacy: refresh-inventory shortcut (creates draft + auto-scans for low-risk) ─

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/refresh-inventory/:deviceId')
  async refreshInventory(@Param('deviceId') deviceId: string, @CurrentUser() user: User) {
    const device = this.store.devices.find((d) => d.id === deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId);
    if (!node) throw new BadRequestException('No backend node is available for this device');

    const task = this.authorization.createDraft(
      { nodeId: node.id, deviceId, tenantId: device.tenantId, type: 'refresh_inventory', targetVersion: 'latest' },
      user,
    );

    // Auto-advance refresh_inventory through the pipeline (low-risk, no external packages)
    await this.authorization.runSecurityScan(task.id, user);
    this.authorization.approve(task.id, user, 'auto-refresh');
    this.authorization.sign(task.id, user);
    return this.authorization.promoteToExecutable(task.id);
  }

  // ── Step 2: Security scan ──────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Post('/:id/scan')
  async scan(@Param('id') id: string, @CurrentUser() user: User) {
    return this.authorization.runSecurityScan(id, user);
  }

  // ── Step 3: Approve ────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:approve')
  @Post('/:id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: { mfaChallengeId: string },
    @CurrentUser() user: User,
  ) {
    if (!body.mfaChallengeId) throw new BadRequestException('mfaChallengeId is required');
    return this.authorization.approve(id, user, body.mfaChallengeId);
  }

  // ── Step 4: Sign ───────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:sign')
  @Post('/:id/sign')
  sign(@Param('id') id: string, @CurrentUser() user: User) {
    return this.authorization.sign(id, user);
  }

  // ── Revoke ─────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Delete('/:id')
  revoke(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: User,
  ) {
    return this.authorization.revoke(id, body.reason ?? 'Cancelled by admin', user);
  }

  // ── Ledger ─────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/ledger')
  listLedger(@CurrentUser() user: User) {
    // Auditors and admins get the full ledger
    return this.ledger.listAll();
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/ledger/:ledgerId')
  getLedgerEntry(@Param('ledgerId') ledgerId: string) {
    const entry = this.ledger.findById(ledgerId);
    if (!entry) throw new BadRequestException('Ledger entry not found');
    return entry;
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Post('/ledger/:ledgerId/revoke')
  revokeLedgerEntry(
    @Param('ledgerId') ledgerId: string,
    @Body() body: { reason: string },
    @CurrentUser() user: User,
  ) {
    if (!body.reason) throw new BadRequestException('reason is required');
    const entry = this.ledger.revoke(ledgerId, body.reason, user.id);
    this.audit.record(user.id, 'ledger.revoked', ledgerId, { reason: body.reason }, entry.tenantId);
    return entry;
  }

  // ── Kill switch ────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('kill_switch:manage')
  @Post('/kill-switch/:tenantId/activate')
  activateKillSwitch(
    @Param('tenantId') tenantId: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: User,
  ) {
    return this.killSwitch.activate(tenantId, user, body.reason);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('kill_switch:manage')
  @Post('/kill-switch/:tenantId/deactivate')
  deactivateKillSwitch(@Param('tenantId') tenantId: string, @CurrentUser() user: User) {
    return this.killSwitch.deactivate(tenantId, user);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/kill-switch/:tenantId')
  getKillSwitch(@Param('tenantId') tenantId: string) {
    return this.killSwitch.getSignedState(tenantId);
  }

  // ── Tenant policy ──────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/policy/:tenantId')
  getPolicy(@Param('tenantId') tenantId: string) {
    return this.policy.get(tenantId);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:sign')
  @Put('/policy/:tenantId')
  updatePolicy(
    @Param('tenantId') tenantId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: User,
  ) {
    const updated = this.policy.set(tenantId, body as any);
    this.audit.record(user.id, 'policy.updated', tenantId, { patch: body }, tenantId);
    return updated;
  }

  // ── Node polls for executable tasks (mTLS authenticated) ──────────────────

  @UseGuards(MtlsNodeGuard)
  @Get('/node/:nodeId/pending')
  async pendingForNode(
    @NodeId() certNodeId: string,
    @Param('nodeId') paramNodeId: string,
  ) {
    if (certNodeId !== paramNodeId) {
      this.logger.warn(`Node ${certNodeId} attempted to poll tasks for different node ${paramNodeId}`);
      throw new BadRequestException('Certificate identity does not match requested nodeId');
    }

    const now = new Date().toISOString();

    // Promote signed tasks whose notBefore has passed
    const signedTasks = this.store.tasks.filter(
      (t) => t.nodeId === certNodeId && (t.status === 'signed' || t.status === 'scheduled'),
    );
    for (const t of signedTasks) {
      try { this.authorization.promoteToExecutable(t.id); } catch { /* not yet ready */ }
    }

    const tasks = this.store.tasks.filter(
      (t) => t.nodeId === certNodeId && (t.status === 'executable' || t.status === 'pending'),
    );

    for (const task of tasks) {
      // Backend nodes MUST NOT receive tasks without a valid ledger entry
      const tenantId = task.tenantId ?? tenantIdForTask(task, this.store.devices);
      const ledgerEntry = task.ledgerEntryId ? this.ledger.findById(task.ledgerEntryId) : undefined;
      if (!ledgerEntry || ledgerEntry.state !== 'active') {
        this.logger.warn(`Task ${task.id} has no active ledger entry — skipping dispatch`);
        continue;
      }

      // Check kill switch
      if (this.killSwitch.isActive(tenantId)) {
        this.logger.warn(`Kill switch active for tenant ${tenantId} — blocking dispatch of task ${task.id}`);
        continue;
      }

      task.status = 'dispatched';
      task.dispatchedAt = now;
    }

    const dispatchable = tasks.filter((t) => t.status === 'dispatched');
    void this.store.persist();

    if (dispatchable.length > 0) {
      this.audit.record(certNodeId, 'task.dispatched_to_node', certNodeId, { count: dispatchable.length });
      this.logger.log(`Dispatched ${dispatchable.length} task(s) to nodeId=${certNodeId}`);
    }

    // Sign each task bundle — nodes relay signed bundles only, never strip ledger data
    return {
      tasks: dispatchable.map((task) => {
        const tenantId = task.tenantId ?? tenantIdForTask(task, this.store.devices);
        const ledgerEntry = task.ledgerEntryId ? this.ledger.findById(task.ledgerEntryId) : undefined;
        return this.signing.signPayload(
          'task_bundle',
          tenantId,
          { tasks: [task], ledgerEntry: ledgerEntry ?? null },
          this.policy.get(tenantId).defaultTaskTtlSeconds,
        );
      }),
    };
  }

  // ── Node reports result (mTLS authenticated) ──────────────────────────────

  @UseGuards(MtlsNodeGuard)
  @Post('/result')
  result(
    @NodeId() nodeId: string,
    @Body() dto: { deviceId: string; taskId: string; status: 'completed' | 'failed' | 'rejected'; output?: string },
  ) {
    const task = this.store.tasks.find((t) => t.id === dto.taskId);
    if (!task) throw new BadRequestException('Unknown task');
    task.status = dto.status;
    task.output = dto.output;
    task.completedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(nodeId, `task.${dto.status}`, task.id, { output: dto.output });
    this.logger.log(`Task result: taskId=${dto.taskId} status=${dto.status} node=${nodeId}`);
    if (dto.status === 'failed' || dto.status === 'rejected') {
      this.store.alarms.unshift({
        id: uuid(),
        deviceId: dto.deviceId,
        severity: dto.status === 'failed' ? 'critical' : 'warning',
        message: `Task ${dto.status}: ${task.appName ?? task.type}`,
        createdAt: new Date().toISOString(),
        metadata: { taskId: task.id, output: dto.output },
      });
    }
    return task;
  }
}

function tenantIdForTask(task: UpdateTask, devices: Device[]): string {
  return (task.tenantId ?? devices.find((d) => d.id === task.deviceId)?.tenantId) ?? 'default';
}
