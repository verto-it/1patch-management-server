import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { computeEventHash } from '../audit/audit.hash';
import {
  Alarm, AuditEvent, BackendNode, ClientEnrollment, Device,
  CacheArtifactAttestation, CrossNodeProbeReport, FileReputationReport,
  InstalledApp, KillSwitchState, NodeChallengeNonce, NodeHealthReport, NodeQuarantineEvent, NodeRoutingPolicy,
  NodeTrustSnapshot, NodeUpdateCampaign, NodeVersionAttestation, PackageArtifact,
  PatchRule, RouteDecision, RuleTemplate, SsoProvider, TaskLedgerEntry, TenantPolicy, UpdateTask, User,
} from '../types';
import { DragonflyService } from './dragonfly.service';
import { normalizeSnapshot, PostgresService, StoreSnapshot } from './postgres.service';

@Injectable()
export class MemoryStore implements OnModuleInit {
  private readonly logger = new Logger(MemoryStore.name);
  private readonly snapshotKey = '1patch:management:snapshot:v1';

  /**
   * Creates a MemoryStore instance with its required collaborators.
   *
   * @param dragonfly dragonfly supplied to the function.
   * @param postgres postgres supplied to the function.
   */
  constructor(
    private readonly dragonfly: DragonflyService,
    private readonly postgres: PostgresService,
  ) {}

  users: User[] = [];
  backendNodes: BackendNode[] = [];
  clientEnrollments: ClientEnrollment[] = [];
  devices: Device[] = [];
  installedApps: InstalledApp[] = [];
  packages: PackageArtifact[] = [];
  rules: PatchRule[] = [];
  ruleTemplates: RuleTemplate[] = [];
  tasks: UpdateTask[] = [];
  alarms: Alarm[] = [];
  auditEvents: AuditEvent[] = [];
  taskLedger: TaskLedgerEntry[] = [];
  killSwitchStates: KillSwitchState[] = [];
  tenantPolicies: TenantPolicy[] = [];
  ssoProviders: SsoProvider[] = [];
  nodeRoutingPolicies: NodeRoutingPolicy[] = [];
  nodeChallengeNonces: NodeChallengeNonce[] = [];
  nodeHealthReports: NodeHealthReport[] = [];
  nodeTrustHistory: NodeTrustSnapshot[] = [];
  nodeRouteDecisions: RouteDecision[] = [];
  crossNodeProbeReports: CrossNodeProbeReport[] = [];
  cacheAttestations: CacheArtifactAttestation[] = [];
  fileReputationReports: FileReputationReport[] = [];
  nodeQuarantineEvents: NodeQuarantineEvent[] = [];
  nodeUpdateCampaigns: NodeUpdateCampaign[] = [];
  nodeVersionAttestations: NodeVersionAttestation[] = [];

