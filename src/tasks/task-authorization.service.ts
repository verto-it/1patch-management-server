
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { MfaChallengeService } from '../auth/mfa-challenge.service';
import { SiemEventService } from '../siem/siem-event.service';
import { SigningService } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import {
  TaskApproval,
  TaskLedgerEntry,
  TaskStatus,
  TenantPolicy,
  UpdateTask,
  User,
} from '../types';
import { KillSwitchService } from './kill-switch.service';
import { NotificationService } from './notification.service';
import { SecurityGateService } from './security-gate.service';
import { TaskLedgerService } from './task-ledger.service';
import { TenantPolicyService } from './tenant-policy.service';
import { VirusTotalService } from './virustotal.service';

@Injectable()
export class TaskAuthorizationService {
  private readonly logger = new Logger(TaskAuthorizationService.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
    private readonly signing: SigningService,
    private readonly policy: TenantPolicyService,
    private readonly securityGate: SecurityGateService,
    private readonly virusTotal: VirusTotalService,
    private readonly ledger: TaskLedgerService,
    private readonly killSwitch: KillSwitchService,
    private readonly notifications: NotificationService,
    private readonly mfaChallenge: MfaChallengeService,
  ) {}

  // ── Step 1: Create draft ────────────────────────────────────────────────────

