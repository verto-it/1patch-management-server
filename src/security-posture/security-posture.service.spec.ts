import { AuditService } from '../audit/audit.service';
import { SigningService } from '../signing.service';
import { TenantPolicy } from '../types';
import {
  buildReport,
  checkAdminAuth,
  checkPolicies,
  checkTaskExecutionSecurity,
} from './security-posture.service';

/**
 * Handles the policy operation.
 *
 * @param patch patch supplied to the function.
 */
const policy = (patch: Partial<TenantPolicy> = {}): TenantPolicy => ({
  tenantId: 'default',
  minimumExecutionDelaySeconds: 300,
  allowEmergencyBypass: false,
  requireMfaForTaskSigning: true,
  requiredApprovalCount: 1,
  highRiskRequiredApprovalCount: 2,
  securityMode: 'strict',
  trustedSourceHosts: [],
  allowedTaskTypes: ['update_package'],
  maintenanceWindows: [{ startHourUtc: 1, endHourUtc: 3 }],
  requireVirusTotalForStrict: false,
  requireVirusTotalForTinfoil: false,
  defaultTaskTtlSeconds: 3600,
  broadTargetingThresholdPercent: 50,
  ...patch,
});

describe('security posture checks', () => {
  it('scores findings by severity and clamps at zero', () => {
    const report = buildReport('default', 'strict', [
      finding('c1', 'critical'),
      finding('h1', 'high'),
      finding('m1', 'medium'),
      finding('i1', 'info'),
    ]);

    expect(report.score).toBe(50);
    expect(report.findingsBySeverity.critical).toHaveLength(1);
    expect(report.findingsBySeverity.info).toHaveLength(1);

    const zero = buildReport('default', 'strict', Array.from({ length: 10 }, (_, index) => finding(`c${index}`, 'critical')));
    expect(zero.score).toBe(0);
  });

  it('detects unsigned accepted tasks and unsafe task policy settings', () => {
    const findings = checkTaskExecutionSecurity({
      tenantId: 'default',
      policy: policy({ minimumExecutionDelaySeconds: 0, requireMfaForTaskSigning: false }),
      users: [],
      nodes: [],
      tasks: [{ id: 'task-1', nodeId: 'node-1', deviceId: 'device-1', type: 'refresh_inventory', targetVersion: 'latest', status: 'completed', createdAt: new Date().toISOString() }],
      auditEvents: [],
      siemConfigured: false,
    });

    expect(findings.map((item) => item.id)).toEqual(expect.arrayContaining([
      'task.unsigned_accepted',
      'task.delayed_execution_disabled',
      'task.mfa_approval_disabled',
    ]));
  });

  it('detects admin MFA and inactivity risks', () => {
    const findings = checkAdminAuth({
      tenantId: 'default',
      policy: policy(),
      users: [{ id: 'u1', email: 'owner@example.com', passwordHash: '', roles: ['owner'], mfaEnabled: false, recoveryCodeHashes: [], failedAttempts: 0, oauthLinks: [] }],
      nodes: [],
      tasks: [],
      auditEvents: [],
      siemConfigured: false,
    });

    expect(findings.map((item) => item.id)).toEqual(expect.arrayContaining([
      'admin.mfa_disabled',
      'admin.inactive_still_active',
    ]));
  });

  it('offers safe fixes for minimum delay policy findings', () => {
    const findings = checkPolicies({
      tenantId: 'default',
      policy: policy({ minimumExecutionDelaySeconds: 30, maintenanceWindows: [], securityMode: 'normal' }),
      users: [],
      nodes: [],
      tasks: [],
      auditEvents: [],
      siemConfigured: true,
    });

    const delay = findings.find((item) => item.id === 'policy.no_minimum_delay');
    expect(delay?.autoFixAvailable).toBe(true);
    expect(delay?.fixAction).toBe('enforce_minimum_delay');
    expect(findings.find((item) => item.id === 'policy.normal_mode')?.severity).toBe('info');
  });
});

/**
 * Handles the finding operation.
 *
 * @param id Identifier used to locate the target record.
 * @param severity severity supplied to the function.
 * @returns The result produced by the operation.
 */
function finding(id: string, severity: 'critical' | 'high' | 'medium' | 'info') {
  return {
    id,
    severity,
    category: 'task_execution' as const,
    title: id,
    description: id,
    riskExplanation: id,
    fixSuggestion: id,
    autoFixAvailable: false,
  };
}

