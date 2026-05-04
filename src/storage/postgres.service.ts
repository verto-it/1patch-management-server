import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import {
  Alarm, AuditEvent, BackendNode, ClientEnrollment, Device, InstalledApp,
  KillSwitchState, PackageArtifact, PatchRule, SiemEvent, TaskLedgerEntry,
  UpdateTask, User,
} from '../types';

export interface StoreSnapshot {
  users: User[];
  backendNodes: BackendNode[];
  clientEnrollments: ClientEnrollment[];
  devices: Device[];
  installedApps: InstalledApp[];
  packages: PackageArtifact[];
  rules: PatchRule[];
  tasks: UpdateTask[];
  alarms: Alarm[];
  auditEvents: AuditEvent[];
  taskLedger: TaskLedgerEntry[];
  killSwitchStates: KillSwitchState[];
}

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresService.name);
  private readonly pool?: Pool;
  private lastError?: string;
  private saveQueue = Promise.resolve();

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      this.logger.warn('DATABASE_URL is not configured; management data will not be durable');
      return;
    }
    this.pool = new Pool({ connectionString });
  }

  async onModuleInit() {
    await this.ensureSchema({ throwOnError: false });
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  isConfigured() {
    return Boolean(this.pool);
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      available: this.isConfigured() && !this.lastError,
      lastError: this.lastError,
    };
  }

  async ensureSchema(options: { throwOnError?: boolean } = {}) {
    if (!this.pool) {
      if (options.throwOnError) throw new Error('DATABASE_URL is not configured');
      return;
    }
    try {
      await this.pool.query(phase3SchemaSql);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`PostgreSQL is not available yet: ${this.lastError}`);
      if (options.throwOnError) throw error;
    }
  }

  async loadSnapshot(): Promise<StoreSnapshot | undefined> {
    if (!this.pool) return undefined;
    try {
      const [users, nodes, clientEnrollments, devices, apps, packages, rules, tasks, alarms, audit, ledger, killSwitch] = await Promise.all([
        this.pool.query('select * from users order by created_at asc'),
        this.pool.query('select * from backend_nodes order by name asc'),
        this.pool.query('select * from client_enrollments order by created_at desc'),
        this.pool.query('select * from devices order by hostname asc'),
        this.pool.query('select * from installed_apps order by name asc'),
        this.pool.query('select * from package_artifacts order by name asc, version desc'),
        this.pool.query('select * from patch_rules order by created_at asc'),
        this.pool.query('select * from update_tasks order by created_at asc'),
        this.pool.query('select * from alarms order by created_at desc'),
        this.pool.query('select * from audit_events order by created_at desc limit 1000'),
        this.pool.query('select * from task_ledger order by created_at desc limit 5000'),
        this.pool.query('select * from kill_switch_states order by tenant_id asc'),
      ]);
      this.lastError = undefined;
      return {
        users: users.rows.map(rowToUser),
        backendNodes: nodes.rows.map(rowToNode),
        clientEnrollments: clientEnrollments.rows.map(rowToClientEnrollment),
        devices: devices.rows.map(rowToDevice),
        installedApps: apps.rows.map(rowToInstalledApp),
        packages: packages.rows.map(rowToPackage),
        rules: rules.rows.map(rowToRule),
        tasks: tasks.rows.map(rowToTask),
        alarms: alarms.rows.map(rowToAlarm),
        auditEvents: audit.rows.map(rowToAudit),
        taskLedger: ledger.rows.map(rowToTaskLedger),
        killSwitchStates: killSwitch.rows.map(rowToKillSwitchState),
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not load PostgreSQL snapshot: ${this.lastError}`);
      return undefined;
    }
  }

  async saveSnapshot(snapshot: StoreSnapshot) {
    if (!this.pool) return;
    const durableSnapshot = normalizeSnapshot(snapshot);
    this.saveQueue = this.saveQueue.then(
      () => this.writeSnapshot(durableSnapshot),
      () => this.writeSnapshot(durableSnapshot),
    );
    await this.saveQueue;
  }

  private async writeSnapshot(snapshot: StoreSnapshot) {
    if (!this.pool) return;
    const client = await this.pool.connect().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not persist PostgreSQL snapshot: ${this.lastError}`);
      return undefined;
    });
    if (!client) return;
    try {
      await client.query('begin');
      await client.query('delete from installed_apps');
      await client.query('delete from package_artifacts');
      await client.query('delete from audit_events');
      await client.query('delete from task_ledger');
      await client.query('delete from kill_switch_states');
      await client.query('delete from alarms');
      await client.query('delete from update_tasks');
      await client.query('delete from patch_rules');
      await client.query('delete from devices');
      await client.query('delete from client_enrollments');
      await client.query('delete from backend_nodes');
      await client.query('delete from users');

      for (const user of snapshot.users) {
        await client.query(
          `insert into users (id, email, password_hash, roles, mfa_enabled, mfa_secret, recovery_code_hashes, failed_attempts, locked_until, last_login_at, last_login_country, oauth_links)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [user.id, user.email, user.passwordHash, user.roles, user.mfaEnabled, user.mfaSecret, user.recoveryCodeHashes, user.failedAttempts, user.lockedUntil, user.lastLoginAt, user.lastLoginCountry, JSON.stringify(user.oauthLinks)],
        );
      }
      for (const node of snapshot.backendNodes) {
        await client.query(
          `insert into backend_nodes (id, name, public_url, region, site, status, enrollment_token_hash, enrollment_token_created_at, enrollment_token_used_at, first_seen_at, last_seen_at, version, capacity, tls_cert_serial, tls_cert_expires_at, decommission_token_hash)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [node.id, node.name, node.publicUrl, node.region, node.site, node.status, node.enrollmentTokenHash, node.enrollmentTokenCreatedAt, node.enrollmentTokenUsedAt, node.firstSeenAt, node.lastSeenAt, node.version, JSON.stringify(node.capacity ?? {}), node.tlsCertSerial, node.tlsCertExpiresAt, node.decommissionToken],
        );
      }
      for (const enrollment of snapshot.clientEnrollments ?? []) {
        await client.query(
          `insert into client_enrollments (id, tenant_id, mode, enrollment_token_hash, max_uses, uses, used_device_ids, client_name, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [enrollment.id, enrollment.tenantId, enrollment.mode, enrollment.enrollmentTokenHash, enrollment.maxUses, enrollment.uses, enrollment.usedDeviceIds, enrollment.clientName, enrollment.createdAt],
        );
      }
      for (const device of snapshot.devices) {
        await client.query(
          `insert into devices (id, tenant_id, hostname, os, public_key, last_seen_at, preferred_node_id)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [device.id, device.tenantId, device.hostname, device.os, device.publicKey, device.lastSeenAt, device.preferredNodeId],
        );
      }
      for (const app of snapshot.installedApps) {
        await client.query(
          `insert into installed_apps (device_id, name, publisher, version, package_id, product_code)
           values ($1,$2,$3,$4,$5,$6)`,
          [app.deviceId, app.name, app.publisher, app.version, app.packageId, app.productCode],
        );
      }
      for (const artifact of snapshot.packages) {
        await client.query(
          `insert into package_artifacts (id, name, publisher, version, architecture, platform, type, package_id, file_name, storage_path, source_url, sha256, signature_status, install_args, uninstall_args, applicability, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            artifact.id,
            artifact.name,
            artifact.publisher,
            artifact.version,
            artifact.architecture,
            artifact.platform,
            artifact.type,
            artifact.packageId,
            artifact.fileName,
            artifact.storagePath,
            artifact.sourceUrl,
            artifact.sha256,
            artifact.signatureStatus,
            artifact.installArgs,
            artifact.uninstallArgs,
            JSON.stringify(artifact.applicability ?? {}),
            artifact.createdAt,
          ],
        );
      }
      for (const rule of snapshot.rules) {
        await client.query(
          `insert into patch_rules (id, name, enabled, property, operator, value, target_version, max_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rule.id, rule.name, rule.enabled, rule.property, rule.operator, rule.value, rule.targetVersion, rule.maxVersion],
        );
      }
      for (const task of snapshot.tasks) {
        await client.query(
          `insert into update_tasks (id, node_id, device_id, app_name, package_artifact_id, package_id, product_code, source_url, sha256, install_args, target_version, type, status, created_at, dispatched_at, completed_at, output)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            task.id,
            task.nodeId,
            task.deviceId,
            task.appName,
            task.packageArtifactId,
            task.packageId,
            task.productCode,
            task.sourceUrl,
            task.sha256,
            task.installArgs,
            task.targetVersion,
            task.type,
            task.status,
            task.createdAt,
            task.dispatchedAt,
            task.completedAt,
            task.output,
          ],
        );
      }
      for (const alarm of snapshot.alarms) {
        await client.query(
          `insert into alarms (id, device_id, severity, message, created_at, resolved_at, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [alarm.id, alarm.deviceId, alarm.severity, alarm.message, alarm.createdAt, alarm.resolvedAt, JSON.stringify(alarm.metadata ?? {})],
        );
      }
      for (const event of snapshot.auditEvents) {
        await client.query(
          `insert into audit_events (id, actor, action, target, ip, created_at, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [event.id, event.actor, event.action, event.target, event.ip, event.createdAt, JSON.stringify(event.metadata ?? {})],
        );
      }
      for (const entry of snapshot.taskLedger) {
        await client.query(
          `insert into task_ledger (ledger_id, task_id, tenant_id, created_by, created_at, visible_in_dashboard, task_hash, risk_score, approvals, not_before, expires_at, key_id, signature, state, revoked_at, revoked_reason, superseded_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            entry.ledgerId, entry.taskId, entry.tenantId, entry.createdBy, entry.createdAt,
            entry.visibleInDashboard, entry.taskHash, entry.riskScore, JSON.stringify(entry.approvals ?? []),
            entry.notBefore, entry.expiresAt, entry.keyId, entry.signature, entry.state,
            entry.revokedAt, entry.revokedReason, entry.supersededBy,
          ],
        );
      }
      for (const state of snapshot.killSwitchStates) {
        await client.query(
          `insert into kill_switch_states (id, tenant_id, active, activated_at, activated_by, deactivated_at, deactivated_by, reason, signature, key_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            state.id, state.tenantId, state.active, state.activatedAt, state.activatedBy,
            state.deactivatedAt, state.deactivatedBy, state.reason, state.signature, state.keyId,
          ],
        );
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not persist PostgreSQL snapshot: ${this.lastError}`);
    } finally {
      client.release();
    }
  }

  async appendSiemEvent(event: SiemEvent) {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `insert into siem_events (event_id, timestamp, tenant_id, type, severity, actor, target, metadata, correlation_id, previous_event_hash, event_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (event_id) do nothing`,
        [
          event.eventId,
          event.timestamp,
          event.tenantId,
          event.type,
          event.severity,
          JSON.stringify(event.actor),
          JSON.stringify(event.target),
          JSON.stringify(event.metadata ?? {}),
          event.correlationId,
          event.previousEventHash,
          event.eventHash,
        ],
      );
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not append SIEM event to PostgreSQL: ${this.lastError}`);
    }
  }
}

export const phase3SchemaSql = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  roles text[] not null,
  mfa_enabled boolean not null default false,
  mfa_secret text,
  recovery_code_hashes text[] not null default '{}',
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  last_login_country text,
  oauth_links jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create table if not exists backend_nodes (
  id text primary key,
  name text not null,
  public_url text not null,
  region text,
  site text,
  status text not null,
  enrollment_token_hash text not null,
  enrollment_token_used_at timestamptz,
  last_seen_at timestamptz,
  version text,
  capacity jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table backend_nodes add column if not exists enrollment_token_used_at timestamptz;
alter table backend_nodes add column if not exists enrollment_token_created_at timestamptz;
alter table backend_nodes add column if not exists first_seen_at timestamptz;
alter table backend_nodes add column if not exists tls_cert_serial text;
alter table backend_nodes add column if not exists tls_cert_expires_at timestamptz;
alter table backend_nodes add column if not exists decommission_token_hash text; -- stores plaintext per-node decommission token
create table if not exists task_ledger (
  ledger_id text primary key,
  task_id text not null,
  tenant_id text not null,
  created_by text not null,
  created_at timestamptz not null,
  visible_in_dashboard boolean not null default true,
  task_hash text not null,
  risk_score integer not null,
  approvals jsonb not null default '[]',
  not_before timestamptz not null,
  expires_at timestamptz not null,
  key_id text not null,
  signature text not null,
  state text not null,
  revoked_at timestamptz,
  revoked_reason text,
  superseded_by text
);
create index if not exists task_ledger_task_idx on task_ledger(task_id);
create index if not exists task_ledger_tenant_idx on task_ledger(tenant_id);
create table if not exists kill_switch_states (
  id text primary key,
  tenant_id text not null unique,
  active boolean not null,
  activated_at timestamptz,
  activated_by text,
  deactivated_at timestamptz,
  deactivated_by text,
  reason text,
  signature text not null,
  key_id text not null
);
create table if not exists siem_events (
  event_id text primary key,
  timestamp timestamptz not null,
  tenant_id text not null,
  type text not null,
  severity text not null,
  actor jsonb not null,
  target jsonb not null,
  metadata jsonb not null default '{}',
  correlation_id text,
  previous_event_hash text,
  event_hash text
);
create index if not exists siem_events_tenant_timestamp_idx on siem_events(tenant_id, timestamp desc);
create index if not exists siem_events_type_idx on siem_events(type);
create table if not exists client_enrollments (
  id text primary key,
  tenant_id text not null,
  mode text not null,
  enrollment_token_hash text not null,
  max_uses integer not null,
  uses integer not null default 0,
  used_device_ids text[] not null default '{}',
  client_name text,
  created_at timestamptz not null default now()
);
create table if not exists devices (
  id text primary key,
  tenant_id text not null,
  hostname text not null,
  os text not null,
  public_key text not null,
  last_seen_at timestamptz,
  preferred_node_id text,
  created_at timestamptz not null default now()
);
create table if not exists installed_apps (
  id bigserial primary key,
  device_id text not null,
  name text not null,
  publisher text not null,
  version text not null,
  package_id text,
  product_code text
);
create index if not exists installed_apps_device_id_idx on installed_apps(device_id);
create index if not exists installed_apps_name_idx on installed_apps(name);
create table if not exists package_artifacts (
  id text primary key,
  name text not null,
  publisher text not null,
  version text not null,
  architecture text not null,
  platform text not null,
  type text not null,
  package_id text,
  file_name text,
  storage_path text,
  source_url text,
  sha256 text not null,
  signature_status text not null,
  install_args text not null,
  uninstall_args text,
  applicability jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists package_artifacts_name_version_idx on package_artifacts(name, version);
create table if not exists patch_rules (
  id text primary key,
  name text not null,
  enabled boolean not null default true,
  property text not null,
  operator text not null,
  value text not null,
  target_version text not null,
  max_version text,
  created_at timestamptz not null default now()
);
create table if not exists update_tasks (
  id text primary key,
  node_id text not null,
  device_id text not null,
  app_name text,
  package_artifact_id text,
  package_id text,
  product_code text,
  source_url text,
  sha256 text,
  install_args text,
  target_version text not null,
  type text not null,
  status text not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  output text
);
create index if not exists update_tasks_node_status_idx on update_tasks(node_id, status);
create index if not exists update_tasks_device_idx on update_tasks(device_id);
create table if not exists alarms (
  id text primary key,
  device_id text,
  severity text not null,
  message text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'
);
create table if not exists audit_events (
  id text primary key,
  actor text not null,
  action text not null,
  target text,
  ip text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);
`;

function rowToUser(row: Record<string, any>): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    roles: row.roles,
    mfaEnabled: row.mfa_enabled,
    mfaSecret: row.mfa_secret,
    recoveryCodeHashes: row.recovery_code_hashes ?? [],
    failedAttempts: row.failed_attempts,
    lockedUntil: toIso(row.locked_until),
    lastLoginAt: toIso(row.last_login_at),
    lastLoginCountry: row.last_login_country,
    oauthLinks: row.oauth_links ?? [],
  };
}

