import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { MemoryStore } from '../storage/memory.store';
import { BackendNode } from '../types';
import { VaultPkiService } from '../vault/vault-pki.service';

const NODE_ONLINE_TTL_MS = Number(process.env.NODE_ONLINE_TTL_MS ?? 2 * 60_000);

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly vaultPki: VaultPkiService,
  ) {}

  async createEnrollment(name: string, publicUrl: string, region?: string, site?: string) {
    const token = `node_${uuid().replaceAll('-', '')}`;
    const node = {
      id: uuid(),
      name,
      publicUrl,
      region,
      site,
      status: 'pending' as const,
      enrollmentTokenHash: await bcrypt.hash(token, 12),
    };
    this.store.backendNodes.push(node);
    await this.store.persist();
    this.audit.record('system', 'node.enrollment_created', node.id, { name, publicUrl, region, site });
    this.logger.log(`Enrollment created: nodeId=${node.id} name=${name} publicUrl=${publicUrl}`);

    const nodeApiSecret = process.env.NODE_API_SECRET;
    if (!nodeApiSecret) {
      this.logger.warn('NODE_API_SECRET is not set — enrollment JSON will not include it.');
    }

    return {
      nodeId: node.id,
      enrollmentToken: token,
      managementUrl: process.env.PUBLIC_URL ?? process.env.MANAGEMENT_URL ?? '',
      nodePublicUrl: publicUrl,
      dragonflyUrl: '',
      nodeApiSecret: nodeApiSecret ?? '',
    };
  }

  async register(nodeId: string, enrollmentToken: string, version: string, capacity?: Record<string, unknown>) {
    const node = this.store.backendNodes.find((n) => n.id === nodeId);
    if (!node) {
      this.logger.warn(`Registration rejected — unknown nodeId=${nodeId}`);
      throw new BadRequestException('Unknown node');
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

    // Issue (or re-issue) a Vault mTLS certificate for this node.
    // The cert + key are returned to the node in this response — they are never stored
    // server-side. The node persists them locally and uses them for all future connections.
    let issuedCert: { certificate: string; privateKey: string; caCert: string; serial: string } | undefined;
    try {
      if (node.tlsCertSerial) {
        await this.vaultPki.revokeCert(node.tlsCertSerial);
      }
      issuedCert = await this.vaultPki.issueCert(nodeId);
      node.tlsCertSerial = issuedCert.serial;
      this.logger.log(`mTLS cert issued for nodeId=${nodeId} serial=${issuedCert.serial}`);
    } catch (err) {
      this.logger.error(
        `Vault cert issuance failed for nodeId=${nodeId}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Node will use shared-secret auth only until Vault recovers.`,
      );
    }

    if (node.enrollmentTokenUsedAt) {
      await this.store.persist();
      this.logger.debug(`Repeat registration accepted for existing nodeId=${nodeId}`);
      return { nodeId: node.id, accepted: true, alreadyRegistered: true, tls: issuedCert ?? null };
    }

    node.enrollmentTokenUsedAt = now;
    await this.store.persist();
    this.audit.record(node.id, 'node.registered', node.id, { version, capacity, tlsSerial: issuedCert?.serial });
    this.logger.log(`Node registered: nodeId=${nodeId} name=${node.name} version=${version}`);
    return { nodeId: node.id, accepted: true, tls: issuedCert ?? null };
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
    return { accepted: true, serverTime: new Date().toISOString() };
  }

  listNodes() {
    let changed = false;
    const nodes = this.store.backendNodes.map((node) => {
      const status = this.resolveStatus(node);
      if (node.status !== status) { node.status = status; changed = true; }
      return { ...node, status };
    });
    if (changed) void this.store.persist();
    return nodes;
  }

  async removeNode(nodeId: string) {
    const index = this.store.backendNodes.findIndex((n) => n.id === nodeId);
    if (index === -1) throw new BadRequestException('Unknown node');
    const node = this.store.backendNodes[index];
    this.logger.log(`Removing node ${node.name} (${node.id})`);

    // Revoke the mTLS cert immediately — node stops working within one CRL cycle (~10 min)
    if (node.tlsCertSerial) {
      try {
        await this.vaultPki.revokeCert(node.tlsCertSerial);
        this.logger.log(`mTLS cert revoked for decommissioned nodeId=${nodeId} serial=${node.tlsCertSerial}`);
      } catch (err) {
        this.logger.error(`Failed to revoke cert for nodeId=${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const decommission = await this.decommissionNode(node.id, node.publicUrl);
    if (decommission.cleared) {
      this.logger.log(`Node ${node.name} confirmed local config cleanup`);
    } else {
      this.logger.warn(`Node ${node.name} did not confirm cleanup: ${JSON.stringify(decommission)}`);
    }
    this.store.backendNodes.splice(index, 1);
    await this.store.persist();
    this.audit.record('system', 'node.removed', nodeId, { name: node.name, publicUrl: node.publicUrl, decommission });
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

  private async decommissionNode(nodeId: string, publicUrl: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${publicUrl.replace(/\/$/, '')}/node/decommission`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-node-api-secret': process.env.NODE_API_SECRET ?? '',
        },
        body: JSON.stringify({ nodeId }),
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
