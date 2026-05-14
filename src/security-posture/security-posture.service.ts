import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SiemConfigService } from '../siem/siem-config.service';
import { SigningService } from '../signing.service';
import { SIGNING_SCOPES } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import { TenantPolicyService } from '../tasks/tenant-policy.service';
import { AuditEvent, BackendNode, TenantPolicy, UpdateTask, User } from '../types';
import {
  SecurityPostureCategory,
  SecurityPostureCategoryBreakdown,
  SecurityPostureFinding,
  SecurityPostureFixAction,
  SecurityPostureFixResult,
  SecurityPostureReport,
  SecurityPostureSeverity,
} from './security-posture.types';

const SCORE_WEIGHTS: Record<SecurityPostureSeverity, number> = {
  critical: 30,
  high: 15,
  medium: 5,
  info: 0,
};

const CATEGORY_LABELS: Record<SecurityPostureCategory, string> = {
  task_execution: 'Task Security',
  signing_keys: 'Signing & Keys',
  backend_nodes: 'Nodes',
  admin_auth: 'Admin & MFA',
  audit_integrity: 'Audit',
  siem_observability: 'SIEM',
  policies: 'Policies',
  kill_switch: 'Kill Switch',
};

const SEVERITIES: SecurityPostureSeverity[] = ['critical', 'high', 'medium', 'info'];
const CATEGORIES = Object.keys(CATEGORY_LABELS) as SecurityPostureCategory[];
const MINIMUM_ENTERPRISE_DELAY_SECONDS = 300;
const ADMIN_INACTIVE_DAYS = 90;
const AUDIT_VERIFY_MAX_AGE_DAYS = 7;

export type SecurityPostureCheckContext = {
  tenantId: string;
  policy: TenantPolicy;
  users: User[];
  nodes: BackendNode[];
  tasks: UpdateTask[];
  auditEvents: AuditEvent[];
  siemConfigured: boolean;
};

@Injectable()
export class SecurityPostureService {
  /**
   * Creates a SecurityPostureService instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param policies policies supplied to the function.
   * @param audit audit supplied to the function.
   * @param signing signing supplied to the function.
   * @param siemConfigs siem configs supplied to the function.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly policies: TenantPolicyService,
    private readonly audit: AuditService,
    private readonly signing: SigningService,
    private readonly siemConfigs: SiemConfigService,
  ) {}

  /**
   * Handles the generate operation for SecurityPostureService.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async generate(tenantId = 'default'): Promise<SecurityPostureReport> {
    const policy = this.policies.get(tenantId);
    const siemConfig = await this.siemConfigs.get(tenantId).catch(() => undefined);
    const ctx: SecurityPostureCheckContext = {
      tenantId,
      policy,
      users: this.store.users,
      nodes: this.store.backendNodes,
      tasks: this.store.tasks.filter((task) => (task.tenantId ?? tenantId) === tenantId),
      auditEvents: this.store.auditEvents,
      siemConfigured: hasSiemExporter(siemConfig),
    };

    const findings = [
      ...checkTaskExecutionSecurity(ctx),
      ...checkSigningAndKeys(ctx, this.signing),
      ...checkBackendNodes(ctx),
      ...checkAdminAuth(ctx),
      ...checkAuditIntegrity(ctx, this.audit),
      ...checkSiemObservability(ctx),
      ...checkPolicies(ctx),
      ...checkKillSwitch(ctx),
    ];

    return buildReport(tenantId, policy.securityMode, findings);
  }

  /**
   * Handles the apply safe fixes operation for SecurityPostureService.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param requestedActions requested actions supplied to the function.
   * @returns The result produced by the operation.
   */
  async applySafeFixes(
    tenantId = 'default',
    requestedActions?: SecurityPostureFixAction[],
  ): Promise<SecurityPostureFixResult> {
    const report = await this.generate(tenantId);
    const applied: SecurityPostureFixResult['applied'] = [];
    const skipped: SecurityPostureFixResult['skipped'] = [];
    const allowed = new Set(requestedActions ?? ['enable_delayed_execution', 'enable_mfa_approval', 'enforce_minimum_delay']);

    for (const finding of report.findings) {
      if (!finding.autoFixAvailable || !finding.fixAction) {
        skipped.push({ findingId: finding.id, reason: 'No safe automatic fix is available' });
        continue;
      }
      if (!allowed.has(finding.fixAction)) {
        skipped.push({ findingId: finding.id, reason: 'Fix action was not requested' });
        continue;
      }
      if (finding.severity === 'critical') {
        skipped.push({ findingId: finding.id, reason: 'Critical fixes require explicit manual confirmation' });
        continue;
      }
      const description = this.applyFix(tenantId, finding.fixAction);
      applied.push({ findingId: finding.id, action: finding.fixAction, description });
    }

    return { tenantId, applied, skipped, report: await this.generate(tenantId) };
  }

