export type Role =
  | 'owner'
  | 'admin'
  | 'patch_manager'
  | 'viewer'
  | 'auditor'
  | 'node_operator';

  
export type Permission =
  | 'setup:manage'
  | 'auth:manage'
  | 'users:manage'
  | 'roles:manage'
  | 'nodes:manage'
  | 'nodes:read'
  | 'nodes:enroll'
  | 'packages:read'
  | 'packages:write'
  | 'deployments:write'
  | 'apps:read'
  | 'apps:manage'
  | 'rules:manage'
  | 'tasks:manage'
  | 'tasks:approve'
  | 'tasks:sign'
  | 'kill_switch:manage'
  | 'audit:read';

/** Signing scope — each key is scoped to exactly one payload type */
export type SigningScope =
  | 'bootstrap_manifest'
  | 'rule_bundle'
  | 'task_bundle'
  | 'task_ledger'
  | 'kill_switch'
  | 'recovery_task';

/** Full task lifecycle */
export type TaskStatus =
  | 'draft'
  | 'security_scanned'
  | 'mfa_approved'
  | 'signed'
  | 'scheduled'
  | 'executable'
  | 'pending'        // legacy alias treated as executable
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'revoked';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  roles: Role[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  recoveryCodeHashes: string[];
  failedAttempts: number;
  lockedUntil?: string;
  lastLoginAt?: string;
  lastLoginCountry?: string;
  oauthLinks: Array<{ provider: string; subject: string }>;
}

export interface BackendNode {
  id: string;
  name: string;
  publicUrl: string;
  region?: string;
  site?: string;
  status: 'pending' | 'online' | 'offline';
  enrollmentTokenHash: string;
  enrollmentTokenCreatedAt: string;
  enrollmentTokenUsedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  version?: string;
  capacity?: Record<string, unknown>;
  tlsCertSerial?: string;
  tlsCertExpiresAt?: string;
  decommissionToken?: string;
}

export interface ClientEnrollment {
  id: string;
  tenantId: string;
  mode: 'single' | 'batch';
  enrollmentTokenHash: string;
  maxUses: number;
  uses: number;
  usedDeviceIds: string[];
  clientName?: string;
  createdAt: string;
}

export interface Device {
  id: string;
  tenantId: string;
  hostname: string;
  os: string;
  publicKey: string;
  lastSeenAt?: string;
  preferredNodeId?: string;
  group?: string;
  tags?: string[];
  deviceTrustScore?: number;
  riskScore?: number;
}

export interface InstalledApp {
  deviceId: string;
  name: string;
  publisher: string;
  version: string;
  packageId?: string;
  productCode?: string;
}

export interface PatchRule {
  id: string;
  tenantId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority?: number;
  createdBy?: string;
  createdAt?: string;
  trigger?: RuleTrigger;
  conditions?: RuleCondition[];
  conditionGroup?: RuleConditionGroup;
  actions?: RuleAction[];
  schedule?: RuleSchedule;
  lastRunAt?: string;
  executionStats?: RuleExecutionStats;
  safeMode?: RuleSafeMode;
  property?: 'appName' | 'manufacturer' | 'guid' | 'packageId';
  operator?: 'contains' | 'equals';
  value?: string;
  targetVersion?: 'latest' | string;
  maxVersion?: string;
  sourceTemplateId?: string;
  sourceTemplateName?: string;
}

export type RuleTriggerType =
  | 'schedule'
  | 'event'
  | 'manual';

export interface RuleTrigger {
  type: RuleTriggerType;
  eventType?: 'device.inventory.updated' | 'task.failed' | 'vulnerability.detected' | 'package.high_priority.detected' | 'task.security_scan.completed' | 'rule.task_candidate.created';
}

export interface RuleSchedule {
  cron?: string;
  timezone?: string;
  maintenanceWindow?: {
    daysOfWeek?: number[];
    startHourUtc: number;
    endHourUtc: number;
  };
}

