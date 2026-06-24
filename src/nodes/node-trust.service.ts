import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { SiemEventService } from '../siem/siem-event.service';
import { MemoryStore } from '../storage/memory.store';
import { NodeHealthReport, NodeHealthState, NodeQueueLag, NodeSecurityFinding, NodeTrustSnapshot } from '../types';

const DEFAULT_TRUST_SCORE = 80;
const QUARANTINE_TRUST_THRESHOLD = Number(process.env.NODE_QUARANTINE_TRUST_THRESHOLD ?? 30);

@Injectable()
export class NodeTrustService {
  private readonly logger = new Logger(NodeTrustService.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
  ) {}

  applyHealthReport(report: NodeHealthReport) {
    const node = this.store.backendNodes.find((candidate) => candidate.id === report.nodeId);
    if (!node) return;

    const previous = node.trustScore ?? DEFAULT_TRUST_SCORE;
    const reasons: string[] = [];
    const securityFindings: NodeSecurityFinding[] = [];
    let delta = 2;

    const unhealthyCount = report.components.filter((component) => component.status === 'unhealthy').length;
    const degradedCount = report.components.filter((component) => component.status === 'degraded').length;
    if (unhealthyCount > 0) { delta -= 25; reasons.push(`${unhealthyCount} unhealthy component(s)`); }
    if (degradedCount > 0) { delta -= 8; reasons.push(`${degradedCount} degraded component(s)`); }
    if (!report.scannerHealthy) { delta -= 12; reasons.push('scanner unhealthy'); }
    if (!report.cacheHealthy) { delta -= 8; reasons.push('cache unhealthy'); }
    if (!report.packageVerifierHealthy) { delta -= 20; reasons.push('package verifier unhealthy'); }
    if (!report.updateSourceReachable) { delta -= 6; reasons.push('update source unreachable'); }
    if ((report.clockSkewMs ?? 0) > 60_000) { delta -= 15; reasons.push('clock skew above 60s'); }
    if (report.queueLag === 'high') { delta -= 8; reasons.push('high queue lag'); }
    if ((report.latencyMs ?? 0) > 1500) { delta -= 6; reasons.push('high latency'); }

    // ── Node age penalty — new nodes are trusted less until they prove stability ──
    const firstSeen = node.firstSeenAt ? Date.now() - new Date(node.firstSeenAt).getTime() : null;
    let ageTrustCeiling = 100;
    if (firstSeen !== null) {
      const agePenalty = ageBasedPenalty(firstSeen);
      ageTrustCeiling = agePenalty.maxTrustScore;
      if (agePenalty.delta < 0) {
        reasons.push(agePenalty.reason);
        securityFindings.push({ code: 'NODE_AGE_NEW', severity: agePenalty.severity, category: 'node_age',
          message: agePenalty.reason,
          remediationHint: 'Trust improves automatically as the node demonstrates stable operation over time.' });
      }
    }

    // ── OS security findings forwarded from the node ──
    for (const finding of (report.securityFindings ?? [])) {
      const penalty = osFindingPenalty(finding.severity);
      if (penalty > 0) { delta -= penalty; reasons.push(finding.message); }
      securityFindings.push(finding);
    }

    // ── Server-side IP reputation heuristics based on publicUrl ──
    applyIpReputationFindings(report.publicUrl ?? node.publicUrl, securityFindings, reasons, (p) => { delta -= p; });

    if (reasons.length === 0) reasons.push('signed health report accepted');

    const next = clamp(previous + delta, 0, ageTrustCeiling);
    const healthState = this.resolveHealthState(report, next);

    node.lastSeenAt = report.reportedAt;
    node.healthState = healthState;
    node.trustScore = next;
    node.capabilities = report.capabilities.length > 0 ? report.capabilities : node.capabilities;
    node.status = healthState === 'unhealthy' || healthState === 'quarantined' ? 'offline' : 'online';

    const snapshot: NodeTrustSnapshot = {
      id: uuid(),
      nodeId: node.id,
      healthy: healthState === 'healthy',
      healthState,
      latencyMs: report.latencyMs,
      lastSeenSeconds: 0,
      certValid: certValid(node.tlsCertExpiresAt),
      scannerHealthy: report.scannerHealthy,
      suspiciousEvents: this.store.nodeQuarantineEvents.filter((event) => event.nodeId === node.id && !event.resolvedAt).length,
      queueLag: report.queueLag,
      previousTrustScore: previous,
      trustScore: next,
      scoreDelta: next - previous,
      maxTrustScore: ageTrustCeiling,
      reasons,
      securityFindings,
      createdAt: new Date().toISOString(),
    };
    this.store.nodeTrustHistory.unshift(snapshot);
    this.store.nodeTrustHistory = this.store.nodeTrustHistory.slice(0, 5000);

    if (next !== previous) {
      this.audit.record(node.id, 'node.trust.changed', node.id, { previous, next, reasons });
      this.siem.emit({
        tenantId: 'system',
        type: 'node.trust.changed',
        severity: next < 50 ? 'high' : 'low',
        actor: { userId: null, nodeId: node.id, ip: null },
        target: { taskId: null, deviceId: null, nodeId: node.id },
        metadata: { previous, next, reasons },
      });
    }

    if (next < QUARANTINE_TRUST_THRESHOLD) {
      this.quarantine(node.id, 'trust_score_low', trustThresholdReason(next, reasons, securityFindings));
    }

    void this.store.persist();
    this.logger.debug(`Node trust updated nodeId=${node.id} ${previous}->${next} health=${healthState}`);
    return snapshot;
  }

