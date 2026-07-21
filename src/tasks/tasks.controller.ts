
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
import { MfaChallengeService } from '../auth/mfa-challenge.service';
import { TaskAuthorizationService } from './task-authorization.service';
import { TaskLedgerService } from './task-ledger.service';
import { TenantPolicyService } from './tenant-policy.service';

@ApiTags('tasks')
@Controller('/tasks')
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  /**
   * Creates a TasksController instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param audit audit supplied to the function.
   * @param siem siem supplied to the function.
   * @param nodes nodes supplied to the function.
   * @param signing signing supplied to the function.
   * @param authorization authorization supplied to the function.
   * @param ledger ledger supplied to the function.
   * @param killSwitch kill switch supplied to the function.
   * @param policy policy supplied to the function.
   * @param mfaChallenge mfa challenge supplied to the function.
   */
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
    private readonly mfaChallenge: MfaChallengeService,
  ) {}

  // ── Admin: list all tasks ──────────────────────────────────────────────────

  /**
   * Lists list records for the caller.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get()
  list() {
    return this.store.tasks;
  }

  // ── Admin: create draft ────────────────────────────────────────────────────

  /**
   * Creates a draft record.
   *
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
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
      packageManager?: UpdateTask['packageManager'];
      packageScope?: UpdateTask['packageScope'];
      productCode?: string;
      sourceUrl?: string;
      managementSourceUrl?: string;
      sha256?: string;
      installArgs?: string;
    },
    @CurrentUser() user: User,
  ) {
    const device = this.store.devices.find((d) => d.id === body.deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId, device.tenantId, device);
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
        packageManager: body.packageManager,
        packageScope: body.packageScope,
        productCode: body.productCode,
        sourceUrl: body.sourceUrl,
        managementSourceUrl: body.managementSourceUrl,
        sha256: body.sha256,
        installArgs: body.installArgs,
      },
      user,
    );
  }

  // ── Legacy: refresh-inventory shortcut (creates draft + auto-scans for low-risk) ─

  /**
   * Handles the refresh inventory operation for TasksController.
   *
   * @param deviceId Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/refresh-inventory/:deviceId')
  async refreshInventory(@Param('deviceId') deviceId: string, @CurrentUser() user: User) {
    const device = this.store.devices.find((d) => d.id === deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId, device.tenantId, device);
    if (!node) throw new BadRequestException('No backend node is available for this device');

    const task = this.authorization.createDraft(
      { nodeId: node.id, deviceId, tenantId: device.tenantId, type: 'refresh_inventory', targetVersion: 'latest' },
      user,
    );

    // Auto-advance refresh_inventory through the pipeline (low-risk, no external packages).
    // When the tenant requires MFA this is a no-op and the task stays at
    // `security_scanned` for manual approval; otherwise it is signed automatically.
    await this.authorization.runSecurityScan(task.id, user);
    return this.authorization.autoFinalizeAfterScan(task.id, user);
  }

  // -- MFA challenge: issue
  /**
   * Handles the issue mfa challenge operation for TasksController.
   *
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:approve')
  @Post('/mfa-challenge/issue')
  async issueMfaChallenge(@CurrentUser() user: User) {
    const challengeId = await this.mfaChallenge.issueChallenge(user.id);
    return { challengeId };
  }

  // -- MFA challenge: verify (submit TOTP code; verified challengeId is single-use for 2 min)
  /**
   * Validates mfa challenge rules.
   *
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:approve')
  @Post('/mfa-challenge/verify')
  async verifyMfaChallenge(
    @Body() body: { challengeId: string; totpCode: string },
    @CurrentUser() user: User,
  ) {
    if (!body.challengeId || !body.totpCode) throw new BadRequestException('challengeId and totpCode are required');
    await this.mfaChallenge.verifyChallenge(user.id, body.challengeId, body.totpCode);
    return { verified: true };
  }

    // ── Step 2: Security scan ──────────────────────────────────────────────────

  /**
   * Handles the scan operation for TasksController.
   *
   * @param id Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Post('/:id/scan')
  async scan(@Param('id') id: string, @CurrentUser() user: User) {
    return this.authorization.runSecurityScan(id, user);
  }

  // ── Step 3: Approve ────────────────────────────────────────────────────────

  /**
   * Handles the approve operation for TasksController.
   *
   * @param id Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:approve')
  @Post('/:id/approve')
  async approve(
    @Param('id') id: string,
    @Body() body: { mfaChallengeId?: string },
    @CurrentUser() user: User,
  ) {
    return this.authorization.approve(id, user, body.mfaChallengeId ?? '');
  }

  // ── Step 4: Sign ───────────────────────────────────────────────────────────

  /**
   * Produces the sign security value.
   *
   * @param id Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:sign')
  @Post('/:id/sign')
  sign(@Param('id') id: string, @CurrentUser() user: User) {
    return this.authorization.sign(id, user);
  }

  // ── Revoke ─────────────────────────────────────────────────────────────────

  /**
   * Handles the revoke operation for TasksController.
   *
   * @param id Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
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

  /**
   * Lists ledger records for the caller.
   *
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/ledger')
  listLedger(@CurrentUser() user: User) {
    // Auditors and admins get the full ledger
    return this.ledger.listAll();
  }

  /**
   * Gets the ledger entry value.
   *
   * @param ledgerId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/ledger/:ledgerId')
  getLedgerEntry(@Param('ledgerId') ledgerId: string) {
    const entry = this.ledger.findById(ledgerId);
    if (!entry) throw new BadRequestException('Ledger entry not found');
    return entry;
  }

  /**
   * Handles the revoke ledger entry operation for TasksController.
   *
   * @param ledgerId Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
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

  /**
   * Changes the kill switch state.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
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

  /**
   * Changes the kill switch state.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('kill_switch:manage')
  @Post('/kill-switch/:tenantId/deactivate')
  deactivateKillSwitch(@Param('tenantId') tenantId: string, @CurrentUser() user: User) {
    return this.killSwitch.deactivate(tenantId, user);
  }

  /**
   * Gets the kill switch value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/kill-switch/:tenantId')
  getKillSwitch(@Param('tenantId') tenantId: string) {
    return this.killSwitch.getSignedState(tenantId);
  }

  // ── Tenant policy ──────────────────────────────────────────────────────────

  /**
   * Gets the policy value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get('/policy/:tenantId')
  getPolicy(@Param('tenantId') tenantId: string) {
    return publicTenantPolicy(this.policy.get(tenantId));
  }

  /**
   * Updates the policy record or state.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param body Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:sign')
  @Put('/policy/:tenantId')
  updatePolicy(
    @Param('tenantId') tenantId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: User,
  ) {
    const updated = this.policy.set(tenantId, body as any);
    const auditPatch = { ...body };
    if ('virusTotalApiKey' in auditPatch) auditPatch.virusTotalApiKey = '[redacted]';
    this.audit.record(user.id, 'policy.updated', tenantId, { patch: auditPatch }, tenantId);
    return publicTenantPolicy(updated);
  }

  // ── Node polls for executable tasks (mTLS authenticated) ──────────────────

  /**
   * Handles the pending for node operation for TasksController.
   *
   * @param certNodeId Identifier used to locate the target record.
   * @param paramNodeId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
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
    const STALE_DISPATCH_MS = 5 * 60 * 1000; // 5 minutes

    // Recover stale dispatched tasks (client crashed before reporting result)
    const staleDispatched = this.store.tasks.filter(
      (t) =>
        t.nodeId === certNodeId &&
        t.status === 'dispatched' &&
        t.dispatchedAt != null &&
        Date.now() - new Date(t.dispatchedAt).getTime() > STALE_DISPATCH_MS,
    );
    for (const t of staleDispatched) {
      this.logger.warn(
        `Task ${t.id} stuck in dispatched since ${t.dispatchedAt} with no result — resetting to executable for retry`,
      );
      t.status = 'executable';
      t.dispatchedAt = undefined;
    }
    if (staleDispatched.length > 0) {
      this.audit.record(certNodeId, 'task.stale_dispatch_reset', certNodeId, { count: staleDispatched.length });
      void this.store.persist();
    }

    // Promote signed tasks whose notBefore has passed
    const signedTasks = this.store.tasks.filter(
      (t) => t.status === 'signed' || t.status === 'scheduled',
    );
    for (const t of signedTasks) {
      try { this.authorization.promoteToExecutable(t.id); } catch { /* not yet ready */ }
    }

    // Route-at-dispatch: if a task's assigned node is stale, unhealthy, draining,
    // under maintenance, or quarantined, re-evaluate policy and move it before
    // any node sees the signed bundle.
    const routable = this.store.tasks.filter((t) => t.status === 'executable' || t.status === 'pending');
    for (const task of routable) {
      const device = this.store.devices.find((candidate) => candidate.id === task.deviceId);
      const assigned = this.store.backendNodes.find((node) => node.id === task.nodeId);
      const assignedUnavailable =
        !assigned ||
        assigned.status !== 'online' ||
        assigned.quarantineState === 'quarantined' ||
        assigned.maintenanceState === 'maintenance' ||
        assigned.maintenanceState === 'draining' ||
        assigned.healthState === 'unhealthy' ||
        assigned.healthState === 'quarantined';
      if (!assignedUnavailable && task.nodeId === certNodeId) continue;
      if (!assignedUnavailable) continue;
      const replacement = this.nodes.availableNode(device?.preferredNodeId, task.tenantId ?? device?.tenantId ?? 'default', device, task.requiredCapabilities);
      if (replacement && replacement.id !== task.nodeId) {
        const previousNodeId = task.nodeId;
        task.nodeId = replacement.id;
        this.audit.record('system:router', 'task.failover_reassigned', task.id, { previousNodeId, nextNodeId: replacement.id });
      }
    }

    const tasks = this.store.tasks.filter(
      (t) => t.nodeId === certNodeId && (t.status === 'executable' || t.status === 'pending'),
    );

    for (const task of tasks) {
      // Backend nodes MUST NOT receive tasks without a valid ledger entry.
      // Tasks created outside the authorization pipeline have no ledgerEntryId — auto-sign them.
      if (!task.ledgerEntryId) {
        try {
          this.authorization.autoSignTask(task, 'system:dispatch');
          this.authorization.promoteToExecutable(task.id);
        } catch (err) {
          this.logger.warn(`Task ${task.id} could not be auto-signed — skipping dispatch: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }

      const tenantId = task.tenantId ?? tenantIdForTask(task, this.store.devices);
      const ledgerEntry = task.ledgerEntryId ? this.ledger.findById(task.ledgerEntryId) : undefined;
      if (!ledgerEntry || ledgerEntry.state !== 'active') {
        this.logger.warn(`Task ${task.id} ledger entry ${task.ledgerEntryId} is ${ledgerEntry?.state ?? 'missing'} — skipping dispatch`);
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
          {
            tasks: [task],
            ledgerEntry: ledgerEntry ?? null,
            policyMetadata: {
              tenantId,
              requiredCapabilities: task.requiredCapabilities ?? [],
              routingPolicyId: task.routingPolicyId,
            },
            targetScope: { deviceIds: [task.deviceId], nodeId: certNodeId },
            integrityHashes: {
              taskHash: task.taskHash,
              ledgerHash: ledgerEntry?.payloadHash,
              packageSha256: task.sha256,
            },
          },
          this.policy.get(tenantId).defaultTaskTtlSeconds,
        );
      }),
    };
  }

  // ── Node reports result (mTLS authenticated) ──────────────────────────────

  /**
   * Handles the result operation for TasksController.
   *
   * @param nodeId Identifier used to locate the target record.
   * @param dto Request payload or data transfer object.
   * @returns The result produced by the operation.
   */
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

/**
 * Handles the tenant id for task operation.
 *
 * @param task task supplied to the function.
 * @param devices devices supplied to the function.
 * @returns The result produced by the operation.
 */
function tenantIdForTask(task: UpdateTask, devices: Device[]): string {
  return (task.tenantId ?? devices.find((d) => d.id === task.deviceId)?.tenantId) ?? 'default';
}

function publicTenantPolicy<T extends { virusTotalApiKey?: string }>(policy: T) {
  return {
    ...policy,
    virusTotalApiKey: policy.virusTotalApiKey ? '********' : '',
    virusTotalConfigured: Boolean(policy.virusTotalApiKey),
  };
}