export type RuleConditionField =
  | 'device.os'
  | 'device.hostname'
  | 'device.group'
  | 'device.tag'
  | 'device.deviceTrustScore'
  | 'device.lastInventoryAgeHours'
  | 'package.outdated'
  | 'package.name'
  | 'package.severity'
  | 'package.version'
  | 'lastTask.failed'
  | 'lastTask.retryCount'
  | 'lastTask.failureRetryable'
  | 'currentTime.maintenanceWindow'
  | 'riskScore'
  | 'task.sourceHostTrusted'
  | 'task.hashPresent';

export type RuleConditionOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'matches'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in';

export interface RuleCondition {
  field: RuleConditionField;
  operator: RuleConditionOperator;
  value: string | number | boolean | string[] | number[];
}

export interface RuleConditionGroup {
  combinator: 'AND' | 'OR';
  conditions: Array<RuleCondition | RuleConditionGroup>;
}

export type RuleAction =
  | {
      type: 'create_patch_task';
      mode: 'specific_package' | 'all_outdated';
      packageName?: string;
      packageId?: string;
      packageArtifactId?: string;
      targetVersion?: 'latest' | string;
      maxDevices?: number;
      retryLimit?: number;
      backoff?: 'none' | 'linear' | 'exponential';
    }
  | {
      type: 'create_security_task';
      task: 'refresh_inventory' | 'rescan_device';
    }
  | {
      type: 'notify';
      channel: 'siem' | 'webhook' | 'email';
      message: string;
    }
  | {
      type: 'mark_device';
      tag: string;
    }
  | {
      type: 'block_task_creation';
      reason: string;
    };

export interface RuleTemplateInput {
  id: string;
  label: string;
  type: 'string' | 'number' | 'device_group' | 'maintenance_window' | 'package_name' | 'boolean';
  required: boolean;
  description: string;
  defaultValue?: string | number | boolean | string[] | { daysOfWeek?: number[]; startHourUtc: number; endHourUtc: number };
}

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  category: 'Recommended' | 'Patch Automation' | 'Security / Inventory' | 'Failure Handling' | 'Compliance' | 'Notifications';
  recommendedSecurityMode: TenantPolicy['securityMode'];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  trigger: RuleTrigger;
  conditions: RuleConditionGroup;
  actions: RuleAction[];
  schedule: RuleSchedule;
  requiredInputs: RuleTemplateInput[];
  explanation: string[];
  safety: string[];
  custom?: boolean;
  tenantId?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface RuleExecutionStats {
  taskCreatedAt: string[];
  executionLog: RuleExecutionRecord[];
}

export interface RuleExecutionRecord {
  id: string;
  ruleId: string;
  tenantId: string;
  triggeredAt: string;
  triggeredBy: string;
  matched: boolean;
  deviceId?: string;
  taskIds: string[];
  riskScore: number;
  reasons: string[];
  conflicts: string[];
  approvalRequired: boolean;
  rateLimited: boolean;
  status: 'matched' | 'skipped' | 'failed';
}

export interface RuleSafeMode {
  enabled: boolean;
  autoSignBelowRiskScore?: number;
  requireApprovalAtRiskScore?: number;
}

export interface PackageArtifact {
  id: string;
  name: string;
  publisher: string;
  version: string;
  architecture: 'x64' | 'x86' | 'arm64' | 'any';
  platform: 'windows' | 'linux';
  type: 'msi' | 'winget' | 'apt';
  packageId?: string;
  fileName?: string;
  storagePath?: string;
  sourceUrl?: string;
  sha256?: string;
  signatureStatus: 'unknown' | 'valid' | 'invalid' | 'unsigned';
  installArgs: string;
  uninstallArgs?: string;
  applicability: {
    os?: string;
    appName?: string;
    manufacturer?: string;
    productCode?: string;
  };
  createdAt: string;
}