  penalize(nodeId: string, trigger: Parameters<NodeTrustService['quarantine']>[1], reason: string, penalty = 35) {
    const node = this.store.backendNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const previous = node.trustScore ?? DEFAULT_TRUST_SCORE;
    node.trustScore = clamp(previous - penalty, 0, 100);
    this.audit.record(nodeId, 'node.trust.penalty', nodeId, { previous, next: node.trustScore, reason });
    if (node.trustScore < QUARANTINE_TRUST_THRESHOLD || trigger !== 'repeated_failures') {
      this.quarantine(nodeId, trigger, reason);
    }
    void this.store.persist();
  }

  quarantine(nodeId: string, trigger: 'invalid_signature' | 'replay_attempt' | 'trust_score_low' | 'repeated_failures' | 'integrity_mismatch' | 'certificate_issue' | 'manual', reason: string) {
    const node = this.store.backendNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    if (node.quarantineState === 'quarantined') {
      if (trigger === 'trust_score_low' && node.quarantineReason !== reason) {
        node.quarantineReason = reason;
        const activeEvent = this.store.nodeQuarantineEvents.find((event) => event.nodeId === nodeId && !event.resolvedAt);
        if (activeEvent) activeEvent.reason = reason;
      }
      return;
    }
    node.quarantineState = 'quarantined';
    node.healthState = 'quarantined';
    node.status = 'offline';
    node.quarantineReason = reason;
    const event = { id: uuid(), nodeId, trigger, reason, createdAt: new Date().toISOString() };
    this.store.nodeQuarantineEvents.unshift(event);
    this.audit.record('system', 'node.quarantined', nodeId, { trigger, reason });
    this.siem.emit({
      tenantId: 'system',
      type: 'node.quarantined',
      severity: 'critical',
      actor: { userId: null, nodeId, ip: null },
      target: { taskId: null, deviceId: null, nodeId },
      metadata: { trigger, reason },
    });
    void this.store.persist();
  }

  clearQuarantine(nodeId: string, actor: string) {
    const node = this.store.backendNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return undefined;
    node.quarantineState = 'none';
    node.quarantineReason = undefined;
    node.healthState = 'degraded';
    node.trustScore = Math.max(node.trustScore ?? DEFAULT_TRUST_SCORE, DEFAULT_TRUST_SCORE);
    for (const event of this.store.nodeQuarantineEvents.filter((item) => item.nodeId === nodeId && !item.resolvedAt)) {
      event.resolvedAt = new Date().toISOString();
      event.resolvedBy = actor;
    }
    this.audit.record(actor, 'node.quarantine.cleared', nodeId);
    this.siem.emit({
      tenantId: 'system',
      type: 'node.quarantine.cleared',
      severity: 'medium',
      actor: { userId: actor, nodeId: null, ip: null },
      target: { taskId: null, deviceId: null, nodeId },
      metadata: {},
    });
    void this.store.persist();
    return node;
  }

  private resolveHealthState(report: NodeHealthReport, trustScore: number): NodeHealthState {
    if (trustScore < QUARANTINE_TRUST_THRESHOLD) return 'quarantined';
    if (report.components.some((component) => component.status === 'unhealthy')) return 'unhealthy';
    if (report.components.some((component) => component.status === 'degraded') || trustScore < 70) return 'degraded';
    return 'healthy';
  }
}

function certValid(expiresAt?: string) {
  return Boolean(expiresAt && Date.parse(expiresAt) > Date.now());
}

function ageBasedPenalty(ageMs: number): {
  delta: number;
  reason: string;
  severity: NodeSecurityFinding['severity'];
  maxTrustScore: number;
} {
  const hours = ageMs / 3_600_000;
  if (hours < 1) {
    return {
      delta: -20,
      severity: 'high',
      maxTrustScore: 60,
      reason: 'node enrolled less than 1 hour ago; elevated scrutiny until it proves stability',
    };
  }
  if (hours < 24) {
    return {
      delta: -10,
      severity: 'medium',
      maxTrustScore: 75,
      reason: 'node enrolled less than 24 hours ago; building trust baseline',
    };
  }
  if (hours < 168) {
    return {
      delta: -5,
      severity: 'low',
      maxTrustScore: 90,
      reason: 'node enrolled less than 7 days ago; trust is still accumulating',
    };
  }
  return { delta: 0, severity: 'info', maxTrustScore: 100, reason: 'node age established' };
}

function osFindingPenalty(severity: NodeSecurityFinding['severity']) {
  switch (severity) {
    case 'critical': return 25;
    case 'high': return 15;
    case 'medium': return 7;
    case 'low': return 3;
    default: return 0;
  }
}

