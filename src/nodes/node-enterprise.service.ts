import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { SigningService } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import {
  CacheArtifactAttestation, CrossNodeProbeReport, FileReputationReport, NodeHealthReport,
  NodeMaintenanceState, NodeSignedEnvelope, NodeVersionAttestation,
} from '../types';
import { NodeCryptoService } from './node-crypto.service';
import { NodeRoutingService } from './node-routing.service';
import { NodeTrustService } from './node-trust.service';

@Injectable()
export class NodeEnterpriseService {
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly signing: SigningService,
    private readonly crypto: NodeCryptoService,
    private readonly routing: NodeRoutingService,
    private readonly trust: NodeTrustService,
  ) {}

  issueChallenge(nodeId: string, purpose: NodeSignedEnvelope['payloadType']) {
    this.requireNode(nodeId);
    return this.crypto.issueNonce(nodeId, purpose);
  }

  ingestHealth(nodeId: string, envelope: NodeSignedEnvelope<NodeHealthReport>) {
    const report = this.crypto.verifyEnvelope(envelope, nodeId, 'node_health_report');
    if (report.nodeId !== nodeId) throw new BadRequestException('Health report nodeId mismatch');
    this.store.nodeHealthReports.unshift(report);
    this.store.nodeHealthReports = this.store.nodeHealthReports.slice(0, 2000);
    const snapshot = this.trust.applyHealthReport(report);
    this.audit.record(nodeId, 'node.health.accepted', nodeId, {
      healthState: snapshot?.healthState,
      trustScore: snapshot?.trustScore,
      queueLag: report.queueLag,
    });
    return { accepted: true, trust: snapshot };
  }

  ingestCrossNodeProbe(nodeId: string, envelope: NodeSignedEnvelope<Omit<CrossNodeProbeReport, 'id'>>) {
    const payload = this.crypto.verifyEnvelope(envelope, nodeId, 'cross_node_probe_report');
    const report: CrossNodeProbeReport = { ...payload, id: uuid(), reporterNodeId: nodeId };
    this.store.crossNodeProbeReports.unshift(report);
    this.store.crossNodeProbeReports = this.store.crossNodeProbeReports.slice(0, 5000);
    this.audit.record(nodeId, 'node.peer_probe.accepted', report.targetNodeId, { reachable: report.reachable, latencyMs: report.latencyMs });
    void this.store.persist();
    return { accepted: true, report };
  }

  ingestCacheAttestation(nodeId: string, envelope: NodeSignedEnvelope<Omit<CacheArtifactAttestation, 'id' | 'nodeId'>>) {
    const payload = this.crypto.verifyEnvelope(envelope, nodeId, 'cache_artifact_attestation');
    const report: CacheArtifactAttestation = { ...payload, id: uuid(), nodeId };
    this.store.cacheAttestations.unshift(report);
    this.store.cacheAttestations = this.store.cacheAttestations.slice(0, 5000);
    const artifact = this.store.packages.find((pkg) => pkg.id === report.packageArtifactId);
    if (artifact) {
      artifact.cacheAttestations = [report, ...(artifact.cacheAttestations ?? []).filter((item) => item.nodeId !== nodeId)].slice(0, 25);
    }
    if (!report.verified) this.trust.penalize(nodeId, 'integrity_mismatch', report.reason ?? 'Cache attestation failed', 25);
    this.audit.record(nodeId, 'node.cache.attested', report.packageArtifactId, { verified: report.verified, sha256: report.sha256 });
    void this.store.persist();
    return { accepted: true, report };
  }

  ingestVersionAttestation(nodeId: string, envelope: NodeSignedEnvelope<Omit<NodeVersionAttestation, 'id' | 'nodeId'>>) {
    const payload = this.crypto.verifyEnvelope(envelope, nodeId, 'node_version_attestation');
    const report: NodeVersionAttestation = { ...payload, id: uuid(), nodeId };
    this.store.nodeVersionAttestations.unshift(report);
    this.store.nodeVersionAttestations = this.store.nodeVersionAttestations.slice(0, 5000);
    const node = this.requireNode(nodeId);
    node.version = report.version;
    if (!report.signatureValid) this.trust.penalize(nodeId, 'integrity_mismatch', 'Node update signature attestation failed', 35);
    this.audit.record(nodeId, 'node.update.attested', nodeId, { version: report.version, signatureValid: report.signatureValid });
    void this.store.persist();
    return { accepted: true, report };
  }

  recordFileReputation(report: Omit<FileReputationReport, 'id' | 'scannedAt'> & { id?: string; scannedAt?: string }) {
    const full: FileReputationReport = {
      id: report.id ?? uuid(),
      scannedAt: report.scannedAt ?? new Date().toISOString(),
      ...report,
    };
    this.store.fileReputationReports.unshift(full);
    this.store.fileReputationReports = this.store.fileReputationReports.slice(0, 5000);
    if (full.packageArtifactId) {
      const artifact = this.store.packages.find((pkg) => pkg.id === full.packageArtifactId);
      if (artifact) artifact.fileReputation = full;
    }
    void this.store.persist();
    return full;
  }

  trustCenter() {
    return this.store.backendNodes.map((node) => {
      const latestHealth = this.store.nodeHealthReports.find((report) => report.nodeId === node.id);
      const latestTrust = this.store.nodeTrustHistory.find((snapshot) => snapshot.nodeId === node.id);
      const version = this.store.nodeVersionAttestations.find((attestation) => attestation.nodeId === node.id);
      return {
        ...node,
        health: latestHealth,
        trust: latestTrust,
        trustHistory: this.store.nodeTrustHistory.filter((snapshot) => snapshot.nodeId === node.id).slice(0, 10),
        versionAttestation: version,
        activeQuarantineEvents: this.store.nodeQuarantineEvents.filter((event) => event.nodeId === node.id && !event.resolvedAt),
        quarantineEvents: this.store.nodeQuarantineEvents.filter((event) => event.nodeId === node.id).slice(0, 10),
        failoverEvents: this.store.nodeRouteDecisions.filter((decision) => decision.candidates.some((candidate) => candidate.nodeId === node.id && !candidate.healthy)).slice(0, 10),
      };
    });
  }

  nodeDetail(nodeId: string) {
    const node = this.requireNode(nodeId);
    return {
      node,
      healthReports: this.store.nodeHealthReports.filter((report) => report.nodeId === nodeId).slice(0, 50),
      trustHistory: this.store.nodeTrustHistory.filter((snapshot) => snapshot.nodeId === nodeId).slice(0, 100),
      routeDecisions: this.store.nodeRouteDecisions.filter((decision) => decision.selectedNodeId === nodeId || decision.candidates.some((candidate) => candidate.nodeId === nodeId)).slice(0, 100),
      probes: this.store.crossNodeProbeReports.filter((report) => report.reporterNodeId === nodeId || report.targetNodeId === nodeId).slice(0, 100),
      cacheAttestations: this.store.cacheAttestations.filter((report) => report.nodeId === nodeId).slice(0, 100),
      quarantineEvents: this.store.nodeQuarantineEvents.filter((event) => event.nodeId === nodeId),
      versionAttestations: this.store.nodeVersionAttestations.filter((event) => event.nodeId === nodeId).slice(0, 25),
      audit: this.store.auditEvents.filter((event) => event.target === nodeId || event.actor === nodeId).slice(0, 100),
    };
  }

  setMaintenance(nodeId: string, state: NodeMaintenanceState, reason?: string) {
    const node = this.requireNode(nodeId);
    node.maintenanceState = state;
    node.maintenanceReason = reason;
    node.drainingSince = state === 'draining' ? new Date().toISOString() : undefined;
    this.audit.record('system', 'node.maintenance_state.changed', nodeId, { state, reason });
    void this.store.persist();
    return node;
  }

  clearQuarantine(nodeId: string, actor: string) {
    return this.trust.clearQuarantine(nodeId, actor) ?? this.requireNode(nodeId);
  }

  routingPolicy(tenantId: string) {
    return this.routing.policyFor(tenantId);
  }

  setRoutingPolicy(tenantId: string, patch: Parameters<NodeRoutingService['setPolicy']>[1]) {
    return this.routing.setPolicy(tenantId, patch);
  }

  listUpdateCampaigns() {
    return this.store.nodeUpdateCampaigns;
  }

  createUpdateCampaign(input: {
    version: string;
    minVersion?: string;
    channel?: string;
    artifactUrl: string;
    sha256: string;
    signature: string;
    stagedPercent?: number;
    rollbackVersion?: string;
    status?: 'draft' | 'active' | 'paused';
  }, actor: string) {
    const now = new Date().toISOString();
    const campaign = {
      id: uuid(),
      version: input.version,
      minVersion: input.minVersion,
      channel: input.channel ?? 'stable',
      artifactUrl: input.artifactUrl,
      sha256: input.sha256,
      signature: input.signature,
      stagedPercent: input.stagedPercent ?? 10,
      rollbackVersion: input.rollbackVersion,
      status: input.status ?? 'draft',
      createdAt: now,
      updatedAt: now,
    };
    this.store.nodeUpdateCampaigns.unshift(campaign);
    this.audit.record(actor, 'node.update_campaign.created', campaign.id, { version: campaign.version, channel: campaign.channel, status: campaign.status });
    void this.store.persist();
    return campaign;
  }

  signedUpdateForNode(nodeId: string) {
    const node = this.requireNode(nodeId);
    const campaign = this.store.nodeUpdateCampaigns.find((item) =>
      item.status === 'active' &&
      item.channel === (node.updateChannel ?? 'stable') &&
      stagedAllowsNode(nodeId, item.stagedPercent),
    );
    if (!campaign) return { envelope: null };
    return {
      envelope: this.signing.signPayload('node_update', 'system', {
        campaign,
        nodeId,
        issuedForVersion: node.version,
        minimumAcceptedVersion: node.minimumAcceptedVersion,
      }, 30 * 60),
    };
  }

  private requireNode(nodeId: string) {
    const node = this.store.backendNodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new NotFoundException('Unknown node');
    return node;
  }
}

function stagedAllowsNode(nodeId: string, stagedPercent: number) {
  const normalized = Math.min(100, Math.max(0, stagedPercent));
  if (normalized >= 100) return true;
  const bucket = [...nodeId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
  return bucket < normalized;
}