export interface TaskApproval {
  approverUserId: string;
  approvedAt: string;
  mfaChallengeId: string;
  approvalType: 'mfa_totp' | 'break_glass';
}

export interface SecurityFinding {
  code: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  message: string;
  field?: string;
}

export interface SecurityScanResult {
  taskId: string;
  scannedAt: string;
  /** 0-100 composite risk score */
  riskScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  findings: SecurityFinding[];
  humanReadableSummary: string;
  /** Hard block prevents signing regardless of approvals unless break-glass */
  hardBlock: boolean;
  hardBlockReason?: string;
  /** AI advisory only — never used to auto-approve or block */
  advisoryFindings?: SecurityFinding[];
  virusTotalResult?: {
    checkedAt: string;
    positives?: number;
    total?: number;
    permalink?: string;
    available: boolean;
  };
}

export interface UpdateTask {
  id: string;
  nodeId: string;
  deviceId: string;
  tenantId?: string;
  createdBy?: string;
  appName?: string;
  packageArtifactId?: string;
  packageId?: string;
  productCode?: string;
  sourceUrl?: string;
  sha256?: string;
  installArgs?: string;
  targetVersion: 'latest' | string;
  type: 'update_package' | 'refresh_inventory';
  status: TaskStatus;
  /** SHA-256 of canonical task execution fields — tamper detection */
  taskHash?: string;
  /** Client must not execute task before this ISO timestamp */
  notBefore?: string;
  securityScanResult?: SecurityScanResult;
  approvals?: TaskApproval[];
  ledgerEntryId?: string;
  createdAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  output?: string;
}

export interface TaskLedgerEntry {
  ledgerId: string;
  taskId: string;
  tenantId: string;
  createdBy: string;
  createdAt: string;
  /** Always true — invisible tasks must never be executed */
  visibleInDashboard: true;
  taskHash: string;
  riskScore: number;
  approvals: TaskApproval[];
  notBefore: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  state: 'active' | 'revoked' | 'superseded';
  revokedAt?: string;
  revokedReason?: string;
  supersededBy?: string;
}

export interface SignedEnvelope<T = unknown> {
  algorithm: 'ES256';
  keyId: string;
  payloadType: SigningScope;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  /** SHA-256 hex of canonical payload — verified by client in strict/tinfoil mode */
  payloadHash?: string;
  payload: T;
  signature: string;
}

export interface KillSwitchState {
  id: string;
  /** 'global' or a tenantId */
  tenantId: string;
  active: boolean;
  activatedAt?: string;
  activatedBy?: string;
  deactivatedAt?: string;
  deactivatedBy?: string;
  reason?: string;
  signature: string;
  keyId: string;
}

export interface AuditEvent {
  id: string;
  actor: string;
  tenantId?: string;
  action: string;
  target?: string;
  ip?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  /** SHA-256 hex of previous event for chain integrity */
  previousEventHash?: string;
  eventHash?: string;
}

export interface Alarm {
  id: string;
  deviceId?: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  createdAt: string;
  resolvedAt?: string;
  metadata?: Record<string, unknown>;
}

export type NotificationEventType =
  | 'task.created'
  | 'task.approved'
  | 'task.signed'
  | 'task.high_risk'
  | 'task.broad_targeting'
  | 'task.emergency_bypass'
  | 'kill_switch.activated'
  | 'kill_switch.deactivated'
  | 'signing_key.rotated'
  | 'new_admin_task'
  | 'task.outside_business_hours';

export interface TenantNotificationConfig {
  emailAddresses?: string[];
  slackWebhookUrl?: string;
  teamsWebhookUrl?: string;
  genericWebhookUrl?: string;
  notifyOn: NotificationEventType[];
}