  /**
   * Handles the apply fix operation for SecurityPostureService.
   *
   * @param tenantId Identifier used to locate the target record.
   * @param action action supplied to the function.
   * @returns The result produced by the operation.
   */
  private applyFix(tenantId: string, action: SecurityPostureFixAction): string {
    if (action === 'enable_delayed_execution' || action === 'enforce_minimum_delay') {
      this.policies.set(tenantId, { minimumExecutionDelaySeconds: MINIMUM_ENTERPRISE_DELAY_SECONDS });
      return `Set minimum execution delay to ${MINIMUM_ENTERPRISE_DELAY_SECONDS} seconds`;
    }
    if (action === 'enable_mfa_approval') {
      this.policies.set(tenantId, { requireMfaForTaskSigning: true });
      return 'Enabled MFA approval for task signing';
    }
    if (action === 'enable_default_notifications') {
      const policy = this.policies.get(tenantId);
      this.policies.set(tenantId, {
        notificationConfig: {
          notifyOn: ['task.high_risk', 'kill_switch.activated', 'signing_key.rotated'],
          ...policy.notificationConfig,
        },
      });
      return 'Enabled default security notification events';
    }
    return 'No change applied';
  }
}

/**
 * Builds the report payload.
 *
 * @param tenantId Identifier used to locate the target record.
 * @param mode mode supplied to the function.
 * @param findings findings supplied to the function.
 * @param generatedAt generated at supplied to the function.
 * @returns The result produced by the operation.
 */
export function buildReport(
  tenantId: string,
  mode: TenantPolicy['securityMode'],
  findings: SecurityPostureFinding[],
  generatedAt = new Date().toISOString(),
): SecurityPostureReport {
  const deduction = findings.reduce((total, finding) => total + SCORE_WEIGHTS[finding.severity], 0);
  const score = Math.max(0, Math.min(100, 100 - deduction));
  const findingsBySeverity = Object.fromEntries(SEVERITIES.map((severity) => [
    severity,
    findings.filter((finding) => finding.severity === severity),
  ])) as SecurityPostureReport['findingsBySeverity'];
  return {
    tenantId,
    score,
    mode,
    findings,
    findingsBySeverity,
    categoryBreakdown: buildCategoryBreakdown(findings),
    generatedAt,
  };
}

