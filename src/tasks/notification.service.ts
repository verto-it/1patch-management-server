import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NotificationEventType, TenantNotificationConfig, UpdateTask } from '../types';

export interface NotificationPayload {
  event: NotificationEventType;
  tenantId: string;
  message: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * Creates a NotificationService instance with its required collaborators.
   *
   * @param audit audit supplied to the function.
   */
  constructor(private readonly audit: AuditService) {}

  /** Enqueue a notification — delivery is async; failures are audit-logged, never thrown */
  notify(config: TenantNotificationConfig | undefined, payload: NotificationPayload): void {
    if (!config) return;
    if (!config.notifyOn.includes(payload.event)) return;
    void this.deliverAsync(config, payload);
  }

  /**
   * Sends deliver async data to its destination.
   *
   * @param config Configuration object used by the operation.
   * @param payload Request payload or data transfer object.
   */
  private async deliverAsync(config: TenantNotificationConfig, payload: NotificationPayload): Promise<void> {
    const body = JSON.stringify({ event: payload.event, tenantId: payload.tenantId, message: payload.message, details: payload.details ?? {}, sentAt: new Date().toISOString() });

    const targets: Array<{ name: string; url: string }> = [];
    if (config.slackWebhookUrl)   targets.push({ name: 'slack',   url: config.slackWebhookUrl });
    if (config.teamsWebhookUrl)   targets.push({ name: 'teams',   url: config.teamsWebhookUrl });
    if (config.genericWebhookUrl) targets.push({ name: 'webhook', url: config.genericWebhookUrl });

    for (const target of targets) {
      try {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.logger.debug(`Notification delivered via ${target.name}: event=${payload.event} tenantId=${payload.tenantId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Notification delivery failed (${target.name}): ${msg}`);
        this.audit.record(
          'system',
          'notification.delivery_failed',
          payload.tenantId,
          { channel: target.name, event: payload.event, error: msg },
          payload.tenantId,
        );
      }
    }

    // Email: log intent only — actual SMTP integration is out of scope for this implementation
    if (config.emailAddresses?.length) {
      this.logger.log(`[notification] Email would be sent to ${config.emailAddresses.join(', ')}: ${payload.message}`);
    }
  }
}
