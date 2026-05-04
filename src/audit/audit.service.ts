import { Injectable, Logger } from '@nestjs/common';
import { MemoryStore } from '../storage/memory.store';
import { computeEventHash } from './audit.hash';


@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly store: MemoryStore) {}

  record(
    actor: string,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
    tenantId?: string,
  ) {
    return this.store.createAudit({ actor, action, target, metadata, tenantId });
  }

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
