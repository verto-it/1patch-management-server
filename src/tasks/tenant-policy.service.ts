import { Injectable, Logger } from '@nestjs/common';
import { TenantPolicy } from '../types';


const DEFAULT_POLICY: Omit<TenantPolicy, 'tenantId'> = {
  minimumExecutionDelaySeconds: 300,         // 5 minutes default
  allowEmergencyBypass: false,
  requireMfaForTaskSigning: true,
  requiredApprovalCount: 1,
  highRiskRequiredApprovalCount: 2,
  securityMode: 'normal',
  trustedSourceHosts: [],
  allowedTaskTypes: ['update_package', 'refresh_inventory'],
  maintenanceWindows: [],
  requireVirusTotalForStrict: false,
  requireVirusTotalForTinfoil: false,
  defaultTaskTtlSeconds: 3600,
  broadTargetingThresholdPercent: 50,
};

@Injectable()
export class TenantPolicyService {
  private readonly logger = new Logger(TenantPolicyService.name);
  /** In-memory policy store — persisted as part of MemoryStore snapshot in production */
  private policies = new Map<string, TenantPolicy>();

  get(tenantId: string): TenantPolicy {
    return this.policies.get(tenantId) ?? { ...DEFAULT_POLICY, tenantId };
  }

  set(tenantId: string, patch: Partial<Omit<TenantPolicy, 'tenantId'>>): TenantPolicy {
    const existing = this.get(tenantId);
    const updated: TenantPolicy = { ...existing, ...patch, tenantId };
    this.policies.set(tenantId, updated);
    this.logger.log(`Tenant policy updated for tenantId=${tenantId}`);
    return updated;
  }

  list(): TenantPolicy[] {
    return [...this.policies.values()];
  }

  /** Derive effective approval count based on risk score and mode */
  requiredApprovals(tenantId: string, riskScore: number): number {
    const policy = this.get(tenantId);
    if (policy.securityMode === 'tinfoil') return Math.max(2, policy.highRiskRequiredApprovalCount);
    if (riskScore >= 70) return policy.highRiskRequiredApprovalCount;
    return policy.requiredApprovalCount;
  }

  /** Returns the earliest ISO timestamp a task may be executed */
  notBeforeFor(tenantId: string): string {
    const policy = this.get(tenantId);
    return new Date(Date.now() + policy.minimumExecutionDelaySeconds * 1000).toISOString();
  }

  /** Returns the expiry ISO timestamp for a task ledger entry */
  expiresAtFor(tenantId: string): string {
    const policy = this.get(tenantId);
    return new Date(Date.now() + policy.defaultTaskTtlSeconds * 1000).toISOString();
  }
}
