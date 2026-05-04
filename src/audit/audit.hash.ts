import { createHash } from 'crypto';
import { AuditEvent } from '../types';

export function computeEventHash(
  event: Omit<AuditEvent, 'eventHash'>,
  previousHash?: string,
): string {
  const canonical = JSON.stringify({
    id: event.id,
    actor: event.actor,
    action: event.action,
    target: event.target,
    createdAt: event.createdAt,
    tenantId: event.tenantId,
    previousEventHash: previousHash ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

