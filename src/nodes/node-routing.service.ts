import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { SiemEventService } from '../siem/siem-event.service';
import { MemoryStore } from '../storage/memory.store';
import { Device, NodeCapability, NodeRoutingPolicy, RouteCandidate, RouteDecision } from '../types';

const EU_REGION_PREFIXES = ['eu-', 'eu_', 'europe', 'de-', 'fr-', 'nl-', 'ie-', 'se-', 'fi-', 'pl-', 'es-', 'it-'];

@Injectable()
export class NodeRoutingService {
  private readonly logger = new Logger(NodeRoutingService.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
  ) {}

  selectBestNode(options: {
    tenantId: string;
    device?: Device;
    preferredNodeId?: string;
    requiredCapabilities?: NodeCapability[];
    correlationId?: string;
  }) {
    const decision = this.route(options);
    return decision.selectedNodeId
      ? this.store.backendNodes.find((node) => node.id === decision.selectedNodeId)
      : undefined;
  }

  route(options: {
    tenantId: string;
    device?: Device;
    preferredNodeId?: string;
    requiredCapabilities?: NodeCapability[];
    correlationId?: string;
  }): RouteDecision {
    const policy = this.policyFor(options.tenantId);
    const requiredCapabilities = [...new Set([...(policy.requiredCapabilities ?? []), ...(options.requiredCapabilities ?? [])])];
    const candidates = this.store.backendNodes.map((node): RouteCandidate => {
      const reasons: string[] = [];
      const capabilities = node.capabilities ?? capabilitiesFromCapacity(node.capacity);
      const healthState = node.healthState ?? (node.status === 'online' ? 'degraded' : 'stale');
      const trustScore = node.trustScore ?? 80;
      const latencyMs = latencyFromNode(node);
      let eligible = true;

      const reject = (reason: string) => { eligible = false; reasons.push(reason); };
      if (node.status !== 'online') reject('offline');
      if (node.quarantineState === 'quarantined') reject('quarantined');
      if (node.maintenanceState === 'maintenance' || node.maintenanceState === 'draining') reject(node.maintenanceState);
      if (healthState !== 'healthy' && healthState !== 'degraded') reject(`health:${healthState}`);
      if (policy.trustedOnly && trustScore < 80) reject('policy:trusted_only');
      if (policy.excludedNodeIds.includes(node.id)) reject('policy:excluded_node');
      if (policy.mode === 'eu_only' && !isEuRegion(node.region)) reject('policy:eu_only');
      if (policy.mode === 'region_pinned' && policy.pinnedRegion && node.region !== policy.pinnedRegion) reject('policy:region_pinned');
      if (policy.mode === 'offline_local_only' && policy.localSite && node.site !== policy.localSite) reject('policy:local_site_only');
      for (const capability of requiredCapabilities) {
        if (!capabilities.includes(capability)) reject(`missing_capability:${capability}`);
      }

      const preferredBoost =
        node.id === options.preferredNodeId || node.id === options.device?.preferredNodeId || policy.preferredNodeIds.includes(node.id)
          ? 25
          : 0;
      const regionBoost = options.device?.preferredNodeId === node.id || (options.device?.group && node.site === options.device.group) ? 5 : 0;
      const latencyPenalty = Math.min(30, Math.round((latencyMs ?? 500) / 50));
      const priority = eligible ? trustScore + preferredBoost + regionBoost - latencyPenalty : -1000;
      const weight = eligible ? Math.max(1, priority) : 0;
      if (eligible && reasons.length === 0) reasons.push('eligible');

      return {
        nodeId: node.id,
        publicUrl: node.publicUrl,
        region: node.region,
        site: node.site,
        capabilities,
        healthy: eligible,
        healthState,
        latencyMs,
        trustScore,
        maintenanceState: node.maintenanceState ?? 'active',
        quarantineState: node.quarantineState ?? 'none',
        priority,
        weight,
        reasons,
      };
    }).sort((left, right) => right.priority - left.priority || left.nodeId.localeCompare(right.nodeId));

    const selected = weightedPick(candidates.filter((candidate) => candidate.weight > 0));
    const decision: RouteDecision = {
      id: uuid(),
      tenantId: options.tenantId,
      deviceId: options.device?.id,
      selectedNodeId: selected?.nodeId,
      candidates,
      policyId: policy.id,
      requiredCapabilities,
      reason: selected ? 'selected_highest_trust_policy_candidate' : 'no_policy_eligible_node',
      correlationId: options.correlationId,
      createdAt: new Date().toISOString(),
    };
    this.store.nodeRouteDecisions.unshift(decision);
    this.store.nodeRouteDecisions = this.store.nodeRouteDecisions.slice(0, 5000);
    this.audit.record('system', 'node.routing.decision', selected?.nodeId, {
      tenantId: decision.tenantId,
      deviceId: decision.deviceId,
      selectedNodeId: selected?.nodeId,
      reason: decision.reason,
      candidateCount: candidates.length,
    }, options.tenantId);
    this.siem.emit({
      tenantId: options.tenantId,
      type: 'node.routing.decision',
      severity: selected ? 'low' : 'high',
      actor: { userId: null, nodeId: null, ip: null },
      target: { taskId: null, deviceId: options.device?.id ?? null, nodeId: selected?.nodeId ?? null },
      metadata: { reason: decision.reason, requiredCapabilities },
    });
    void this.store.persist();
    this.logger.debug(`Route decision tenant=${options.tenantId} selected=${selected?.nodeId ?? 'none'}`);
    return decision;
  }

  setPolicy(tenantId: string, patch: Partial<NodeRoutingPolicy>) {
    const existing = this.policyFor(tenantId);
    Object.assign(existing, patch, { tenantId, updatedAt: new Date().toISOString() });
    const index = this.store.nodeRoutingPolicies.findIndex((policy) => policy.id === existing.id);
    if (index === -1) this.store.nodeRoutingPolicies.push(existing);
    void this.store.persist();
    return existing;
  }

  policyFor(tenantId: string): NodeRoutingPolicy {
    return this.store.nodeRoutingPolicies.find((policy) => policy.tenantId === tenantId) ?? {
      id: `policy-${tenantId}`,
      tenantId,
      mode: 'standard',
      preferredNodeIds: [],
      excludedNodeIds: [],
      trustedOnly: false,
      requiredCapabilities: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

function capabilitiesFromCapacity(capacity?: Record<string, unknown>): NodeCapability[] {
  const raw = capacity?.capabilities;
  if (Array.isArray(raw)) return raw.filter((item): item is NodeCapability => typeof item === 'string') as NodeCapability[];
  const result: NodeCapability[] = [];
  if (capacity?.packageCache) result.push('regional-cache');
  return result;
}

function latencyFromNode(node: { capacity?: Record<string, unknown> }) {
  const latency = node.capacity?.latencyMs;
  return typeof latency === 'number' && Number.isFinite(latency) ? latency : undefined;
}

function isEuRegion(region?: string) {
  const value = (region ?? '').toLowerCase();
  return EU_REGION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function weightedPick(candidates: RouteCandidate[]) {
  if (candidates.length === 0) return undefined;
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (total <= 0) return candidates[0];
  let cursor = Math.random() * total;
  for (const candidate of candidates) {
    cursor -= candidate.weight;
    if (cursor <= 0) return candidate;
  }
  return candidates[0];
}