  /**
   * Handles the on module init operation for MemoryStore.
   */
  async onModuleInit() {
    const loaded = (await this.postgres.loadSnapshot()) ?? (await this.loadDragonflySnapshot());
    if (!loaded) return;
    const snapshot = normalizeSnapshot({
      users: loaded.users ?? [],
      backendNodes: loaded.backendNodes ?? [],
      clientEnrollments: loaded.clientEnrollments ?? [],
      devices: loaded.devices ?? [],
      installedApps: loaded.installedApps ?? [],
      packages: loaded.packages ?? [],
      rules: loaded.rules ?? [],
      ruleTemplates: (loaded as any).ruleTemplates ?? [],
      tasks: loaded.tasks ?? [],
      alarms: loaded.alarms ?? [],
      auditEvents: loaded.auditEvents ?? [],
      taskLedger: (loaded as any).taskLedger ?? [],
      killSwitchStates: (loaded as any).killSwitchStates ?? [],
      tenantPolicies: (loaded as any).tenantPolicies ?? [],
      nodeRoutingPolicies: (loaded as any).nodeRoutingPolicies ?? [],
      nodeChallengeNonces: (loaded as any).nodeChallengeNonces ?? [],
      nodeHealthReports: (loaded as any).nodeHealthReports ?? [],
      nodeTrustHistory: (loaded as any).nodeTrustHistory ?? [],
      nodeRouteDecisions: (loaded as any).nodeRouteDecisions ?? [],
      crossNodeProbeReports: (loaded as any).crossNodeProbeReports ?? [],
      cacheAttestations: (loaded as any).cacheAttestations ?? [],
      fileReputationReports: (loaded as any).fileReputationReports ?? [],
      nodeQuarantineEvents: (loaded as any).nodeQuarantineEvents ?? [],
      nodeUpdateCampaigns: (loaded as any).nodeUpdateCampaigns ?? [],
      nodeVersionAttestations: (loaded as any).nodeVersionAttestations ?? [],
    });
    this.users = snapshot.users;
    this.backendNodes = snapshot.backendNodes;
    this.clientEnrollments = snapshot.clientEnrollments;
    this.devices = snapshot.devices;
    this.installedApps = snapshot.installedApps;
    this.packages = snapshot.packages;
    this.rules = snapshot.rules;
    this.ruleTemplates = (snapshot as any).ruleTemplates ?? [];
    this.tasks = snapshot.tasks;
    this.alarms = snapshot.alarms;
    this.auditEvents = snapshot.auditEvents;
    this.taskLedger = (snapshot as any).taskLedger ?? [];
    this.killSwitchStates = (snapshot as any).killSwitchStates ?? [];
    this.tenantPolicies = (snapshot as any).tenantPolicies ?? [];
    this.ssoProviders = (loaded as any).ssoProviders ?? [];
    this.nodeRoutingPolicies = (snapshot as any).nodeRoutingPolicies ?? [];
    this.nodeChallengeNonces = (snapshot as any).nodeChallengeNonces ?? [];
    this.nodeHealthReports = (snapshot as any).nodeHealthReports ?? [];
    this.nodeTrustHistory = (snapshot as any).nodeTrustHistory ?? [];
    this.nodeRouteDecisions = (snapshot as any).nodeRouteDecisions ?? [];
    this.crossNodeProbeReports = (snapshot as any).crossNodeProbeReports ?? [];
    this.cacheAttestations = (snapshot as any).cacheAttestations ?? [];
    this.fileReputationReports = (snapshot as any).fileReputationReports ?? [];
    this.nodeQuarantineEvents = (snapshot as any).nodeQuarantineEvents ?? [];
    this.nodeUpdateCampaigns = (snapshot as any).nodeUpdateCampaigns ?? [];
    this.nodeVersionAttestations = (snapshot as any).nodeVersionAttestations ?? [];
  }

  /**
   * Creates a audit record.
   *
   * @param event Event object emitted by the runtime or UI.
   * @returns The result produced by the operation.
   */
  createAudit(event: Omit<AuditEvent, 'id' | 'createdAt' | 'previousEventHash' | 'eventHash'>) {
    // Hash chain: newest event is at index 0 (prepended), so chain runs reversed
    const previousEvent = this.auditEvents[0];
    const previousEventHash = previousEvent?.eventHash;

    const partial: Omit<AuditEvent, 'eventHash'> = {
      id: uuid(),
      createdAt: new Date().toISOString(),
      previousEventHash,
      ...event,
    };
    const eventHash = computeEventHash(partial, previousEventHash);
    const audit: AuditEvent = { ...partial, eventHash };

    this.auditEvents.unshift(audit);
    void this.persist();
    return audit;
  }

  /**
   * Handles the persist operation for MemoryStore.
   */
  async persist() {
    const snapshot = normalizeSnapshot({
      users: this.users,
      backendNodes: this.backendNodes,
      clientEnrollments: this.clientEnrollments,
      devices: this.devices,
      installedApps: this.installedApps,
      packages: this.packages,
      rules: this.rules,
      ruleTemplates: this.ruleTemplates,
      tasks: this.tasks,
      alarms: this.alarms,
      auditEvents: this.auditEvents,
      taskLedger: this.taskLedger,
      killSwitchStates: this.killSwitchStates,
      tenantPolicies: this.tenantPolicies,
      ssoProviders: this.ssoProviders,
      nodeRoutingPolicies: this.nodeRoutingPolicies,
      nodeChallengeNonces: this.nodeChallengeNonces,
      nodeHealthReports: this.nodeHealthReports,
      nodeTrustHistory: this.nodeTrustHistory,
      nodeRouteDecisions: this.nodeRouteDecisions,
      crossNodeProbeReports: this.crossNodeProbeReports,
      cacheAttestations: this.cacheAttestations,
      fileReputationReports: this.fileReputationReports,
      nodeQuarantineEvents: this.nodeQuarantineEvents,
      nodeUpdateCampaigns: this.nodeUpdateCampaigns,
      nodeVersionAttestations: this.nodeVersionAttestations,
    } as any);
    await this.postgres.saveSnapshot(snapshot);
    try {
      await this.dragonfly.setJson(this.snapshotKey, snapshot);
    } catch (error) {
      this.logger.warn(`Could not persist Dragonfly snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Loads dragonfly snapshot data.
   * @returns The result produced by the operation.
   */
  private async loadDragonflySnapshot() {
    try {
      return await this.dragonfly.getJson<StoreSnapshot>(this.snapshotKey);
    } catch (error) {
      this.logger.warn(`Could not load Dragonfly snapshot: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