/**
 * Handles the check task execution security operation.
 *
 * @param ctx ctx supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkTaskExecutionSecurity(ctx: SecurityPostureCheckContext): SecurityPostureFinding[] {
  const findings: SecurityPostureFinding[] = [];
  const accepted = ctx.tasks.filter((task) => ['scheduled', 'executable', 'pending', 'dispatched', 'completed'].includes(task.status));
  const unsignedAccepted = accepted.some((task) => !task.ledgerEntryId);
  if (unsignedAccepted) {
    findings.push(finding('task.unsigned_accepted', 'critical', 'task_execution', 'Unsigned tasks were accepted', 'At least one executable or dispatched task has no signed ledger entry.', 'A node or client could receive work that cannot be traced back to a signed authorization decision.', 'Revoke unsigned tasks, review task history, and require signed ledger entries before dispatch.'));
  }
  if (process.env.TASK_LEDGER_DISABLED === 'true' || process.env.SIGNED_LEDGER_DISABLED === 'true') {
    findings.push(finding('task.signed_ledger_disabled', 'critical', 'task_execution', 'Signed ledger is disabled', 'The task ledger has been disabled by configuration.', 'Task approvals and execution records lose non-repudiation and tamper-evidence.', 'Enable the signed task ledger and rotate any keys used while it was disabled.'));
  }
  if (ctx.policy.minimumExecutionDelaySeconds <= 0) {
    findings.push(finding('task.delayed_execution_disabled', 'high', 'task_execution', 'Delayed execution is disabled', 'Tasks can become executable immediately after signing.', 'Operators have less time to catch malicious, mistaken, or overbroad deployments before execution.', 'Enable delayed execution with a minimum enterprise delay.', true, 'enable_delayed_execution'));
  }
  if (!ctx.policy.requireMfaForTaskSigning) {
    findings.push(finding('task.mfa_approval_disabled', 'high', 'task_execution', 'MFA approval for task signing is disabled', 'Task signing does not require a fresh MFA-backed approval.', 'A compromised admin session could authorize patch execution without a second factor.', 'Require MFA for task signing.', true, 'enable_mfa_approval'));
  }
  if (ctx.policy.securityMode === 'tinfoil' && (ctx.policy.requiredApprovalCount < 2 || ctx.policy.highRiskRequiredApprovalCount < 2)) {
    findings.push(finding('task.tinfoil_multiple_approvals_missing', 'high', 'task_execution', 'Tinfoil mode lacks multiple approvals', 'Tinfoil mode should require at least two approvals for task authorization.', 'Single-person task authorization weakens separation of duties for highly sensitive tenants.', 'Set required approval counts to at least 2.'));
  }
  return findings;
}

/**
 * Handles the check signing and keys operation.
 *
 * @param ctx ctx supplied to the function.
 * @param signing signing supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkSigningAndKeys(ctx: SecurityPostureCheckContext, signing: SigningService): SecurityPostureFinding[] {
  const findings: SecurityPostureFinding[] = [];
  const activeKeyIdsByScope = (safe(() => signing.getActiveKeyIdsByScope()) ?? {}) as Partial<Record<(typeof SIGNING_SCOPES)[number], string>>;
  const allMetadata = safe(() => signing.getAllKeyMetadata()) ?? [];
  const activeMetadata = Object.values(activeKeyIdsByScope)
    .map((keyId) => allMetadata.find((meta) => meta.keyId === keyId))
    .filter(Boolean);

  if (process.env.NODE_ENV === 'production' && (process.env.MANAGEMENT_SIGNING_IS_DEV === 'true' || activeMetadata.some((meta) => meta?.isDev))) {
    findings.push(finding('signing.dev_signer_production', 'critical', 'signing_keys', 'Development signer is used in production', 'The active management signing key is marked as a development key.', 'Production clients may reject the key, and attackers can target weaker development key handling.', 'Rotate to a production signing key and set MANAGEMENT_SIGNING_IS_DEV=false.'));
  }
  if (process.env.MANAGEMENT_SIGNING_PRIVATE_KEY || process.env.MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON) {
    findings.push(finding('signing.key_in_env', 'high', 'signing_keys', 'Signing key is stored in environment configuration', 'The private signing key is loaded directly from an environment variable.', 'Environment files are easier to copy, leak, or include in backups than an external KMS or secret manager.', 'Move signing operations to Vault, HSM, KMS, or another external key provider.'));
  }
  if (trustedKeyCount(allMetadata) <= SIGNING_SCOPES.length) {
    findings.push(finding('signing.no_rotation', 'high', 'signing_keys', 'No key rotation path is configured', 'Only one trusted management signing key is configured.', 'Emergency rotation may break clients or force unsafe manual trust changes.', 'Publish at least one next trusted public key before rotating the active signer.'));
  }
  if (hasExpiredTrustedKey(allMetadata)) {
    findings.push(finding('signing.expired_key_trusted', 'critical', 'signing_keys', 'Expired signing keys are still trusted', 'At least one trusted signing key appears to be past its trust deadline.', 'Old keys can validate malicious or stale payloads after they should have been removed.', 'Remove expired trusted keys and audit signatures created by those keys.'));
  }
  if (allMetadata.some((meta) => meta.scope === '*')) {
    findings.push(finding('signing.wildcard_key_trusted', 'critical', 'signing_keys', 'Wildcard signing key is trusted', 'At least one management signing key is scoped to every payload class.', 'A single key compromise could sign tasks, ledgers, manifests, and kill-switch payloads.', 'Remove wildcard signing metadata and configure one active key per signing scope.'));
  }
  const missingScopes = SIGNING_SCOPES.filter((scope) => !activeKeyIdsByScope[scope]);
  if (missingScopes.length > 0) {
    findings.push(finding('signing.missing_scoped_keys', 'high', 'signing_keys', 'A required signing scope has no active key', `Missing active keys for: ${missingScopes.join(', ')}.`, 'Payloads for missing scopes cannot be signed or may fall back to unsafe compatibility behavior.', 'Configure MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON with one active key for every signing scope.'));
  }
  const activeKeyIds = Object.values(activeKeyIdsByScope).filter(Boolean);
  if (new Set(activeKeyIds).size !== activeKeyIds.length) {
    findings.push(finding('signing.shared_key_across_scopes', 'high', 'signing_keys', 'A signing key is shared across scopes', 'The same active key ID is assigned to more than one signing scope.', 'Compromise of one scoped key can affect multiple payload classes.', 'Generate distinct keypairs and key IDs for every signing scope.'));
  }
  const activePublicKeys = activeMetadata
    .map((meta) => meta?.publicKeyPem?.replace(/\s+/g, ''))
    .filter(Boolean);
  if (new Set(activePublicKeys).size !== activePublicKeys.length) {
    findings.push(finding('signing.shared_key_material_across_scopes', 'high', 'signing_keys', 'Signing key material is shared across scopes', 'Two or more active scoped signing keys use the same public key material.', 'Compromise of one private key can affect multiple payload classes even when key IDs differ.', 'Generate separate keypairs for every signing scope.'));
  }
  if (activeMetadata.some((meta) => !meta?.scope || meta.scope === '*') || missingScopes.length > 0) {
    findings.push(finding('signing.missing_scope_isolation', 'high', 'signing_keys', 'Signing scope isolation is incomplete', 'Active signing key metadata is missing or not scoped to exactly one payload class.', 'A verifier may accept signatures for the wrong payload class.', 'Use strict scoped key metadata and rotate any wildcard or shared active keys.'));
  }
  return findings;
}

/**
 * Handles the check backend nodes operation.
 *
 * @param ctx ctx supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkBackendNodes(ctx: SecurityPostureCheckContext): SecurityPostureFinding[] {
  const now = Date.now();
  const findings: SecurityPostureFinding[] = [];
  if (ctx.nodes.some((node) => node.enrollmentTokenUsedAt && !node.tlsCertSerial)) {
    findings.push(finding('nodes.mtls_missing', 'critical', 'backend_nodes', 'A backend node has no mTLS certificate', 'At least one registered backend node has no stored Vault certificate serial.', 'A node without mTLS cannot be strongly authenticated for task polling and event submission.', 'Re-enroll the node and ensure Vault PKI certificate issuance succeeds.'));
  }
  if (ctx.nodes.some((node) => node.tlsCertExpiresAt && Date.parse(node.tlsCertExpiresAt) <= now)) {
    findings.push(finding('nodes.cert_expired', 'high', 'backend_nodes', 'A backend node certificate is expired', 'At least one node certificate is past its expiry timestamp.', 'Expired certificates can interrupt patch execution or encourage bypassing mTLS checks.', 'Renew or re-enroll the affected node.'));
  }
  if (ctx.nodes.some((node) => node.status !== 'online')) {
    findings.push(finding('nodes.not_reporting', 'medium', 'backend_nodes', 'A backend node is not reporting', 'At least one node is pending or offline.', 'Devices assigned to that node may miss updates, certificate renewals, or security events.', 'Bring the node online, remove stale enrollments, or reassign affected devices.'));
  }
  return findings;
}

/**
 * Handles the check admin auth operation.
 *
 * @param ctx ctx supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkAdminAuth(ctx: SecurityPostureCheckContext): SecurityPostureFinding[] {
  const admins = ctx.users.filter((user) => user.roles.some((role) => role === 'owner' || role === 'admin'));
  const findings: SecurityPostureFinding[] = [];
  if (admins.some((user) => !user.mfaEnabled)) {
    findings.push(finding('admin.mfa_disabled', 'critical', 'admin_auth', 'MFA is disabled for an owner or admin', 'At least one privileged account can sign in without MFA.', 'A stolen password could become full administrative access to patch deployment controls.', 'Enable MFA on every owner and admin account.'));
  }
  if (admins.length > 5) {
    findings.push(finding('admin.too_many_admins', 'medium', 'admin_auth', 'Too many owner/admin accounts', `${admins.length} owner/admin accounts are active.`, 'A larger privileged account set increases phishing, credential reuse, and insider-risk exposure.', 'Reduce owner/admin membership and use least-privilege roles for routine work.'));
  }
  const inactiveCutoff = Date.now() - ADMIN_INACTIVE_DAYS * 24 * 60 * 60_000;
  if (admins.some((user) => !user.lastLoginAt || Date.parse(user.lastLoginAt) < inactiveCutoff)) {
    findings.push(finding('admin.inactive_still_active', 'medium', 'admin_auth', 'Inactive admin accounts are still active', 'At least one owner/admin has no recent login timestamp.', 'Dormant privileged accounts are often missed during access reviews and incident response.', 'Disable stale accounts or downgrade them to non-privileged roles.'));
  }
  return findings;
}

/**
 * Handles the check audit integrity operation.
 *
 * @param ctx ctx supplied to the function.
 * @param audit audit supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkAuditIntegrity(ctx: SecurityPostureCheckContext, audit: AuditService): SecurityPostureFinding[] {
  const findings: SecurityPostureFinding[] = [];
  const verified = audit.verifyChain();
  if (!verified.valid) {
    findings.push(finding('audit.chain_broken', 'critical', 'audit_integrity', 'Audit chain is broken', 'The audit hash chain failed integrity verification.', 'Audit evidence may have been modified, deleted, or re-ordered.', 'Freeze audit retention, investigate the broken link, and restore from a trusted snapshot.'));
  }
  const cutoff = Date.now() - AUDIT_VERIFY_MAX_AGE_DAYS * 24 * 60 * 60_000;
  const recentVerification = ctx.auditEvents.some((event) =>
    ['audit.verify_chain', 'audit.chain_verified', 'siem.verify_run'].includes(event.action) &&
    Date.parse(event.createdAt) >= cutoff,
  );
  if (!recentVerification) {
    findings.push(finding('audit.verification_stale', 'medium', 'audit_integrity', 'Audit verification has not run recently', 'No recent audit-chain verification event was found.', 'A broken audit chain could go unnoticed until a compliance review or incident.', 'Schedule audit chain verification at least weekly.'));
  }
  return findings;
}

/**
 * Handles the check siem observability operation.
 *
 * @param ctx ctx supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkSiemObservability(ctx: SecurityPostureCheckContext): SecurityPostureFinding[] {
  const findings: SecurityPostureFinding[] = [];
  if (!ctx.siemConfigured) {
    findings.push(finding('siem.not_configured', 'high', 'siem_observability', 'No SIEM exporter is configured', 'The tenant has no active Webhook, Syslog, or Sentinel exporter.', 'Security events may remain only inside 1Patch and fail enterprise monitoring requirements.', 'Configure at least one SIEM exporter and run verification.'));
  }
  const recentFailure = ctx.auditEvents.some((event) =>
    ['siem.export_failed', 'siem.verify_failed'].includes(event.action) ||
    (String(event.action).includes('siem') && String((event.metadata ?? {}).error ?? '').length > 0),
  );
  if (recentFailure) {
    findings.push(finding('siem.failing', 'high', 'siem_observability', 'SIEM export appears to be failing', 'Recent audit events indicate SIEM delivery or verification errors.', 'Detection and compliance systems may miss important security events.', 'Fix exporter credentials or network reachability, then run SIEM Verify.'));
  }
  if (!hasNotificationTarget(ctx.policy)) {
    findings.push(finding('siem.notifications_missing', 'medium', 'siem_observability', 'No notifications are configured', 'No email, Slack, Teams, or generic webhook notification target is configured.', 'Critical operational events may rely on someone actively watching the dashboard.', 'Add at least one notification destination for high-risk tasks and kill-switch events.'));
  }
  return findings;
}

/**
 * Handles the check policies operation.
 *
 * @param ctx ctx supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkPolicies(ctx: SecurityPostureCheckContext): SecurityPostureFinding[] {
  const findings: SecurityPostureFinding[] = [];
  if (ctx.policy.maintenanceWindows.length === 0) {
    findings.push(finding('policy.no_maintenance_window', 'medium', 'policies', 'No maintenance window is configured', 'Tasks are not constrained to approved maintenance windows.', 'Unexpected patch execution can affect availability and change-control compliance.', 'Define tenant maintenance windows that match enterprise change policy.'));
  }
  if (ctx.policy.minimumExecutionDelaySeconds < MINIMUM_ENTERPRISE_DELAY_SECONDS) {
    findings.push(finding('policy.no_minimum_delay', 'high', 'policies', 'Execution delay is below enterprise minimum', `The configured delay is ${ctx.policy.minimumExecutionDelaySeconds} seconds.`, 'Short delays reduce review time and weaken blast-radius control.', `Set the minimum delay to at least ${MINIMUM_ENTERPRISE_DELAY_SECONDS} seconds.`, true, 'enforce_minimum_delay'));
  }
  if (ctx.policy.securityMode === 'normal') {
    findings.push(finding('policy.normal_mode', 'info', 'policies', 'Security mode is normal', 'The tenant is running in normal mode.', 'Normal mode may be acceptable for smaller tenants but usually needs compensating controls for enterprise deployments.', 'Consider strict mode for enterprise tenants and tinfoil mode for highly sensitive environments.'));
  }
  return findings;
}

/**
 * Handles the check kill switch operation.
 *
 * @param ctx ctx supplied to the function.
 * @returns The result produced by the operation.
 */
