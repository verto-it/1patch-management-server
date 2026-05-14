import { Injectable, Logger } from '@nestjs/common';
import { MemoryStore } from '../storage/memory.store';
import { computeEventHash } from './audit.hash';


@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /**
   * Creates a AuditService instance with its required collaborators.
   *
   * @param store store supplied to the function.
   */
  constructor(private readonly store: MemoryStore) {}

  /**
   * Handles the record operation for AuditService.
   *
   * @param actor actor supplied to the function.
   * @param action action supplied to the function.
   * @param target target supplied to the function.
   * @param metadata metadata supplied to the function.
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  record(
    actor: string,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
    tenantId?: string,
  ) {
    return this.store.createAudit({ actor, action, target, metadata, tenantId });
  }

  /**
   * Lists list records for the caller.
   * @returns The result produced by the operation.
   */
  list() {
    return this.store.auditEvents;
  }

  /** Verify the hash chain integrity of all stored audit events.
   *  Returns { valid: true } if the chain is intact, or details of the first broken link. */
  verifyChain(): { valid: boolean; brokenAt?: string; reason?: string } {
    const events = [...this.store.auditEvents].reverse(); // oldest first
    let previousHash: string | undefined;
    for (const event of events) {
      const expectedEventHash = computeEventHash(event, previousHash);
      if (event.eventHash && event.eventHash !== expectedEventHash) {
        return {
          valid: false,
          brokenAt: event.id,
          reason: `eventHash mismatch: stored=${event.eventHash} computed=${expectedEventHash}`,
        };
      }
      if (previousHash !== undefined && event.previousEventHash !== previousHash) {
        return {
          valid: false,
          brokenAt: event.id,
          reason: `previousEventHash mismatch: stored=${event.previousEventHash} expected=${previousHash}`,
        };
      }
      previousHash = event.eventHash ?? expectedEventHash;
    }
    return { valid: true };
  }
}