function rowToNode(row: Record<string, any>): BackendNode {
  return {
    id: row.id,
    name: row.name,
    publicUrl: row.public_url,
    region: row.region,
    site: row.site,
    status: row.status,
    enrollmentTokenHash: row.enrollment_token_hash,
    enrollmentTokenCreatedAt: toIso(row.enrollment_token_created_at) ?? new Date().toISOString(),
    enrollmentTokenUsedAt: toIso(row.enrollment_token_used_at),
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    version: row.version,
    capacity: row.capacity ?? {},
    tlsCertSerial: row.tls_cert_serial,
    tlsCertExpiresAt: toIso(row.tls_cert_expires_at),
    decommissionToken: row.decommission_token_hash,
  };
}

function rowToClientEnrollment(row: Record<string, any>): ClientEnrollment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    mode: row.mode,
    enrollmentTokenHash: row.enrollment_token_hash,
    maxUses: row.max_uses,
    uses: row.uses,
    usedDeviceIds: row.used_device_ids ?? [],
    clientName: row.client_name,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

function rowToDevice(row: Record<string, any>): Device {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    hostname: row.hostname,
    os: row.os,
    publicKey: row.public_key,
    lastSeenAt: toIso(row.last_seen_at),
    preferredNodeId: row.preferred_node_id,
  };
}