export function checkKillSwitch(ctx: SecurityPostureCheckContext): SecurityPostureFinding[] {
  const findings: SecurityPostureFinding[] = [];
  const activeKeyPresent = Boolean(process.env.MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON || process.env.MANAGEMENT_SIGNING_ACTIVE_KEY_ID);
  if (!activeKeyPresent) {
    findings.push(finding('kill_switch.unavailable', 'critical', 'kill_switch', 'Kill switch signing is unavailable', 'No active management signing key is configured for kill-switch payloads.', 'Clients may not be able to trust emergency stop-state updates.', 'Restore management signing configuration and verify the kill-switch endpoint.'));
  }
  const tested = ctx.auditEvents.some((event) =>
    event.tenantId === ctx.tenantId &&
    ['kill_switch.activated', 'kill_switch.deactivated', 'kill_switch.tested'].includes(event.action),
  );
  if (!tested) {
    findings.push(finding('kill_switch.never_tested', 'high', 'kill_switch', 'Kill switch has never been tested', 'No kill-switch activation, deactivation, or test event exists for this tenant.', 'An untested emergency stop process may fail during a real incident.', 'Run a controlled kill-switch test and record the result.'));
  }
  return findings;
}

/**
 * Builds the category breakdown payload.
 *
 * @param findings findings supplied to the function.
 * @returns The result produced by the operation.
 */
