import { Injectable } from '@nestjs/common';
import { MemoryStore } from '../storage/memory.store';

@Injectable()
export class AuditService {
  constructor(private readonly store: MemoryStore) {}

  record(actor: string, action: string, target?: string, metadata?: Record<string, unknown>) {
    return this.store.createAudit({ actor, action, target, metadata });
  }

  list() {
    return this.store.auditEvents;
  }
}
