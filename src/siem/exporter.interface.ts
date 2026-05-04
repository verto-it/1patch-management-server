// AGPL-3.0-only
import { SiemEvent, SiemEventType, SiemMode } from '../types';

export interface EventExporter {
  readonly name: string;
  send(events: SiemEvent[]): Promise<void>;
  /** Optional: verify connectivity and credentials without sending real events */
  verify?(): Promise<{ ok: boolean; message: string }>;
}

/** Events that always export regardless of mode */
const CRITICAL_EVENTS = new Set<SiemEventType>([
  'kill_switch.activated',
  'kill_switch.deactivated',
  'signing_key.rotated',
  'signing_key.revoked',
  'audit.chain.broken',
  'invalid_signature_detected',
  'replay_attack_blocked',
  'task.high_risk_detected',
  'task.mass_rollout_detected',
]);

/** Events exported in standard + full modes */
const STANDARD_EVENTS = new Set<SiemEventType>([
  ...CRITICAL_EVENTS,
  'auth.login.failed',
  'auth.mfa.failed',
  'auth.login.success',
  'auth.mfa.success',
  'task.created',
  'task.approved',
  'task.signed',
  'task.executed',
  'task.failed',
  'task.revoked',
  'node.registered',
  'node.unhealthy',
  'node.certificate.issued',
  'node.certificate.revoked',
]);

export function filterEvents(
  events: SiemEvent[],
  mode: SiemMode,
  overrides: Partial<Record<SiemEventType, boolean>> = {},
): SiemEvent[] {
  return events.filter((event) => {
    const override = overrides[event.type];
    if (override !== undefined) return override;
    switch (mode) {
    case 'minimal':
      return CRITICAL_EVENTS.has(event.type);
    case 'standard':
      return STANDARD_EVENTS.has(event.type);
    case 'full':
      return true;
    }
  });
}