function buildCategoryBreakdown(findings: SecurityPostureFinding[]): SecurityPostureCategoryBreakdown[] {
  return CATEGORIES.map((category) => {
    const categoryFindings = findings.filter((finding) => finding.category === category);
    const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [
      severity,
      categoryFindings.filter((finding) => finding.severity === severity).length,
    ])) as Record<SecurityPostureSeverity, number>;
    const status = severityCounts.critical > 0 ? 'critical' : severityCounts.high > 0 || severityCounts.medium > 0 ? 'warning' : 'good';
    return {
      category,
      label: CATEGORY_LABELS[category],
      status,
      scoreImpact: categoryFindings.reduce((total, finding) => total + SCORE_WEIGHTS[finding.severity], 0),
      findingCount: categoryFindings.length,
      severityCounts,
    };
  });
}

/**
 * Handles the finding operation.
 *
 * @param id Identifier used to locate the target record.
 * @param severity severity supplied to the function.
 * @param category category supplied to the function.
 * @param title title supplied to the function.
 * @param description description supplied to the function.
 * @param riskExplanation risk explanation supplied to the function.
 * @param fixSuggestion fix suggestion supplied to the function.
 * @param autoFixAvailable auto fix available supplied to the function.
 * @param fixAction fix action supplied to the function.
 * @returns The result produced by the operation.
 */
