import { readFileSync } from 'fs';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { SiemEventService } from '../siem/siem-event.service';
import { MemoryStore } from '../storage/memory.store';
import { BackendNode, Device, NodeCapability } from '../types';
import { VaultPkiService } from '../vault/vault-pki.service';
import { NodeRoutingService } from './node-routing.service';

const NODE_ONLINE_TTL_MS = Number(process.env.NODE_ONLINE_TTL_MS ?? 2 * 60_000);
/** Enrollment tokens are valid for 24 hours from creation. */
const ENROLLMENT_TOKEN_TTL_MS = 24 * 60 * 60_000;
const NEW_NODE_INITIAL_TRUST_SCORE = Number(process.env.NEW_NODE_INITIAL_TRUST_SCORE ?? 70);

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);

  /**
   * Creates a NodesService instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param audit audit supplied to the function.
   * @param siem siem supplied to the function.
   * @param vaultPki vault pki supplied to the function.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
    private readonly vaultPki: VaultPkiService,
    private readonly routing: NodeRoutingService,
  ) {}

  /**
   * Creates a enrollment record.
   *
   * @param name name supplied to the function.
   * @param publicUrl URL used by the operation.
   * @param region region supplied to the function.
   * @param site site supplied to the function.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  async createEnrollment(name: string, publicUrl: string, region?: string, site?: string, actor = 'system', capabilities?: NodeCapability[]) {
    const token = `node_${uuid().replaceAll('-', '')}`;
    const now = new Date().toISOString();
    const node: BackendNode = {
      id: uuid(),
      name,
      publicUrl,
      region,
      site,
      status: 'pending',
      healthState: 'stale',
      maintenanceState: 'active',
      quarantineState: 'none',
      trustScore: NEW_NODE_INITIAL_TRUST_SCORE,
      capabilities: capabilities ?? [],
      enrollmentTokenHash: await bcrypt.hash(token, 12),
      enrollmentTokenCreatedAt: now,
    };
    this.store.backendNodes.push(node);
    await this.store.persist();
    this.audit.record(actor, 'node.enrollment_created', node.id, { name, publicUrl, region, site });
    this.logger.log(`Enrollment created: nodeId=${node.id} name=${name} publicUrl=${publicUrl}`);

    let caCert: string | undefined;
    if (process.env.TLS_CA_PATH) {
      try { caCert = readFileSync(process.env.TLS_CA_PATH, 'utf8'); } catch { /* not fatal */ }
    }

    return {
      nodeId: node.id,
      enrollmentToken: token,
      managementUrl: process.env.PUBLIC_URL ?? process.env.MANAGEMENT_URL ?? '',
      nodePublicUrl: publicUrl,
      dragonflyUrl: '',
      ...(caCert ? { caCert } : {}),
    };
  }


  /**
   * Re-issues a fresh one-time enrollment token for a node that has already
   * registered but lost its mTLS certificate (e.g. disk wipe, container rebuild).
   * The old token hash is replaced and enrollmentTokenUsedAt is cleared so the
   * node can call /nodes/register again to receive a new Vault mTLS certificate.
   */
  async reEnroll(nodeId: string, actor: string) {
    const node = this.store.backendNodes.find((n) => n.id === nodeId);
    if (!node) throw new BadRequestException('Unknown node');

    const token = `node_${uuid().replaceAll('-', '')}`;
    const now = new Date().toISOString();
    node.enrollmentTokenHash = await bcrypt.hash(token, 12);
    node.enrollmentTokenCreatedAt = now;
    node.enrollmentTokenUsedAt = undefined;
    node.status = 'pending';

    await this.store.persist();
    this.audit.record(actor, 'node.re_enrollment_created', node.id, { name: node.name });
    this.logger.log(`Re-enrollment token issued for nodeId=${nodeId} name=${node.name} by actor=${actor}`);

    return {
      nodeId: node.id,
      enrollmentToken: token,
      managementUrl: process.env.PUBLIC_URL ?? process.env.MANAGEMENT_URL ?? '',
    };
  }

  /**
   * Handles the register operation for NodesService.
   *
   * @param nodeId Identifier used to locate the target record.
   * @param enrollmentToken Token used to authenticate or authorize the operation.
   * @param version version supplied to the function.
   * @param capacity capacity supplied to the function.
   * @returns The result produced by the operation.
   */
  async register(nodeId: string, enrollmentToken: string, version: string, capacity?: Record<string, unknown>, metadata?: { capabilities?: NodeCapability[]; signingPublicKeyPem?: string; publicUrl?: string; region?: string; site?: string; updateChannel?: string }) {
    const node = this.store.backendNodes.find((n) => n.id === nodeId);
    if (!node) {
      this.logger.warn(`Registration rejected — unknown nodeId=${nodeId}`);
      throw new BadRequestException('Unknown node');
    }

    // One-time use enforcement
    if (node.enrollmentTokenUsedAt) {
      this.logger.warn(`Registration rejected — enrollment token already used for nodeId=${nodeId}`);
      throw new UnauthorizedException('Enrollment token has already been used');
    }

    // TTL enforcement (24 h)
    const createdAt = new Date(node.enrollmentTokenCreatedAt).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > ENROLLMENT_TOKEN_TTL_MS) {
      this.logger.warn(`Registration rejected — enrollment token expired for nodeId=${nodeId}`);
      throw new UnauthorizedException('Enrollment token has expired');
    }

    if (!(await bcrypt.compare(enrollmentToken, node.enrollmentTokenHash))) {
      this.logger.warn(`Registration rejected — invalid enrollment token for nodeId=${nodeId}`);
      throw new UnauthorizedException('Invalid enrollment token');
    }

    node.status = 'online';
    node.healthState = 'degraded';
    node.maintenanceState = node.maintenanceState ?? 'active';
    node.quarantineState = node.quarantineState ?? 'none';
    if (!node.firstSeenAt) {
      node.trustScore = Math.min(node.trustScore ?? NEW_NODE_INITIAL_TRUST_SCORE, NEW_NODE_INITIAL_TRUST_SCORE);
    } else {
      node.trustScore = node.trustScore ?? NEW_NODE_INITIAL_TRUST_SCORE;
    }
    node.version = version;
    node.capacity = capacity ?? node.capacity;
    node.capabilities = metadata?.capabilities ?? node.capabilities ?? capabilitiesFromCapacity(capacity);
    node.signingPublicKeyPem = metadata?.signingPublicKeyPem ?? node.signingPublicKeyPem;
    node.updateChannel = metadata?.updateChannel ?? node.updateChannel;
    node.publicUrl = metadata?.publicUrl ?? node.publicUrl;
    node.region = metadata?.region ?? node.region;
    node.site = metadata?.site ?? node.site;
    const now = new Date().toISOString();
    node.firstSeenAt = node.firstSeenAt ?? now;
    node.lastSeenAt = now;
    node.enrollmentTokenUsedAt = now;

    // Generate a per-node decommission token — unique, not shared with any other node.
    const decommissionToken = `decomm_${uuid().replaceAll('-', '')}`;
    node.decommissionToken = decommissionToken;

    // Issue a Vault mTLS certificate.  Cert + key are returned to the node only in
    // this response — they are never stored server-side.
    let issuedCert: { certificate: string; privateKey: string; caCert: string; serial: string; expiresAt: string } | undefined;
    try {
      if (node.tlsCertSerial) {
        await this.vaultPki.revokeCert(node.tlsCertSerial);
      }
      const cert = await this.vaultPki.issueCert(nodeId);
      // Vault 24-h TTL — record the expiry so the node knows when to renew.
      const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      node.tlsCertSerial = cert.serial;
      node.tlsCertExpiresAt = expiresAt;
      issuedCert = { ...cert, expiresAt };
      this.logger.log(`mTLS cert issued for nodeId=${nodeId} serial=${cert.serial} expiresAt=${expiresAt}`);
    } catch (err) {
      this.logger.error(
        `Vault cert issuance failed for nodeId=${nodeId}: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    await this.store.persist();
    this.audit.record(node.id, 'node.registered', node.id, { version, capacity, capabilities: node.capabilities, tlsSerial: issuedCert?.serial });
    this.siem.emit({ tenantId: 'system', type: 'node.registered', severity: 'low', actor: { userId: null, nodeId: node.id, ip: null }, target: { taskId: null, deviceId: null, nodeId: node.id }, metadata: { name: node.name, version, tlsSerial: issuedCert?.serial } });
    if (issuedCert) { this.siem.emit({ tenantId: 'system', type: 'node.certificate.issued', severity: 'low', actor: { userId: null, nodeId: node.id, ip: null }, target: { taskId: null, deviceId: null, nodeId: node.id }, metadata: { serial: issuedCert.serial, expiresAt: issuedCert.expiresAt } }); }
    this.logger.log(`Node registered: nodeId=${nodeId} name=${node.name} version=${version}`);

    return {
      nodeId: node.id,
      accepted: true,
      decommissionToken,
      tls: issuedCert ?? null,
    };
  }

  /**
   * Re-issues a Vault mTLS certificate for a node that is approaching expiry.
   * The node must be authenticated via its current (still-valid) mTLS certificate
   * before this endpoint is reached — no additional token is needed.
   * The old certificate is revoked and replaced atomically.
   */
  async renewCert(nodeId: string) {
    const node = this.store.backendNodes.find((n) => n.id === nodeId);
    if (!node) throw new BadRequestException('Unknown node');

    let issuedCert: { certificate: string; privateKey: string; caCert: string; serial: string; expiresAt: string };
    try {
      if (node.tlsCertSerial) {
        await this.vaultPki.revokeCert(node.tlsCertSerial);
      }
      const cert = await this.vaultPki.issueCert(nodeId);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      node.tlsCertSerial = cert.serial;
      node.tlsCertExpiresAt = expiresAt;
      issuedCert = { ...cert, expiresAt };
    } catch (err) {
      throw new BadRequestException(
        `Certificate renewal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.store.persist();
    this.audit.record(nodeId, 'node.cert_renewed', nodeId, { serial: issuedCert.serial });
    this.logger.log(`mTLS cert renewed for nodeId=${nodeId} serial=${issuedCert.serial}`);
    return { nodeId, renewed: true, tls: issuedCert };
  }

  /**
   * Handles the heartbeat operation for NodesService.
   *
   * @param nodeId Identifier used to locate the target record.
   * @param capacity capacity supplied to the function.
   * @returns The result produced by the operation.
   */
  heartbeat(nodeId: string, capacity?: Record<string, unknown>, signingPublicKeyPem?: string) {
    const node = this.store.backendNodes.find((n) => n.id === nodeId);
    if (!node) {
      this.logger.warn(`Heartbeat from unknown nodeId=${nodeId}`);
      throw new BadRequestException('Unknown node');
    }
    node.status = 'online';
    if (node.quarantineState !== 'quarantined') node.healthState = 'degraded';
    const now = new Date().toISOString();
    node.firstSeenAt = node.firstSeenAt ?? now;
    node.lastSeenAt = now;
    node.capacity = capacity ?? node.capacity;
    if (signingPublicKeyPem && !node.signingPublicKeyPem) {
      node.signingPublicKeyPem = signingPublicKeyPem;
      this.logger.log(`Self-healed signing public key for nodeId=${nodeId}`);
    }
    void this.store.persist();
    this.logger.debug(`Heartbeat from nodeId=${nodeId}`);
    return {
      accepted: true,
      serverTime: new Date().toISOString(),
      certExpiresAt: node.tlsCertExpiresAt,
    };
  }

  /**
   * Lists nodes records for the caller.
   * @returns The result produced by the operation.
   */
  listNodes() {
    let changed = false;
    const nodes = this.store.backendNodes.map((node) => {
      const status = this.resolveStatus(node);
      if (node.status !== status) { node.status = status; changed = true; }
      // Strip sensitive hashes from the API response
      const { enrollmentTokenHash, decommissionToken: _dt, ...safe } = node;
      void enrollmentTokenHash; void _dt;
      return { ...safe, status };
    });
    if (changed) void this.store.persist();
    return nodes;
  }

  /**
   * Removes the node record or state.
   *
   * @param nodeId Identifier used to locate the target record.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  async removeNode(nodeId: string, actor = 'system') {
    const index = this.store.backendNodes.findIndex((n) => n.id === nodeId);
    if (index === -1) throw new BadRequestException('Unknown node');
    const node = this.store.backendNodes[index];
    this.logger.log(`Removing node ${node.name} (${node.id})`);

    if (node.tlsCertSerial) {
      try {
        await this.vaultPki.revokeCert(node.tlsCertSerial);
        this.logger.log(`mTLS cert revoked for decommissioned nodeId=${nodeId} serial=${node.tlsCertSerial}`);
      } catch (err) {
        this.logger.error(`Failed to revoke cert for nodeId=${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const decommission = await this.decommissionNode(node.id, node.publicUrl, node.decommissionToken);
    if (decommission.cleared) {
      this.logger.log(`Node ${node.name} confirmed local config cleanup`);
    } else {
      this.logger.warn(`Node ${node.name} did not confirm cleanup: ${JSON.stringify(decommission)}`);
    }
    this.store.backendNodes.splice(index, 1);
    await this.store.persist();
    this.audit.record(actor, 'node.removed', nodeId, { name: node.name, publicUrl: node.publicUrl, decommission });
    return { nodeId, removed: true, decommission };
  }

  /**
   * Handles the online nodes operation for NodesService.
   * @returns The result produced by the operation.
   */
  onlineNodes() {
    return this.store.backendNodes.filter((node) => this.resolveStatus(node) === 'online');
  }

  /**
   * Handles the available node operation for NodesService.
   *
   * @param preferredNodeId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  availableNode(preferredNodeId?: string, tenantId = 'default', device?: Device, requiredCapabilities?: NodeCapability[]) {
    return this.routing.selectBestNode({ tenantId, device, preferredNodeId, requiredCapabilities });
  }

  /**
   * Handles the decommission node operation for NodesService.
   *
   * @param nodeId Identifier used to locate the target record.
   * @param publicUrl URL used by the operation.
   * @param decommissionToken Token used to authenticate or authorize the operation.
   * @returns The result produced by the operation.
   */
  private async decommissionNode(nodeId: string, publicUrl: string, decommissionToken?: string) {
    if (!decommissionToken) {
      this.logger.warn(`No decommission token stored for nodeId=${nodeId} — cannot authenticate decommission call`);
      return { attempted: false, cleared: false, reason: 'no_decommission_token' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${publicUrl.replace(/\/$/, '')}/node/decommission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId, decommissionToken }),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
      return { attempted: true, cleared: res.ok, status: res.status, response: body };
    } catch (error) {
      return { attempted: true, cleared: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Resolves status configuration.
   *
   * @param node node supplied to the function.
   * @returns The result produced by the operation.
   */
  private resolveStatus(node: BackendNode): BackendNode['status'] {
    if (node.quarantineState === 'quarantined') return 'offline';
    if (node.maintenanceState === 'maintenance') return 'offline';
    if (node.status === 'pending' && !node.lastSeenAt) return 'pending';
    if (!node.lastSeenAt) return 'offline';
    const seenAt = new Date(node.lastSeenAt).getTime();
    if (!Number.isFinite(seenAt)) return 'offline';
    return Date.now() - seenAt <= NODE_ONLINE_TTL_MS ? 'online' : 'offline';
  }
}

function capabilitiesFromCapacity(capacity?: Record<string, unknown>): NodeCapability[] {
  const raw = capacity?.capabilities;
  if (Array.isArray(raw)) return raw.filter((item): item is NodeCapability => typeof item === 'string');
  const result: NodeCapability[] = [];
  if (capacity?.packageCache) result.push('regional-cache');
  return result;
}
