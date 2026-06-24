import { NodeTrustService } from './node-trust.service';
import { BackendNode, NodeHealthReport, NodeSecurityFinding } from '../types';

describe('NodeTrustService', () => {
  afterEach(() => {
    delete process.env.NODE_PUBLIC_IP_REPUTATION_DENYLIST;
    delete process.env.NODE_PUBLIC_IP_REPUTATION_WARNLIST;
  });

  function createService(node: BackendNode) {
    const store = {
      backendNodes: [node],
      nodeQuarantineEvents: [],
      nodeTrustHistory: [],
      persist: jest.fn(async () => undefined),
    };
    const audit = { record: jest.fn() };
    const siem = { emit: jest.fn() };
    const service = new NodeTrustService(store as never, audit as never, siem as never);
    return { service, store, audit, siem };
  }

  function node(patch: Partial<BackendNode> = {}): BackendNode {
    const now = new Date().toISOString();
    return {
      id: 'node-1',
      name: 'Node 1',
      publicUrl: 'https://node.example.com',
      status: 'online',
      healthState: 'healthy',
      maintenanceState: 'active',
      quarantineState: 'none',
      trustScore: 80,
      capabilities: [],
      enrollmentTokenHash: 'hash',
      enrollmentTokenCreatedAt: now,
      enrollmentTokenUsedAt: now,
      firstSeenAt: new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString(),
      lastSeenAt: now,
      tlsCertExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      ...patch,
    };
  }

  function report(patch: Partial<NodeHealthReport> = {}): NodeHealthReport {
    const now = new Date().toISOString();
    return {
      nodeId: 'node-1',
      reportedAt: now,
      publicUrl: 'https://node.example.com',
      queueSize: 0,
      queueLag: 'low',
      scannerHealthy: true,
      cacheHealthy: true,
      packageVerifierHealthy: true,
      updateSourceReachable: true,
      components: [],
      capabilities: [],
      ...patch,
    };
  }

  it('keeps very new nodes below the age trust ceiling even with a clean report', () => {
    const { service, store } = createService(node({
      trustScore: 95,
      firstSeenAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    }));

    const snapshot = service.applyHealthReport(report());

    expect(snapshot?.trustScore).toBe(60);
    expect(store.backendNodes[0].trustScore).toBe(60);
    expect(snapshot?.securityFindings?.map((finding) => finding.code)).toContain('NODE_AGE_NEW');
  });

  it('deducts trust for OS security findings reported by the node', () => {
    const finding: NodeSecurityFinding = {
      code: 'NO_FIREWALL_DETECTED',
      severity: 'high',
      category: 'os_security',
      message: 'No active firewall detected',
      remediationHint: 'Enable a host firewall.',
    };
    const { service } = createService(node({ trustScore: 80 }));

    const snapshot = service.applyHealthReport(report({ securityFindings: [finding] }));

    expect(snapshot?.trustScore).toBe(67);
    expect(snapshot?.reasons).toContain('No active firewall detected');
    expect(snapshot?.securityFindings).toContainEqual(finding);
  });

  it('deducts trust for risky public URL and raw public IP reputation signals', () => {
    const { service } = createService(node({
      trustScore: 80,
      publicUrl: 'http://8.8.8.8:8080',
    }));

    const snapshot = service.applyHealthReport(report({ publicUrl: 'http://8.8.8.8:8080' }));
    const codes = snapshot?.securityFindings?.map((finding) => finding.code) ?? [];

    expect(snapshot?.trustScore).toBe(59);
    expect(codes).toEqual(expect.arrayContaining([
      'NODE_PUBLIC_URL_RAW_PUBLIC_IP',
      'NODE_PUBLIC_URL_NO_TLS',
      'NODE_PUBLIC_URL_UNUSUAL_PORT',
    ]));
  });

  it('deducts trust for hosts on the configured public IP reputation denylist', () => {
    process.env.NODE_PUBLIC_IP_REPUTATION_DENYLIST = '8.8.8.8';
    const { service } = createService(node({
      trustScore: 80,
      publicUrl: 'https://8.8.8.8',
    }));

    const snapshot = service.applyHealthReport(report({ publicUrl: 'https://8.8.8.8' }));

    expect(snapshot?.trustScore).toBe(39);
    expect(snapshot?.securityFindings?.map((finding) => finding.code)).toContain('NODE_PUBLIC_IP_REPUTATION_DENYLISTED');
    expect(snapshot?.reasons).toContain('public IP reputation denylisted');
  });

  it('does not penalize Docker lab hostnames as public plain HTTP endpoints', () => {
    const { service } = createService(node({
      trustScore: 80,
      publicUrl: 'http://backend-node-1:4200',
    }));

    const snapshot = service.applyHealthReport(report({ publicUrl: 'http://backend-node-1:4200' }));

    expect(snapshot?.trustScore).toBe(82);
    expect(snapshot?.securityFindings?.map((finding) => finding.code)).not.toContain('NODE_PUBLIC_URL_NO_TLS');
    expect(snapshot?.reasons).toEqual(['signed health report accepted']);
  });

  it('stores the scoring factors in the quarantine reason when trust falls below the threshold', () => {
    const { service, store } = createService(node({ trustScore: 32 }));

    service.applyHealthReport(report({
      scannerHealthy: false,
      cacheHealthy: false,
      packageVerifierHealthy: false,
    }));

    expect(store.backendNodes[0].quarantineState).toBe('quarantined');
    expect(store.backendNodes[0].quarantineReason).toContain('Trust score 0 fell below 30 after:');
    expect(store.backendNodes[0].quarantineReason).toContain('scanner unhealthy');
    expect(store.backendNodes[0].quarantineReason).toContain('package verifier unhealthy');
  });

  it('refreshes a generic low-score reason for nodes that are already quarantined', () => {
    const { service, store } = createService(node({
      healthState: 'quarantined',
      quarantineState: 'quarantined',
      quarantineReason: 'Trust score 0 fell below 30',
      trustScore: 20,
    }));
    (store.nodeQuarantineEvents as any[]).push({
      id: 'event-1',
      nodeId: 'node-1',
      trigger: 'trust_score_low',
      reason: 'Trust score 0 fell below 30',
      createdAt: new Date().toISOString(),
    });

    service.applyHealthReport(report({ scannerHealthy: false }));

    expect(store.backendNodes[0].quarantineReason).toContain('after: scanner unhealthy');
    expect((store.nodeQuarantineEvents as any[])[0].reason).toBe(store.backendNodes[0].quarantineReason);
  });
});
