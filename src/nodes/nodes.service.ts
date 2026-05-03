import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { MemoryStore } from '../storage/memory.store';
import { BackendNode } from '../types';
import { VaultPkiService } from '../vault/vault-pki.service';

const NODE_ONLINE_TTL_MS = Number(process.env.NODE_ONLINE_TTL_MS ?? 2 * 60_000);
/** Enrollment tokens are valid for 24 hours from creation. */
const ENROLLMENT_TOKEN_TTL_MS = 24 * 60 * 60_000;

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly vaultPki: VaultPkiService,
  ) {}

  async createEnrollment(name: string, publicUrl: string, region?: string, site?: string, actor = 'system') {
    const token = `node_${uuid().replaceAll('-', '')}`;
    const now = new Date().toISOString();
    const node: BackendNode = {
      id: uuid(),
      name,
      publicUrl,
      region,
      site,
      status: 'pending',
      enrollmentTokenHash: await bcrypt.hash(token, 12),
      enrollmentTokenCreatedAt: now,
    };
    this.store.backendNodes.push(node);
    await this.store.persist();
    this.audit.record(actor, 'node.enrollment_created', node.id, { name, publicUrl, region, site });
    this.logger.log(`Enrollment created: nodeId=${node.id} name=${name} publicUrl=${publicUrl}`);

    return {
      nodeId: node.id,
      enrollmentToken: token,
      managementUrl: process.env.PUBLIC_URL ?? process.env.MANAGEMENT_URL ?? '',
      nodePublicUrl: publicUrl,
      dragonflyUrl: '',
    };
  }

  async register(nodeId: string, enrollmentToken: string, version: string, capacity?: Record<string, unknown>) {
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
    node.version = version;
    node.capacity = capacity ?? node.capacity;
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
    this.audit.record(node.id, 'node.registered', node.id, { version, capacity, tlsSerial: issuedCert?.serial });
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

  heartbeat(nodeId: string, capacity?: Record<string, unknown>) {
    const node = this.store.backendNodes.find((n) => n.id === nodeId);
    if (!node) {
      this.logger.warn(`Heartbeat from unknown nodeId=${nodeId}`);
      throw new BadRequestException('Unknown node');
    }
    node.status = 'online';
    const now = new Date().toISOString();
    node.firstSeenAt = node.firstSeenAt ?? now;
    node.lastSeenAt = now;
    node.capacity = capacity ?? node.capacity;
    void this.store.persist();
    this.logger.debug(`Heartbeat from nodeId=${nodeId}`);
    return {
      accepted: true,
      serverTime: new Date().toISOString(),
      certExpiresAt: node.tlsCertExpiresAt,
    };
  }

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

  onlineNodes() {
    return this.store.backendNodes.filter((node) => this.resolveStatus(node) === 'online');
  }

  availableNode(preferredNodeId?: string) {
    if (preferredNodeId) {
      const node = this.store.backendNodes.find((candidate) => candidate.id === preferredNodeId);
      return node && this.resolveStatus(node) === 'online' ? node : undefined;
    }
    return this.onlineNodes()[0];
  }

  private async decommissionNode(nodeId: string, publicUrl: string, decommissionToken?: string) {
    if (!decommissionTokenHash) {
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

  private resolveStatus(node: BackendNode): BackendNode['status'] {
    if (node.status === 'pending' && !node.lastSeenAt) return 'pending';
    if (!node.lastSeenAt) return 'offline';
    const seenAt = new Date(node.lastSeenAt).getTime();
    if (!Number.isFinite(seenAt)) return 'offline';
    return Date.now() - seenAt <= NODE_ONLINE_TTL_MS ? 'online' : 'offline';
  }
}
