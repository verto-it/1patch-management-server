import { Injectable, Logger } from '@nestjs/common';
import { MemoryStore } from '../storage/memory.store';
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
  constructor(private readonly store: MemoryStore) {}

  /**
   * Gets the get value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  get(tenantId: string): TenantPolicy {
    return this.store.tenantPolicies.find((policy) => policy.tenantId === tenantId) ?? { ...DEFAULT_POLICY, tenantId };
  }

  /**
   * Sets the set value.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param patch patch supplied to the function.
   * @returns The result produced by the operation.
   */
  set(tenantId: string, patch: Partial<Omit<TenantPolicy, 'tenantId'>>): TenantPolicy {
    const existing = this.get(tenantId);
    const sanitizedPatch = sanitizePolicyPatch(patch);
    const updated: TenantPolicy = { ...existing, ...sanitizedPatch, tenantId };
    const index = this.store.tenantPolicies.findIndex((policy) => policy.tenantId === tenantId);
    if (index === -1) this.store.tenantPolicies.push(updated);
    else this.store.tenantPolicies[index] = updated;
    void this.store.persist();
    this.logger.log(`Tenant policy updated for tenantId=${tenantId}`);
    return updated;
  }

  /**
   * Lists list records for the caller.
   * @returns The result produced by the operation.
   */
  list(): TenantPolicy[] {
    return [...this.store.tenantPolicies];
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

function sanitizePolicyPatch(patch: Partial<Omit<TenantPolicy, 'tenantId'>>): Partial<Omit<TenantPolicy, 'tenantId'>> {
  const next = { ...patch };
  if (typeof next.virusTotalApiKey === 'string') {
    const trimmed = next.virusTotalApiKey.trim();
    if (/^[*•]+$/.test(trimmed)) delete next.virusTotalApiKey;
    else if (!trimmed) next.virusTotalApiKey = undefined;
    else next.virusTotalApiKey = trimmed;
  }
  return next;
}
