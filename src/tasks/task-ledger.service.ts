import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { canonicalJson } from '../signing.service';
import { SigningService } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import { TaskApproval, TaskLedgerEntry, UpdateTask } from '../types';
import { v4 as uuid } from 'uuid';

@Injectable()
export class TaskLedgerService {
  private readonly logger = new Logger(TaskLedgerService.name);

  /**
   * Creates a TaskLedgerService instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param signing signing supplied to the function.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly signing: SigningService,
  ) {}

  /** Compute the canonical hash of the task execution fields */
  static computeTaskHash(task: UpdateTask): string {
    const fields: Record<string, unknown> = {
      id: task.id,
      deviceId: task.deviceId,
      type: task.type,
      sourceUrl: task.sourceUrl ?? null,
      sha256: task.sha256 ?? null,
      installArgs: task.installArgs ?? null,
      targetVersion: task.targetVersion,
      packageId: task.packageId ?? null,
      productCode: task.productCode ?? null,
    };
    if (task.packageManager !== undefined) fields.packageManager = task.packageManager ?? null;
    if (task.packageScope !== undefined) fields.packageScope = task.packageScope ?? null;
    return createHash('sha256').update(canonicalJson(fields)).digest('hex');
  }

  static computeLegacyTaskHash(task: UpdateTask): string {
    const fields = {
      id: task.id,
      deviceId: task.deviceId,
      type: task.type,
      sourceUrl: task.sourceUrl ?? null,
      sha256: task.sha256 ?? null,
      installArgs: task.installArgs ?? null,
      targetVersion: task.targetVersion,
      packageId: task.packageId ?? null,
      productCode: task.productCode ?? null,
    };
    return createHash('sha256').update(canonicalJson(fields)).digest('hex');
  }

  /** Create and sign a new ledger entry. Only called after MFA approval. */
  create(
    task: UpdateTask,
    approvals: TaskApproval[],
    riskScore: number,
    notBefore: string,
    expiresAt: string,
  ): TaskLedgerEntry {
    const taskHash = TaskLedgerService.computeTaskHash(task);
    const tenantId = task.tenantId ?? 'default';
    const createdBy = task.createdBy ?? 'system';

    
    const unsigned = {
      ledgerId: uuid(),
      taskId: task.id,
      tenantId,
      createdBy,
      createdAt: new Date().toISOString(),
      visibleInDashboard: true as const,
      taskHash,
      riskScore,
      approvals,
      notBefore,
      expiresAt,
    };

    // Sign the ledger entry using the task_ledger scope
    const ttlSeconds = Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    const envelope = this.signing.signPayload('task_ledger', tenantId, unsigned, ttlSeconds);
    const entry: TaskLedgerEntry = {
      ...unsigned,
      algorithm: envelope.algorithm,
      scope: 'task_ledger',
      issuedAt: envelope.issuedAt,
      nonce: envelope.nonce,
      payloadHash: envelope.payloadHash,
      keyId: envelope.keyId,
      signature: envelope.signature,
      state: 'active',
    };

    this.store.taskLedger.push(entry);
    void this.store.persist();
    this.logger.log(`Ledger entry created: ledgerId=${entry.ledgerId} taskId=${task.id} riskScore=${riskScore}`);
    return entry;
  }

  /**
   * Finds the by task id record.
   *
   * @param taskId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  findByTaskId(taskId: string): TaskLedgerEntry | undefined {
    return this.store.taskLedger.find((e) => e.taskId === taskId);
  }

  /**
   * Finds the by id record.
   *
   * @param ledgerId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  findById(ledgerId: string): TaskLedgerEntry | undefined {
    return this.store.taskLedger.find((e) => e.ledgerId === ledgerId);
  }

  /**
   * Lists by tenant records for the caller.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  listByTenant(tenantId: string): TaskLedgerEntry[] {
    return this.store.taskLedger.filter((e) => e.tenantId === tenantId);
  }

  /**
   * Lists all records for the caller.
   * @returns The result produced by the operation.
   */
  listAll(): TaskLedgerEntry[] {
    return this.store.taskLedger;
  }

  /** Mark a ledger entry as revoked. Append-only — never deletes the record. */
  revoke(ledgerId: string, reason: string, revokedBy: string): TaskLedgerEntry {
    const entry = this.store.taskLedger.find((e) => e.ledgerId === ledgerId);
    if (!entry) throw new BadRequestException(`Ledger entry ${ledgerId} not found`);
    if (entry.state === 'revoked') throw new BadRequestException('Ledger entry is already revoked');
    entry.state = 'revoked';
    entry.revokedAt = new Date().toISOString();
    entry.revokedReason = reason;
    void this.store.persist();
    this.logger.warn(`Ledger entry revoked: ledgerId=${ledgerId} taskId=${entry.taskId} reason=${reason} by=${revokedBy}`);
    return entry;
  }

  /** Verify a ledger entry''s signature and hash integrity */
  verify(entry: TaskLedgerEntry, task: UpdateTask): { valid: boolean; reason?: string } {
    // 1. visibleInDashboard must be true
    if (!entry.visibleInDashboard) return { valid: false, reason: 'visibleInDashboard is not true' };

    // 2. Not revoked
    if (entry.state === 'revoked') return { valid: false, reason: 'Ledger entry is revoked' };

    // 3. Not expired
    if (Date.now() > new Date(entry.expiresAt).getTime()) return { valid: false, reason: 'Ledger entry is expired' };

    // 4. taskHash must match the actual task
    const expectedHash = TaskLedgerService.computeTaskHash(task);
    if (entry.taskHash !== expectedHash) {
      const canUseLegacyHash = task.packageManager === undefined && task.packageScope === undefined;
      const legacyHash = canUseLegacyHash ? TaskLedgerService.computeLegacyTaskHash(task) : undefined;
      if (entry.taskHash !== legacyHash) {
        return { valid: false, reason: `taskHash mismatch: ledger=${entry.taskHash} task=${expectedHash}` };
      }
    }

    // 5. Verify ECDSA signature
    try {
      const { signature, state, revokedAt, revokedReason, supersededBy, algorithm, scope, issuedAt, nonce, payloadHash, keyId, ...payload } = entry;
      this.signing.verifyDetachedSignature({
        expectedScope: 'task_ledger',
        tenantId: entry.tenantId,
        keyId,
        payload,
        signature,
        issuedAt,
        expiresAt: entry.expiresAt,
        nonce,
        payloadHash,
        algorithm,
      });
    } catch (err) {
      return { valid: false, reason: `Signature verification failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { valid: true };
  }
}
