import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { NodesService } from '../nodes/nodes.service';
import { SiemEventService } from '../siem/siem-event.service';
import { SigningService } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import { KillSwitchState, User } from '../types';
import { NotificationService } from './notification.service';
import { TenantPolicyService } from './tenant-policy.service';

@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger(KillSwitchService.name);

  /**
   * Creates a KillSwitchService instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param signing signing supplied to the function.
   * @param audit audit supplied to the function.
   * @param siem siem supplied to the function.
   * @param notifications notifications supplied to the function.
   * @param policy policy supplied to the function.
   * @param nodes nodes supplied to the function.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly signing: SigningService,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
    private readonly notifications: NotificationService,
    private readonly policy: TenantPolicyService,
    private readonly nodes: NodesService,
  ) {}

  /**
   * Gets the state value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  getState(tenantId: string): KillSwitchState | undefined {
    return this.store.killSwitchStates.find((s) => s.tenantId === tenantId) ??
           this.store.killSwitchStates.find((s) => s.tenantId === 'global');
  }

  /**
   * Handles the is active operation for KillSwitchService.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  isActive(tenantId: string): boolean {
    const state = this.getState(tenantId);
    return state?.active === true;
  }

  
  /**
   * Gets the signed state value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  getSignedState(tenantId: string): { state: KillSwitchState; envelope: ReturnType<SigningService['signPayload']> } | null {
    const state = this.getState(tenantId);
    if (!state) return null;
    const envelope = this.signing.signPayload('kill_switch', tenantId, state);
    return { state, envelope };
  }

  /**
   * Changes the activate state.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param actor actor supplied to the function.
   * @param reason reason supplied to the function.
   * @returns The result produced by the operation.
   */
  activate(tenantId: string, actor: User, reason?: string): KillSwitchState {
    const existing = this.store.killSwitchStates.find((s) => s.tenantId === tenantId);
    const now = new Date().toISOString();

    const unsigned = {
      id: existing?.id ?? uuid(),
      tenantId,
      active: true,
      activatedAt: now,
      activatedBy: actor.id,
      reason,
      keyId: '', // filled after signing
    };
    const envelope = this.signing.signPayload('kill_switch', tenantId, unsigned);

    const state: KillSwitchState = { ...unsigned, keyId: envelope.keyId, signature: envelope.signature };

    if (existing) {
      Object.assign(existing, state);
    } else {
      this.store.killSwitchStates.push(state);
    }
    void this.store.persist();

    this.audit.record(actor.id, 'kill_switch.activated', tenantId, { reason }, tenantId);
    this.siem.emit({ tenantId, type: 'kill_switch.activated', severity: 'critical', actor: { userId: actor.id, nodeId: null, ip: null }, target: { taskId: null, deviceId: null, nodeId: null }, metadata: { reason } });
    this.logger.warn(`KILL SWITCH ACTIVATED: tenantId=${tenantId} by=${actor.email} reason=${reason ?? 'none'}`);

    const cfg = this.policy.get(tenantId).notificationConfig;
    this.notifications.notify(cfg, {
      event: 'kill_switch.activated',
      tenantId,
      message: `Kill switch activated for tenant ${tenantId} by ${actor.email}. Reason: ${reason ?? 'none'}`,
      details: { activatedBy: actor.id, reason },
    });

    void this.pushToNodes(state, envelope);
    return state;
  }

  /**
   * Changes the deactivate state.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  deactivate(tenantId: string, actor: User): KillSwitchState {
    const existing = this.store.killSwitchStates.find((s) => s.tenantId === tenantId);
    if (!existing || !existing.active) throw new BadRequestException('Kill switch is not active');

    const now = new Date().toISOString();
    existing.active = false;
    existing.deactivatedAt = now;
    existing.deactivatedBy = actor.id;

    const envelope = this.signing.signPayload('kill_switch', tenantId, existing);
    existing.keyId = envelope.keyId;
    existing.signature = envelope.signature;

    void this.store.persist();

    this.audit.record(actor.id, 'kill_switch.deactivated', tenantId, {}, tenantId);
    this.siem.emit({ tenantId, type: 'kill_switch.deactivated', severity: 'high', actor: { userId: actor.id, nodeId: null, ip: null }, target: { taskId: null, deviceId: null, nodeId: null }, metadata: {} });
    this.logger.log(`Kill switch deactivated: tenantId=${tenantId} by=${actor.email}`);

    const cfg = this.policy.get(tenantId).notificationConfig;
    this.notifications.notify(cfg, {
      event: 'kill_switch.deactivated',
      tenantId,
      message: `Kill switch deactivated for tenant ${tenantId} by ${actor.email}`,
    });

    void this.pushToNodes(existing, envelope);
    return existing;
  }

  /**
   * Pushes a signed kill-switch envelope to every online backend node.
   * NODE_MGMT_SECRET must be set on each node for it to accept the payload.
   * Failures are logged but never throw -- the kill switch is stored locally
   * regardless of whether nodes are reachable.
   */
  private async pushToNodes(
    state: KillSwitchState,
    envelope: ReturnType<SigningService['signPayload']>,
  ): Promise<void> {
    const secret = process.env.NODE_MGMT_SECRET;
    if (!secret) {
      this.logger.error(
        'NODE_MGMT_SECRET is not set — kill switch state will NOT be pushed to backend nodes. ' +
        'Tasks cached on nodes will continue to execute until they poll the management server.',
      );
      return;
    }
    const onlineNodes = this.nodes.onlineNodes();
    if (onlineNodes.length === 0) {
      this.logger.warn('Kill switch activated but no online nodes to push to');
      return;
    }
    const results = await Promise.allSettled(
      onlineNodes.map(async (node) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(`${node.publicUrl.replace(/\/$/, '')}/node/kill-switch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ secret, envelope: { ...envelope, payload: state } }),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.logger.log(`Kill switch pushed to nodeId=${node.id}`);
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.error(
        `Kill switch push failed for ${failed}/${onlineNodes.length} node(s). ` +
        `Those nodes will pick up the state on their next heartbeat poll.`,
      );
    }
  }

}
