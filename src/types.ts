export type SsoProviderType = 'microsoft' | 'google' | 'github' | 'okta' | 'oidc';

export interface SsoProvider {
  id: string;
  type: SsoProviderType;
  name: string;
  clientId: string;
  clientSecretEnc: string;      // AES-256-GCM: hex(iv):hex(authTag):hex(ciphertext)
  enabled: boolean;
  tenantId?: string;            // Microsoft: tenant ID, 'common', 'organizations'
  domain?: string;              // Okta: e.g., 'dev-12345.okta.com'
  discoveryUrl?: string;        // Generic OIDC: e.g., 'https://idp.example.com'
  allowedDomains?: string[];    // Restrict login to these email domains
  defaultRole?: Role;           // Role for auto-provisioned users (default: 'viewer')
  autoProvision: boolean;       // Create user account if none exists
  createdAt: string;
  updatedAt: string;
}

export type Role = string;

  
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

export interface RoleDefinition {
  id: Role;
  name: string;
  description?: string;
  permissions: Permission[];
  builtIn: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Signing scope — each key is scoped to exactly one payload type */
export type SigningScope =
  | 'bootstrap_manifest'
  | 'rule_bundle'
  | 'task_bundle'
  | 'task_ledger'
  | 'kill_switch'
  | 'recovery_task'
  | 'node_update';

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
  disabled?: boolean;
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
  healthState?: NodeHealthState;
  maintenanceState?: NodeMaintenanceState;
  quarantineState?: NodeQuarantineStateValue;
  trustScore?: number;
  capabilities?: NodeCapability[];
  signingPublicKeyPem?: string;
  updateChannel?: string;
  minimumAcceptedVersion?: string;
  drainingSince?: string;
  maintenanceReason?: string;
  quarantineReason?: string;
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

export type NodeCapability =
  | 'windows-patching'
  | 'linux-patching'
  | 'winget-cache'
  | 'chocolatey-cache'
  | 'yara-scan'
  | 'malware-scan'
  | 'file-reputation'
  | 'offline-cache'
  | 'regional-cache'
  | 'bandwidth-optimized';

export type NodeHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'stale' | 'quarantined';
export type NodeMaintenanceState = 'active' | 'draining' | 'maintenance';
export type NodeQuarantineStateValue = 'none' | 'quarantined' | 'pending_reapproval';
export type NodeQueueLag = 'low' | 'medium' | 'high';

export interface NodeProfile {
  nodeId: string;
  region?: string;
  site?: string;
  publicUrl: string;
  capabilities: NodeCapability[];
  signingPublicKeyPem?: string;
  updateChannel?: string;
  maintenanceState: NodeMaintenanceState;
  quarantineState: NodeQuarantineStateValue;
  createdAt: string;
  updatedAt: string;
}

export interface NodeSignedEnvelope<T = unknown> {
  algorithm: 'ES256';
  nodeId: string;
  payloadType:
    | 'node_health_report'
    | 'node_reachability_probe'
    | 'cross_node_probe_report'
    | 'cache_artifact_attestation'
    | 'node_version_attestation';
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadHash: string;
  payload: T;
  signature: string;
}

export interface NodeChallengeNonce {
  id: string;
  nodeId: string;
  purpose: NodeSignedEnvelope['payloadType'];
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface NodeHealthComponent {
  name:
    | 'reachability'
    | 'event_queue'
    | 'database'
    | 'certificate'
    | 'scanner'
    | 'disk'
    | 'memory'
    | 'clock'
    | 'update_source'
    | 'cache'
    | 'package_verifier';
  status: 'ok' | 'degraded' | 'unhealthy';
  observedAt: string;
  message?: string;
  value?: number | string | boolean;
}


/** Structured security posture finding for a backend node */
export interface NodeSecurityFinding {
  /** Machine-readable code e.g. SSH_ROOT_LOGIN_PERMITTED, NO_FIREWALL, NODE_AGE_NEW */
  code: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  category: "os_security" | "ip_reputation" | "node_age" | "configuration" | "health";
  message: string;
  remediationHint?: string;
}

export interface NodeHealthReport {
  nodeId: string;
  reportedAt: string;
  managementUrl?: string;
  publicUrl?: string;
  version?: string;
  region?: string;
  site?: string;
  latencyMs?: number;
  queueSize: number;
  queueLag: NodeQueueLag;
  diskFreeBytes?: number;
  memoryPressurePercent?: number;
  clockSkewMs?: number;
  certExpiresAt?: string;
  scannerHealthy: boolean;
  cacheHealthy: boolean;
  packageVerifierHealthy: boolean;
  updateSourceReachable: boolean;
  components: NodeHealthComponent[];
  capabilities: NodeCapability[];
  /** Platform-specific OS security posture findings self-reported by the node */
  securityFindings?: NodeSecurityFinding[];
  /** Basic OS metadata for server-side context */
  osInfo?: { platform: string; release?: string };
}

export interface NodeTrustSnapshot {
  id: string;
  nodeId: string;
  healthy: boolean;
  healthState: NodeHealthState;
  latencyMs?: number;
  lastSeenSeconds?: number;
  certValid: boolean;
  scannerHealthy: boolean;
  suspiciousEvents: number;
  queueLag: NodeQueueLag;
  previousTrustScore?: number;
  trustScore: number;
  scoreDelta?: number;
  maxTrustScore?: number;
  reasons: string[];
  /** Structured findings driving the trust score, grouped by category for the UI */
  securityFindings?: NodeSecurityFinding[];
  createdAt: string;
}

export interface NodeRoutingPolicy {
  id: string;
  tenantId: string;
  mode: 'standard' | 'eu_only' | 'region_pinned' | 'high_security' | 'offline_local_only';
  pinnedRegion?: string;
  preferredNodeIds: string[];
  excludedNodeIds: string[];
  trustedOnly: boolean;
  requiredCapabilities: NodeCapability[];
  localSite?: string;
  updatedAt: string;
}

export interface RouteCandidate {
  nodeId: string;
  publicUrl: string;
  region?: string;
  site?: string;
  capabilities: NodeCapability[];
  healthy: boolean;
  healthState: NodeHealthState;
  latencyMs?: number;
  trustScore: number;
  maintenanceState: NodeMaintenanceState;
  quarantineState: NodeQuarantineStateValue;
  priority: number;
  weight: number;
  reasons: string[];
}

export interface RouteDecision {
  id: string;
  tenantId: string;
  deviceId?: string;
  selectedNodeId?: string;
  candidates: RouteCandidate[];
  policyId?: string;
  requiredCapabilities: NodeCapability[];
  reason: string;
  correlationId?: string;
  createdAt: string;
}

export interface CrossNodeProbeReport {
  id: string;
  reporterNodeId: string;
  targetNodeId: string;
  region?: string;
  reachable: boolean;
  latencyMs?: number;
  trustValid: boolean;
  reportedAt: string;
  details?: Record<string, unknown>;
}

export interface CacheArtifactAttestation {
  id: string;
  nodeId: string;
  packageArtifactId: string;
  sha256: string;
  verified: boolean;
  signatureValid?: boolean;
  sizeBytes?: number;
  expiresAt?: string;
  observedAt: string;
  reason?: string;
}

export interface FileReputationReport {
  id: string;
  packageArtifactId?: string;
  sha256: string;
  scannedAt: string;
  source: 'management' | 'backend-node';
  nodeId?: string;
  authenticodeStatus?: 'valid' | 'invalid' | 'unsigned' | 'unknown';
  vendorVerified?: boolean;
  allowlisted: boolean;
  denylisted: boolean;
  suspiciousFilename: boolean;
  suspiciousPath: boolean;
  entropyScore?: number;
  packedBinarySuspected?: boolean;
  yaraMatches: string[];
  virusTotal?: {
    available: boolean;
    positives?: number;
    total?: number;
    permalink?: string;
    checkedAt: string;
  };
  riskScore: number;
  verdict: 'trusted' | 'unknown' | 'suspicious' | 'malicious';
  reasons: string[];
}

export interface NodeQuarantineEvent {
  id: string;
  nodeId: string;
  trigger:
    | 'invalid_signature'
    | 'replay_attempt'
    | 'trust_score_low'
    | 'repeated_failures'
    | 'integrity_mismatch'
    | 'certificate_issue'
    | 'manual';
  reason: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface NodeUpdateCampaign {
  id: string;
  version: string;
  minVersion?: string;
  channel: string;
  artifactUrl: string;
  sha256: string;
  signature: string;
  stagedPercent: number;
  rollbackVersion?: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'rolled_back';
  createdAt: string;
  updatedAt: string;
}

export interface NodeVersionAttestation {
  id: string;
  nodeId: string;
  version: string;
  channel?: string;
  updateCampaignId?: string;
  artifactSha256?: string;
  signatureValid: boolean;
  rollbackAvailable: boolean;
  attestedAt: string;
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
  packageManager?: PackageManager;
  packageScope?: PackageScope;
  productCode?: string;
}

export type PackageManager = 'winget' | 'chocolatey' | 'scoop' | 'apt' | 'snap' | 'flatpak' | 'brew' | 'dnf' | 'pacman' | 'msi' | 'exe';
export type PackageScope = 'system' | 'global' | 'user';

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
      packageNames?: string[];
      packageId?: string;
      packageManager?: PackageManager;
      packageScope?: PackageScope;
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
  type: PackageManager;
  packageId?: string;
  packageManager?: PackageManager;
  packageScope?: PackageScope;
  fileName?: string;
  storagePath?: string;
  sourceUrl?: string;
  managementSourceUrl?: string;
  sha256?: string;
  signatureStatus: 'unknown' | 'valid' | 'invalid' | 'unsigned';
  fileReputation?: FileReputationReport;
  cacheAttestations?: CacheArtifactAttestation[];
  installArgs: string;
  uninstallArgs?: string;
  applicability: {
    os?: string;
    appName?: string;
    manufacturer?: string;
    productCode?: string;
  };
  catalogSource?: 'central' | 'custom';
  catalogCategory?: string;
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
  fileReputation?: FileReputationReport;
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
  packageManager?: PackageManager;
  packageScope?: PackageScope;
  productCode?: string;
  sourceUrl?: string;
  managementSourceUrl?: string;
  sha256?: string;
  requiredCapabilities?: NodeCapability[];
  routingPolicyId?: string;
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
  algorithm: 'ES256';
  scope: 'task_ledger';
  issuedAt: string;
  nonce: string;
  payloadHash: string;
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
  scope: SigningScope;
  payloadType: SigningScope;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  /** SHA-256 hex of canonical payload. Required for all new signatures. */
  payloadHash: string;
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
  scope: SigningScope;
  status: 'active' | 'trusted' | 'retired' | 'revoked';
  publicKeyPem: string;
  issuedAt: string;
  retiredAt?: string;
  /** Signatures valid until this date even after retirement */
  retirementDeadline?: string;
  revokedAt?: string;
  /** Dev-only keys are rejected by clients in production mode */
  isDev: boolean;
  algorithm: 'ES256';
  allowedTenants?: string[];
}

// ── Device Retirement Policies ────────────────────────────────────────────────

export type RetirementCriterionType =
  | 'inactive_days'        // device not seen for N days
  | 'os_pattern'           // OS name contains pattern (case-insensitive)
  | 'trust_score_below'    // deviceTrustScore < threshold
  | 'risk_score_above'     // riskScore > threshold
  | 'has_tag'              // device has this tag
  | 'missing_tag'          // device lacks this tag
  | 'in_group'             // device belongs to this group
  | 'os_family';           // 'windows' | 'linux'

export type RetirementPolicyCriterion =
  | { type: 'inactive_days'; days: number }
  | { type: 'os_pattern'; pattern: string }
  | { type: 'trust_score_below'; score: number }
  | { type: 'risk_score_above'; score: number }
  | { type: 'has_tag'; tag: string }
  | { type: 'missing_tag'; tag: string }
  | { type: 'in_group'; group: string }
  | { type: 'os_family'; os: 'windows' | 'linux' };

export type RetirementPolicyAction =
  | { type: 'tag_device'; tag: string }
  | { type: 'create_alarm'; severity: 'info' | 'warning' | 'critical'; message: string }
  | { type: 'notify'; channel: 'siem' | 'webhook' | 'email'; message?: string };

export interface DeviceRetirementPolicy {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Logical combinator for conditions */
  conditionCombinator: 'AND' | 'OR';
  conditions: RetirementPolicyCriterion[];
  actions: RetirementPolicyAction[];
  /** Lower number = evaluated first */
  priority: number;
  /** Cached count from last evaluation */
  matchCount?: number;
  lastEvaluatedAt?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ── SIEM ──────────────────────────────────────────────────────────────────────

export type SiemEventType =
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.mfa.success'
  | 'auth.mfa.failed'
  | 'auth.logout'
  | 'auth.sso.login.success'
  | 'auth.sso.login.failed'
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
  | 'node.health.accepted'
  | 'node.routing.decision'
  | 'node.quarantined'
  | 'node.quarantine.cleared'
  | 'node.trust.changed'
  | 'node.update.attested'
  | 'node.cache.attested'
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
