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
  | 'audit:read';

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
  /** ISO timestamp set when the enrollment was created — tokens older than 24 h are rejected */
  enrollmentTokenCreatedAt: string;
  /** ISO timestamp set on first successful registration — any second use is rejected (one-time use) */
  enrollmentTokenUsedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  version?: string;
  capacity?: Record<string, unknown>;
  /** Serial number of the Vault-issued mTLS cert — used to revoke on decommission */
  tlsCertSerial?: string;
  /** ISO timestamp when the current mTLS cert expires — node should renew before this */
  tlsCertExpiresAt?: string;
  /**
   * Per-node decommission token (plaintext).
   * Returned to the node at registration and stored in .env as NODE_DECOMMISSION_TOKEN.  Management sends it when calling POST /node/decommission
   * on the backend node — it is unique per node and cannot be used against other nodes.
   */
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
  name: string;
  enabled: boolean;
  property: 'appName' | 'manufacturer' | 'guid' | 'packageId';
  operator: 'contains' | 'equals';
  value: string;
  targetVersion: 'latest' | string;
  maxVersion?: string;
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

export interface UpdateTask {
  id: string;
  nodeId: string;
  deviceId: string;
  appName?: string;
  packageArtifactId?: string;
  packageId?: string;
  productCode?: string;
  sourceUrl?: string;
  sha256?: string;
  installArgs?: string;
  targetVersion: 'latest' | string;
  type: 'update_package' | 'refresh_inventory';
  status: 'pending' | 'dispatched' | 'completed' | 'failed' | 'rejected' | 'cancelled';
  createdAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  output?: string;
}

export interface SignedEnvelope<T = unknown> {
  algorithm: 'ES256';
  keyId: string;
  payloadType: 'bootstrap_manifest' | 'rule_bundle' | 'task_bundle';
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payload: T;
  signature: string;
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

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  target?: string;
  ip?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