function rowToInstalledApp(row: Record<string, any>): InstalledApp {
  return {
    deviceId: row.device_id,
    name: row.name,
    publisher: row.publisher,
    version: row.version,
    packageId: row.package_id,
    productCode: row.product_code,
  };
}

function rowToRule(row: Record<string, any>): PatchRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    property: row.property,
    operator: row.operator,
    value: row.value,
    targetVersion: row.target_version,
    maxVersion: row.max_version,
  };
}

function rowToPackage(row: Record<string, any>): PackageArtifact {
  return {
    id: row.id,
    name: row.name,
    publisher: row.publisher,
    version: row.version,
    architecture: row.architecture,
    platform: row.platform,
    type: row.type,
    packageId: row.package_id,
    fileName: row.file_name,
    storagePath: row.storage_path,
    sourceUrl: row.source_url,
    sha256: row.sha256,
    signatureStatus: row.signature_status,
    installArgs: row.install_args,
    uninstallArgs: row.uninstall_args,
    applicability: row.applicability ?? {},
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

function rowToTask(row: Record<string, any>): UpdateTask {
  return {
    id: row.id,
    nodeId: row.node_id,
    deviceId: row.device_id,
    appName: row.app_name,
    packageArtifactId: row.package_artifact_id,
    packageId: row.package_id,
    productCode: row.product_code,
    sourceUrl: row.source_url,
    sha256: row.sha256,
    installArgs: row.install_args,
    targetVersion: row.target_version,
    type: row.type,
    status: row.status,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    dispatchedAt: toIso(row.dispatched_at),
    completedAt: toIso(row.completed_at),
    output: row.output,
  };
}

function rowToAlarm(row: Record<string, any>): Alarm {
  return {
    id: row.id,
    deviceId: row.device_id,
    severity: row.severity,
    message: row.message,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    resolvedAt: toIso(row.resolved_at),
    metadata: row.metadata ?? {},
  };
}

function rowToAudit(row: Record<string, any>): AuditEvent {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    ip: row.ip,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    metadata: row.metadata ?? {},
  };
}

function rowToTaskLedger(row: Record<string, any>): TaskLedgerEntry {
  return {
    ledgerId: row.ledger_id,
    taskId: row.task_id,
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    visibleInDashboard: true,
    taskHash: row.task_hash,
    riskScore: row.risk_score,
    approvals: row.approvals ?? [],
    notBefore: toIso(row.not_before) ?? new Date().toISOString(),
    expiresAt: toIso(row.expires_at) ?? new Date().toISOString(),
    keyId: row.key_id,
    signature: row.signature,
    state: row.state,
    revokedAt: toIso(row.revoked_at),
    revokedReason: row.revoked_reason,
    supersededBy: row.superseded_by,
  };
}

function rowToKillSwitchState(row: Record<string, any>): KillSwitchState {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    active: row.active,
    activatedAt: toIso(row.activated_at),
    activatedBy: row.activated_by,
    deactivatedAt: toIso(row.deactivated_at),
    deactivatedBy: row.deactivated_by,
    reason: row.reason,
    signature: row.signature,
    keyId: row.key_id,
  };
}

function toIso(value: unknown) {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

export function normalizeSnapshot(snapshot: StoreSnapshot): StoreSnapshot {
  return {
    users: uniqueById(snapshot.users),
    backendNodes: uniqueById(snapshot.backendNodes),
    clientEnrollments: uniqueById(snapshot.clientEnrollments ?? []),
    devices: uniqueById(snapshot.devices),
    installedApps: [...snapshot.installedApps],
    packages: uniqueById(snapshot.packages),
    rules: uniqueById(snapshot.rules),
    tasks: uniqueById(snapshot.tasks),
    alarms: uniqueById(snapshot.alarms),
    auditEvents: uniqueById(snapshot.auditEvents),
    taskLedger: uniqueBy(snapshot.taskLedger ?? [], (entry) => entry.ledgerId),
    killSwitchStates: uniqueById(snapshot.killSwitchStates ?? []),
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return uniqueBy(items, (item) => item.id);
}

function uniqueBy<T>(items: T[], id: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = id(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