export interface TenantPolicy {
  tenantId: string;
  /** Minimum seconds between task creation and earliest execution */
  minimumExecutionDelaySeconds: number;
  allowEmergencyBypass: boolean;
  requireMfaForTaskSigning: boolean;
  /** Normal/strict: 1, Tinfoil: 2 */
  requiredApprovalCount: number;
  /** For tasks with riskScore >= 70 */
  highRiskRequiredApprovalCount: number;
  securityMode: 'normal' | 'strict' | 'tinfoil';
  trustedSourceHosts: string[];
  allowedTaskTypes: string[];
  maintenanceWindows: Array<{ dayOfWeek?: number; startHourUtc: number; endHourUtc: number }>;
  requireVirusTotalForStrict: boolean;
  requireVirusTotalForTinfoil: boolean;
  /** Per-tenant VirusTotal API key — never relayed to nodes or clients */
  virusTotalApiKey?: string;
  defaultTaskTtlSeconds: number;
  broadTargetingThresholdPercent: number;
  notificationConfig?: TenantNotificationConfig;
  breakGlassKeyId?: string;
}

export interface SigningKeyMetadata {
  keyId: string;
  scope: SigningScope | '*';
  status: 'active' | 'trusted' | 'retired' | 'revoked';
  publicKeyPem: string;
  issuedAt: string;
  retiredAt?: string;
  /** Signatures valid until this date even after retirement */
  retirementDeadline?: string;
  revokedAt?: string;
  /** Dev-only keys are rejected by clients in production mode */
  isDev: boolean;
}

// ── SIEM ──────────────────────────────────────────────────────────────────────

export type SiemEventType =
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.mfa.success'
  | 'auth.mfa.failed'
  | 'task.created'
  | 'task.security_scan.completed'
  | 'task.approved'
  | 'task.signed'
  | 'task.executed'
  | 'task.failed'
  | 'task.revoked'
  | 'task.high_risk_detected'
  | 'task.mass_rollout_detected'
  | 'rule.triggered'
  | 'rule.executed'
  | 'rule.failed'
  | 'rule.conflict_detected'
  | 'rule.rate_limited'
  | 'rule_template.selected'
  | 'rule_template.draft_created'
  | 'rule_template.custom_created'
  | 'rule.created_from_template'
  | 'invalid_signature_detected'
  | 'replay_attack_blocked'
  | 'node.registered'
  | 'node.unhealthy'
  | 'node.certificate.issued'
  | 'node.certificate.revoked'
  | 'kill_switch.activated'
  | 'kill_switch.deactivated'
  | 'signing_key.rotated'
  | 'signing_key.revoked'
  | 'audit.chain.broken'
  | 'siem.test';

export type SiemSeverity = 'low' | 'medium' | 'high' | 'critical';
export type SiemMode = 'minimal' | 'standard' | 'full';

export interface SiemEvent {
  eventId: string;
  timestamp: string;
  tenantId: string;
  type: SiemEventType;
  severity: SiemSeverity;
  actor: {
    userId: string | null;
    nodeId: string | null;
    ip: string | null;
  };
  target: {
    taskId: string | null;
    deviceId: string | null;
    nodeId: string | null;
  };
  metadata: Record<string, unknown>;
  correlationId: string | null;
  previousEventHash?: string;
  eventHash?: string;
}

export interface SiemWebhookConfig {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
}

export interface SiemSyslogConfig {
  host: string;
  port: number;
  protocol: 'udp' | 'tcp';
  appName?: string;
}

export interface SiemSentinelConfig {
  workspaceId: string;
  sharedKey: string;
  logType: string;
}

export interface SiemSplunkConfig {
  url: string;
  token: string;
  index?: string;
  source?: string;
}

export interface SiemConfig {
  mode: SiemMode;
  enabled?: boolean;
  webhook?: SiemWebhookConfig;
  syslog?: SiemSyslogConfig;
  sentinel?: SiemSentinelConfig;
  splunk?: SiemSplunkConfig;
  exportOverrides?: Partial<Record<SiemEventType, boolean>>;
}

export interface TenantSiemConfig {
  tenantId: string;
  config: SiemConfig;
}

export interface SiemHealth {
  tenantId: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  lastError: string | null;
}