function finding(
  id: string,
  severity: SecurityPostureSeverity,
  category: SecurityPostureCategory,
  title: string,
  description: string,
  riskExplanation: string,
  fixSuggestion: string,
  autoFixAvailable = false,
  fixAction?: SecurityPostureFixAction,
): SecurityPostureFinding {
  return { id, severity, category, title, description, riskExplanation, fixSuggestion, autoFixAvailable, fixAction };
}

/**
 * Handles the trusted key count operation.
 *
 * @param metadata metadata supplied to the function.
 * @returns The result produced by the operation.
 */
function trustedKeyCount(metadata: Array<{ status?: string }>): number {
  if (metadata.length > 0) {
    return metadata.filter((meta) => meta.status !== 'revoked').length;
  }
  try {
    const parsed = JSON.parse(process.env.MANAGEMENT_SIGNING_KEY_METADATA_JSON ?? process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Handles the has expired trusted key operation.
 *
 * @param metadata metadata supplied to the function.
 * @returns The result produced by the operation.
 */
function hasExpiredTrustedKey(metadata: Array<{ status?: string; retirementDeadline?: string; expiresAt?: string }>): boolean {
  if (metadata.length > 0) {
    return metadata.some((meta) => {
      const deadline = meta.expiresAt ?? meta.retirementDeadline;
      return meta.status !== 'revoked' && Boolean(deadline && Date.parse(deadline) <= Date.now());
    });
  }
  try {
    const parsed = JSON.parse(process.env.MANAGEMENT_SIGNING_KEY_METADATA_JSON ?? process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON ?? '{}') as Record<string, unknown>;
    return Object.values(parsed).some((value) => {
      if (!value || typeof value !== 'object') return false;
      const deadline = (value as { expiresAt?: string; retirementDeadline?: string }).expiresAt ?? (value as { retirementDeadline?: string }).retirementDeadline;
      return Boolean(deadline && Date.parse(deadline) <= Date.now());
    });
  } catch {
    return false;
  }
}

/**
 * Handles the has siem exporter operation.
 *
 * @param config Configuration object used by the operation.
 * @returns The result produced by the operation.
 */
function hasSiemExporter(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const c = config as { webhook?: { url?: string }; syslog?: { host?: string }; sentinel?: { workspaceId?: string } };
  return Boolean(c.webhook?.url || c.syslog?.host || c.sentinel?.workspaceId);
}

/**
 * Handles the has notification target operation.
 *
 * @param policy policy supplied to the function.
 * @returns The result produced by the operation.
 */
function hasNotificationTarget(policy: TenantPolicy): boolean {
  const config = policy.notificationConfig;
  return Boolean(config?.emailAddresses?.length || config?.slackWebhookUrl || config?.teamsWebhookUrl || config?.genericWebhookUrl);
}

/**
 * Handles the safe operation.
 *
 * @param fn fn supplied to the function.
 * @returns The result produced by the operation.
 */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