function applyIpReputationFindings(
  url: string | undefined,
  findings: NodeSecurityFinding[],
  reasons: string[],
  penalize: (penalty: number) => void,
) {
  if (!url) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    findings.push({ code: 'NODE_PUBLIC_URL_INVALID', severity: 'medium', category: 'ip_reputation', message: 'node public URL is not parseable' });
    reasons.push('invalid public URL');
    penalize(7);
    return;
  }
  const host = parsed.hostname.toLowerCase();
  const ipHost = host.replace(/^\[|\]$/g, '');
  const ipKind = isIP(ipHost);
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  const isLocalName = host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost');
  const isInternalName = !ipKind && (isLocalName || !host.includes('.') || host.endsWith('.internal'));
  const isPrivateOrReserved = ipKind > 0 && isPrivateOrReservedIp(ipHost);
  const isPublicRoutable = !isPrivateOrReserved && !isInternalName;
  const reputationHost = ipKind > 0 ? ipHost : host;
  const denylisted = envSet('NODE_PUBLIC_IP_REPUTATION_DENYLIST').has(reputationHost);
  const warnlisted = envSet('NODE_PUBLIC_IP_REPUTATION_WARNLIST').has(reputationHost);
  const localDevUrl = process.env.NODE_ENV !== 'production' && (isLocalName || isPrivateOrReserved);

  if (denylisted || warnlisted) {
    findings.push({
      code: denylisted ? 'NODE_PUBLIC_IP_REPUTATION_DENYLISTED' : 'NODE_PUBLIC_IP_REPUTATION_WARNLISTED',
      severity: denylisted ? 'critical' : 'high',
      category: 'ip_reputation',
      message: `node public URL host is present in the configured IP reputation ${denylisted ? 'denylist' : 'warnlist'} (${reputationHost})`,
      remediationHint: 'Move the node to a clean IP or remove the reputation entry after investigation.',
    });
    reasons.push(denylisted ? 'public IP reputation denylisted' : 'public IP reputation warnlisted');
    penalize(denylisted ? 35 : 18);
  }

  if ((isLocalName || isPrivateOrReserved) && !localDevUrl) {
    findings.push({
      code: 'NODE_PUBLIC_URL_PRIVATE_OR_LOCAL',
      severity: isLocalName ? 'high' : 'medium',
      category: 'ip_reputation',
      message: `node public URL uses a local, private, or reserved address (${host})`,
      remediationHint: 'Use the routable node URL that clients are expected to reach, or keep this node out of public routing policies.',
    });
    reasons.push(isLocalName ? 'local-only public URL' : 'private or reserved public URL');
    penalize(isLocalName ? 15 : 8);
  }

  if (ipKind > 0 && !isPrivateOrReserved) {
    findings.push({
      code: 'NODE_PUBLIC_URL_RAW_PUBLIC_IP',
      severity: 'medium',
      category: 'ip_reputation',
      message: `node public URL uses a raw public IP address (${ipHost})`,
      remediationHint: 'Use a stable DNS name with TLS instead of exposing the node directly by IP address.',
    });
    reasons.push('raw public IP used for node public URL');
    penalize(8);
  }

  if (parsed.protocol === 'http:' && isPublicRoutable) {
    findings.push({
      code: 'NODE_PUBLIC_URL_NO_TLS',
      severity: 'high',
      category: 'ip_reputation',
      message: 'node public URL uses plain HTTP on a public address',
      remediationHint: 'Configure TLS on the node or reverse proxy and set NODE_PUBLIC_URL to https://.',
    });
    reasons.push('plain HTTP used on public node URL');
    penalize(12);
  }

  if (isPublicRoutable && ![80, 443, 4200, 4201].includes(port)) {
    findings.push({
      code: 'NODE_PUBLIC_URL_UNUSUAL_PORT',
      severity: 'low',
      category: 'ip_reputation',
      message: `node public URL is exposed on unusual port ${port}`,
      remediationHint: 'Prefer port 443 behind a reverse proxy for internet-routable nodes.',
    });
    reasons.push(`unusual public node port ${port}`);
    penalize(3);
  }
}

function trustThresholdReason(
  trustScore: number,
  reasons: string[],
  findings: NodeSecurityFinding[],
) {
  const factors = [
    ...reasons.filter((reason) => reason !== 'signed health report accepted'),
    ...findings.map((finding) => finding.message),
  ];
  const uniqueFactors = [...new Set(factors)].slice(0, 4);
  if (uniqueFactors.length === 0) {
    return `Trust score ${trustScore} fell below ${QUARANTINE_TRUST_THRESHOLD}; no scoring factors were recorded`;
  }
  return `Trust score ${trustScore} fell below ${QUARANTINE_TRUST_THRESHOLD} after: ${uniqueFactors.join('; ')}`;
}

function envSet(name: string) {
  return new Set((process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function isPrivateOrReservedIp(host: string) {
  if (host.includes(':')) {
    const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
    return normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:');
  }

  const octets = host.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