  createDraft(
    params: Pick<UpdateTask, 'nodeId' | 'deviceId' | 'tenantId' | 'type' | 'targetVersion' | 'appName' | 'packageArtifactId' | 'packageId' | 'productCode' | 'sourceUrl' | 'sha256' | 'installArgs'>,
    creator: User,
  ): UpdateTask {
    const task: UpdateTask = {
      ...params,
      id: uuid(),
      tenantId: params.tenantId ?? 'default',
      createdBy: creator.id,
      status: 'draft',
      approvals: [],
      createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    void this.store.persist();

    const tenantId = task.tenantId!;
    this.audit.record(creator.id, 'task.draft_created', task.id, { type: task.type, deviceId: task.deviceId }, tenantId);
    this.siem.emit({ tenantId, type: 'task.created', severity: 'low', actor: { userId: creator.id, nodeId: null, ip: null }, target: { taskId: task.id, deviceId: task.deviceId, nodeId: task.nodeId }, metadata: { taskType: task.type, appName: task.appName } });
    this.logger.log(`Task draft created: taskId=${task.id} type=${task.type} by=${creator.email}`);

    // Notify if new admin
    const isNewAdmin = creator.roles.some((r) => r === 'admin' || r === 'owner');
    if (isNewAdmin) {
      const userAge = creator.lastLoginAt ? Date.now() - new Date(creator.lastLoginAt).getTime() : Infinity;
      if (userAge < 7 * 24 * 3600_000) {
        this.notifications.notify(this.policy.get(tenantId).notificationConfig, {
          event: 'new_admin_task',
          tenantId,
          message: `New admin ${creator.email} created a task`,
          details: { taskId: task.id, createdBy: creator.id },
        });
      }
    }

    // Notify if outside business hours (8-18 UTC Mon-Fri)
    const hour = new Date().getUTCHours();
    const dow  = new Date().getUTCDay();
    if (hour < 8 || hour >= 18 || dow === 0 || dow === 6) {
      this.notifications.notify(this.policy.get(tenantId).notificationConfig, {
        event: 'task.outside_business_hours',
        tenantId,
        message: `Task created outside business hours by ${creator.email}`,
        details: { taskId: task.id },
      });
    }

    this.notifications.notify(this.policy.get(tenantId).notificationConfig, {
      event: 'task.created',
      tenantId,
      message: `Task ${task.id} (${task.type}) created by ${creator.email}`,
    });

    return task;
  }

  // ── Step 2: Security scan ───────────────────────────────────────────────────

  async runSecurityScan(taskId: string, actor: User): Promise<UpdateTask> {
    const task = this.requireTask(taskId);
    if (task.status !== 'draft') throw new BadRequestException(`Task must be in 'draft' to be scanned (current: ${task.status})`);

    const tenantId = task.tenantId ?? 'default';
    const p = this.policy.get(tenantId);
    const artifact = task.packageArtifactId
      ? this.store.packages.find((pkg) => pkg.id === task.packageArtifactId)
      : undefined;

    const deviceCount = 1; // single-device task for now
    const totalDevices = this.store.devices.filter((d) => d.tenantId === tenantId).length;
    const creator = this.store.users.find((u) => u.id === task.createdBy);
    const recentFailedLogins = creator?.failedAttempts ?? 0;

    const scanResult = await this.securityGate.scan(task, p, artifact, {
      deviceCount,
      totalDevices,
      adminCreatedAt: creator?.lastLoginAt,
      recentFailedLogins,
    });

    // Optional VirusTotal check
    if (task.sha256 && p.virusTotalApiKey) {
      const vtResult = await this.virusTotal.checkHash(task.sha256, p.virusTotalApiKey);
      scanResult.virusTotalResult = vtResult;
      if (!vtResult.available && (p.requireVirusTotalForStrict || p.requireVirusTotalForTinfoil)) {
        scanResult.hardBlock = true;
        scanResult.hardBlockReason = 'VirusTotal is required by tenant policy but is currently unavailable';
      }
    } else if ((p.requireVirusTotalForStrict && p.securityMode === 'strict') ||
               (p.requireVirusTotalForTinfoil && p.securityMode === 'tinfoil')) {
      if (!p.virusTotalApiKey) {
        scanResult.hardBlock = true;
        scanResult.hardBlockReason = 'VirusTotal is required by tenant policy but no API key is configured';
      }
    }

    task.securityScanResult = scanResult;
    task.status = 'security_scanned';
    void this.store.persist();

    this.audit.record(actor.id, 'task.security_scanned', taskId, {
      riskScore: scanResult.riskScore, severity: scanResult.severity, hardBlock: scanResult.hardBlock,
    }, tenantId);
    this.siem.emit({ tenantId, type: 'task.security_scan.completed', severity: (scanResult.riskScore >= 70 || scanResult.severity === 'high' || scanResult.severity === 'critical') ? 'high' : 'low', actor: { userId: actor.id, nodeId: null, ip: null }, target: { taskId, deviceId: task.deviceId, nodeId: task.nodeId }, metadata: { riskScore: scanResult.riskScore, severity: scanResult.severity, hardBlock: scanResult.hardBlock } });
    if (scanResult.riskScore >= 70 || scanResult.severity === 'high' || scanResult.severity === 'critical') { this.siem.emit({ tenantId, type: 'task.high_risk_detected', severity: 'high', actor: { userId: actor.id, nodeId: null, ip: null }, target: { taskId, deviceId: task.deviceId, nodeId: task.nodeId }, metadata: { riskScore: scanResult.riskScore, hardBlockReason: scanResult.hardBlockReason } }); }

    if (scanResult.riskScore >= 70 || scanResult.severity === 'high' || scanResult.severity === 'critical') {
      this.notifications.notify(p.notificationConfig, {
        event: 'task.high_risk',
        tenantId,
        message: `High-risk task detected: taskId=${taskId} riskScore=${scanResult.riskScore} severity=${scanResult.severity}`,
        details: { taskId, riskScore: scanResult.riskScore, hardBlockReason: scanResult.hardBlockReason },
      });
    }

    this.logger.log(`Security scan done: taskId=${taskId} riskScore=${scanResult.riskScore} hardBlock=${scanResult.hardBlock}`);
    return task;
  }

  // ── Step 3: MFA approval ────────────────────────────────────────────────────

  async approve(taskId: string, approver: User, mfaChallengeId: string): Promise<UpdateTask> {
    const task = this.requireTask(taskId);
    if (task.status !== 'security_scanned') {
      throw new BadRequestException(`Task must be 'security_scanned' before approval (current: ${task.status})`);
    }
    if (!task.securityScanResult) throw new BadRequestException('Task has no security scan result');
    if (task.securityScanResult.hardBlock) {
      throw new ForbiddenException(`Task has a hard block: ${task.securityScanResult.hardBlockReason}`);
    }

    const tenantId = task.tenantId ?? 'default';
    const p = this.policy.get(tenantId);

    if (p.requireMfaForTaskSigning) {
      if (!mfaChallengeId) throw new BadRequestException('mfaChallengeId is required for task approval');
      // Cryptographically verify and atomically consume the challenge (single-use)
      await this.mfaChallenge.consumeVerifiedChallenge(approver.id, mfaChallengeId);
    }

    // Prevent same user approving more than once
    const existing = (task.approvals ?? []).find((a) => a.approverUserId === approver.id);
    if (existing) throw new BadRequestException('You have already approved this task');

    const approval: TaskApproval = {
      approverUserId: approver.id,
      approvedAt: new Date().toISOString(),
      mfaChallengeId,
      approvalType: 'mfa_totp',
    };
    task.approvals = [...(task.approvals ?? []), approval];

    const required = this.policy.requiredApprovals(tenantId, task.securityScanResult.riskScore);
    const collected = task.approvals.length;
    this.logger.log(`Task approval recorded: taskId=${taskId} approver=${approver.email} ${collected}/${required}`);

    if (collected >= required) {
      task.status = 'mfa_approved';
      this.logger.log(`Task fully approved: taskId=${taskId} approvals=${collected}`);
    }

    void this.store.persist();
    this.audit.record(approver.id, 'task.approved', taskId, { mfaChallengeId, approvals: collected, required }, tenantId);
    this.siem.emit({ tenantId, type: 'task.approved', severity: 'low', actor: { userId: approver.id, nodeId: null, ip: null }, target: { taskId, deviceId: task.deviceId, nodeId: task.nodeId }, metadata: { approvals: collected, required } });

    this.notifications.notify(p.notificationConfig, {
      event: 'task.approved',
      tenantId,
      message: `Task ${taskId} approved by ${approver.email} (${collected}/${required})`,
    });

    return task;
  }

  // ── Step 4: Sign and write ledger ───────────────────────────────────────────

  sign(taskId: string, actor: User): { task: UpdateTask; ledgerEntry: TaskLedgerEntry } {
    const task = this.requireTask(taskId);
    if (task.status !== 'mfa_approved') {
      throw new BadRequestException(`Task must be 'mfa_approved' before signing (current: ${task.status})`);
    }

    const tenantId = task.tenantId ?? 'default';
    const p = this.policy.get(tenantId);
    const scan = task.securityScanResult!;

    // Enforce approval count one more time at signing
    const requiredApprovals = this.policy.requiredApprovals(tenantId, scan.riskScore);
    if ((task.approvals?.length ?? 0) < requiredApprovals) {
      throw new ForbiddenException(`Insufficient approvals: ${task.approvals?.length ?? 0}/${requiredApprovals}`);
    }

    // Compute task hash
    task.taskHash = TaskLedgerService.computeTaskHash(task);
    task.notBefore = this.policy.notBeforeFor(tenantId);

    // Create signed ledger entry
    const ledgerEntry = this.ledger.create(
      task,
      task.approvals!,
      scan.riskScore,
      task.notBefore,
      this.policy.expiresAtFor(tenantId),
    );

    task.ledgerEntryId = ledgerEntry.ledgerId;
    task.status = 'signed';
    void this.store.persist();

    this.audit.record(actor.id, 'task.signed', taskId, {
      ledgerId: ledgerEntry.ledgerId, taskHash: task.taskHash, notBefore: task.notBefore,
    }, tenantId);
    this.siem.emit({ tenantId, type: 'task.signed', severity: 'low', actor: { userId: actor.id, nodeId: null, ip: null }, target: { taskId, deviceId: task.deviceId, nodeId: task.nodeId }, metadata: { ledgerId: ledgerEntry.ledgerId, notBefore: task.notBefore } });

    this.notifications.notify(p.notificationConfig, {
      event: 'task.signed',
      tenantId,
      message: `Task ${taskId} signed and scheduled. Executable after ${task.notBefore}`,
      details: { ledgerId: ledgerEntry.ledgerId, notBefore: task.notBefore },
    });

    this.logger.log(`Task signed: taskId=${taskId} ledgerId=${ledgerEntry.ledgerId} notBefore=${task.notBefore}`);
    return { task, ledgerEntry };
  }

  // ── Step 5: Promote to executable ──────────────────────────────────────────

  /** Called at dispatch time — validates notBefore has passed and ledger is still valid */
  promoteToExecutable(taskId: string): UpdateTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'signed' && task.status !== 'scheduled') {
      throw new BadRequestException(`Task status '${task.status}' cannot be promoted to executable`);
    }

    const ledgerEntry = task.ledgerEntryId ? this.ledger.findById(task.ledgerEntryId) : undefined;
    if (!ledgerEntry) throw new ForbiddenException('Task has no signed ledger entry — cannot be executed');

    const integrity = this.ledger.verify(ledgerEntry, task);
    if (!integrity.valid) throw new ForbiddenException(`Ledger integrity check failed: ${integrity.reason}`);

    const now = Date.now();
    if (task.notBefore && now < new Date(task.notBefore).getTime()) {
      throw new ForbiddenException(`Task cannot be executed before ${task.notBefore}`);
    }

    task.status = 'executable';
    void this.store.persist();
    this.logger.log(`Task promoted to executable: taskId=${taskId}`);
    return task;
  }

  // ── Revoke ──────────────────────────────────────────────────────────────────

  revoke(taskId: string, reason: string, actor: User): UpdateTask {
    const task = this.requireTask(taskId);
    const tenantId = task.tenantId ?? 'default';

    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      throw new BadRequestException(`Cannot revoke a task with status '${task.status}'`);
    }

    if (task.ledgerEntryId) {
      this.ledger.revoke(task.ledgerEntryId, reason, actor.id);
    }

    task.status = 'revoked';
    task.completedAt = new Date().toISOString();
    void this.store.persist();

    this.audit.record(actor.id, 'task.revoked', taskId, { reason }, tenantId);
    this.siem.emit({ tenantId, type: 'task.revoked', severity: 'medium', actor: { userId: actor.id, nodeId: null, ip: null }, target: { taskId, deviceId: task.deviceId, nodeId: task.nodeId }, metadata: { reason } });
    this.logger.warn(`Task revoked: taskId=${taskId} reason=${reason} by=${actor.email}`);
    return task;
  }

  // ── Helper ──────────────────────────────────────────────────────────────────

  private requireTask(taskId: string): UpdateTask {
    const task = this.store.tasks.find((t) => t.id === taskId);
    if (!task) throw new BadRequestException(`Task ${taskId} not found`);
    return task;
  }
}
